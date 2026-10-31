import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase, type Database, type Row } from '../memory/database.js';
import { MIU_CANON, ROLE_STYLES, DIRECTOR_RULES } from '../character/profile.js';
import { PERSONALITY_PRESETS } from '../character/presets.js';
import { DIARY, EPISODES } from '../memory/authored-life.js';

interface ReviewMessage { id: string; role: string; speaker: string; text: string; timestamp: string }
interface ReviewSession {
  sessionId: string; date: string; title: string; language: string; tags: string[]; childAge: number;
  childMood: { source: string; start: string; end: string }; miuDailyMood: string; messages: ReviewMessage[];
}
interface EvidenceAnchor {
  id?: string; title: string; category: string; scope: string; asOf?: string; summary: string;
  caution?: string; messageIds: string[];
}
interface EvidenceCitation { messageId: string; sessionId: string; date: string; text: string; role: string; speaker: string }

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const templatePath = fileURLToPath(new URL('../review/character-review.html', import.meta.url));
const anchorsPath = fileURLToPath(new URL('../review/evidence-anchors.json', import.meta.url));
const marker = '__REVIEW_DATA__';
const identifier = (name: string): string => `"${name.replace(/"/gu, '""')}"`;
const date = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
const sourcePath = (path: string): string => {
  const value = relative(workspace, path);
  return value && !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value) ? value.split(sep).join('/') : path;
};
const scriptSafeJson = (value: unknown): string => JSON.stringify(value)
  .replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

function evidenceCards(value: unknown, sessions: ReviewSession[]) {
  const raw = Array.isArray(value) ? value : value && typeof value === 'object' && 'cards' in value ? value.cards : null;
  if (!Array.isArray(raw)) throw new Error('Evidence anchors must be an array or an object containing cards.');
  const messages = new Map<string, EvidenceCitation>();
  for (const session of sessions) for (const message of session.messages) {
    messages.set(message.id, { messageId: message.id, sessionId: session.sessionId, date: session.date, text: message.text, role: message.role, speaker: message.speaker });
  }
  return raw.flatMap((value: unknown, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Invalid evidence anchor ${index + 1}.`);
    const anchor = value as EvidenceAnchor;
    if (typeof anchor.title !== 'string' || typeof anchor.summary !== 'string' || !Array.isArray(anchor.messageIds)
      || !anchor.messageIds.length || anchor.messageIds.some(id => typeof id !== 'string')) throw new Error(`Invalid evidence anchor ${index + 1}.`);
    if (!anchor.messageIds.every(id => messages.has(id))) return [];
    return [{ ...anchor, evidence: anchor.messageIds.map(id => messages.get(id)!) }];
  });
}

async function readSnapshot(db: Database, selection: string | undefined) {
  await db.query('BEGIN READ ONLY');
  try {
    const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(row => row.table_name);
    const counts: Record<string, number> = {};
    for (const table of tables) counts[table] = Number((await db.query<{ count: string }>(`SELECT count(*) AS count FROM ${identifier(table)}`)).rows[0]!.count);
    const required = ['historical_datasets', 'historical_profiles', 'historical_sessions', 'historical_messages'];
    if (required.some(table => !tables.includes(table)) || !counts.historical_datasets) {
      throw new Error('No imported historical archive exists in this database. The exporter will not create records or fall back to conversation fixtures.');
    }
    const available = (await db.query('SELECT * FROM historical_datasets ORDER BY from_date,dataset_key')).rows;
    const matching = selection ? available.filter(row => row.id === selection || row.dataset_key === selection) : available;
    if (!matching.length) throw new Error('The selected --dataset does not exist in this database.');
    if (matching.length !== 1) throw new Error('This database contains multiple archives. Select one explicitly with --dataset DATASET_KEY_OR_ID.');
    const dataset = matching[0]!;
    if (dataset.synthetic !== true || dataset.response_origin !== 'authored_reference') throw new Error('The selected archive does not declare the required synthetic authored-reference provenance.');
    const datasetId = dataset.id;
    const profiles = (await db.query('SELECT * FROM historical_profiles WHERE dataset_id=$1 ORDER BY source_profile_id', [datasetId])).rows;
    if (!profiles.length) throw new Error('The selected archive has no historical test-user profile.');
    const runtime: Record<string, Row[]> = {};
    for (const table of ['profiles', 'miu_configs', 'entities', 'facts', 'social_connections', 'events', 'daily_states', 'relationship_states', 'story_checkpoints', 'child_stories', 'followups', 'miu_self_statements', 'promises']) {
      runtime[table] = tables.includes(table) ? (await db.query(`SELECT * FROM ${identifier(table)}`)).rows : [];
    }
    const monthly = (await db.query(`SELECT to_char(s.local_date,'YYYY-MM') AS month,count(*)::int AS sessions,
      sum((SELECT count(*) FROM historical_messages m WHERE m.dataset_id=s.dataset_id AND m.session_id=s.session_id))::int AS messages
      FROM historical_sessions s WHERE s.dataset_id=$1 GROUP BY 1 ORDER BY 1`, [datasetId])).rows;
    const language = (await db.query('SELECT language,count(*)::int AS sessions FROM historical_sessions WHERE dataset_id=$1 GROUP BY language ORDER BY language', [datasetId])).rows;
    const tags = (await db.query('SELECT tag,count(*)::int AS sessions FROM historical_sessions,unnest(tags) tag WHERE dataset_id=$1 GROUP BY tag ORDER BY sessions DESC,tag', [datasetId])).rows;
    const miuMoods = (await db.query('SELECT miu_daily_mood AS mood,count(*)::int AS sessions FROM historical_sessions WHERE dataset_id=$1 GROUP BY miu_daily_mood ORDER BY sessions DESC,mood', [datasetId])).rows;
    const childMoodAnnotations = (await db.query('SELECT child_mood_start AS mood,count(*)::int AS sessions FROM historical_sessions WHERE dataset_id=$1 GROUP BY child_mood_start ORDER BY sessions DESC,mood', [datasetId])).rows;
    const rows = (await db.query(`SELECT s.session_id,s.local_date,s.title,s.tags,s.language,s.child_age_years,
      s.child_mood_source,s.child_mood_start,s.child_mood_end,s.miu_daily_mood,
      json_agg(json_build_object('id',m.message_id,'role',m.role,'speaker',m.speaker,'text',m.content,'timestamp',m.timestamp_source) ORDER BY m.ordinal) AS messages
      FROM historical_sessions s JOIN historical_messages m ON m.dataset_id=s.dataset_id AND m.session_id=s.session_id
      WHERE s.dataset_id=$1 GROUP BY s.dataset_id,s.session_id ORDER BY s.local_date,s.session_id`, [datasetId])).rows;
    const sessions: ReviewSession[] = rows.map(row => ({
      sessionId: String(row.session_id), date: date(row.local_date), title: String(row.title), language: String(row.language),
      tags: row.tags as string[], childAge: Number(row.child_age_years),
      childMood: { source: String(row.child_mood_source), start: String(row.child_mood_start), end: String(row.child_mood_end) },
      miuDailyMood: String(row.miu_daily_mood), messages: row.messages as ReviewMessage[],
    }));
    const messageCount = sessions.reduce((total, session) => total + session.messages.length, 0);
    if (sessions.length !== Number(dataset.expected_sessions) || messageCount !== Number(dataset.expected_messages)) {
      throw new Error('The selected archive is incomplete: session/message counts do not match its stored declaration.');
    }
    return { counts, runtime, archive: { datasets: [dataset], profiles, monthly, language, tags, miuMoods, childMoodAnnotations }, sessions };
  } finally {
    await db.query('ROLLBACK');
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string', default: '.miu-data' }, output: { type: 'string', default: 'reports/character-review.html' },
    dataset: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: npm run review:characters -- [--data-dir .miu-data] [--output reports/character-review.html] [--dataset DATASET_KEY_OR_ID]');
    return;
  }
  const databasePath = resolve(values['data-dir']); const outputPath = resolve(values.output);
  if (outputPath === databasePath || outputPath.startsWith(databasePath + sep) || outputPath === templatePath) throw new Error('The report output must be outside the original database and must not overwrite the review template.');
  if (!(await stat(databasePath)).isDirectory()) throw new Error('--data-dir must point to an existing PGlite database directory.');
  await access(join(databasePath, 'PG_VERSION'));
  const [template, anchors] = await Promise.all([readFile(templatePath, 'utf8'), readFile(anchorsPath, 'utf8')]);
  if (template.split(marker).length !== 2) throw new Error('The character-review template must contain exactly one __REVIEW_DATA__ marker.');
  const temporary = await mkdtemp(join(tmpdir(), 'miu-character-review-'));
  let db: Database | undefined;
  let snapshot: Awaited<ReturnType<typeof readSnapshot>>;
  try {
    const copy = join(temporary, 'database');
    await cp(databasePath, copy, { recursive: true });
    // Opening is confined to the disposable copy. Never call migrate,
    // createMemoryStore or getContext: they can change application state.
    db = await createDatabase({ dataDir: copy });
    snapshot = await readSnapshot(db, values.dataset);
  } finally {
    try { if (db) await db.close(); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const payload = {
    version: 'miu-character-review-v1', generatedAt: new Date().toISOString(),
    source: { databasePath: sourcePath(databasePath), method: 'Read-only SQL transaction against a temporary filesystem copy; no migration, provider request, or application lifecycle operation.' },
    database: { counts: snapshot.counts, runtime: snapshot.runtime, archive: snapshot.archive },
    miu: {
      canon: MIU_CANON, roleStyles: ROLE_STYLES, presets: PERSONALITY_PRESETS, directorRules: DIRECTOR_RULES, diaries: DIARY, episodes: EPISODES,
      sourcePaths: { canon: 'backend/character/profile.ts', roleStyles: 'backend/character/profile.ts', presets: 'backend/character/presets.ts', directorRules: 'backend/character/profile.ts', diaries: 'backend/memory/authored-life.ts', episodes: 'backend/memory/authored-life.ts' },
    },
    sessions: snapshot.sessions, evidenceCards: evidenceCards(JSON.parse(anchors), snapshot.sessions),
  };
  const html = template.replace(marker, () => scriptSafeJson(payload));
  await mkdir(dirname(outputPath), { recursive: true });
  const pending = `${outputPath}.${process.pid}.tmp`;
  try { await writeFile(pending, html, 'utf8'); await rename(pending, outputPath); }
  finally { await rm(pending, { force: true }); }
  console.log(`Created ${sourcePath(outputPath)} from ${sourcePath(databasePath)}: ${payload.sessions.length} sessions, ${payload.sessions.reduce((total, session) => total + session.messages.length, 0)} archived messages, ${payload.evidenceCards.length} evidence cards.`);
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Character review export failed.');
  process.exitCode = 1;
});
