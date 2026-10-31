import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database, Queryable } from './database.js';

export interface ReferenceMessage {
  id: string; role: 'user' | 'assistant'; speaker: string; timestamp: string; content: string;
}
export interface ReferenceSession {
  schema_version: string; synthetic: true; response_origin: 'authored_reference';
  session_id: string; profile_id: string; local_date: string; timezone: string;
  started_at: string; ended_at: string; child_age_years: number; language: 'vi' | 'en' | 'mixed';
  title: string; tags: string[]; child_mood: { source: 'author_annotation'; start: string; end: string };
  miu_daily_mood: string; messages: ReferenceMessage[];
}
export interface FlatReferenceMessage extends ReferenceMessage {
  schema_version: string; synthetic: true; profile_id: string; session_id: string; local_date: string; language: string;
}
export interface HistoryManifest extends Record<string, unknown> {
  schema_version: string; synthetic: true; response_origin: 'authored_reference';
  period: { start: string; end: string; inclusive: true; days: number; timezone: string };
  persona: { profile_id: string; display_name: string; age_band: string; language_mode: string; fictional: true } & Record<string, unknown>;
  totals: { sessions: number; messages: number; exchanges: number };
}
export interface ConversationHistory {
  datasetKey: string; checksum: string; manifest: HistoryManifest;
  sessions: ReferenceSession[]; messages: FlatReferenceMessage[];
}
export interface HistoryImportReport {
  datasetId: string; datasetKey: string; checksum: string;
  profiles: number; sessions: number; messages: number; from: string; to: string; applied: boolean;
}
interface HistoryHelpers {
  VERSION: string;
  validateHistory(sessions: ReferenceSession[]): boolean;
  flattenMessages(sessions: ReferenceSession[]): FlatReferenceMessage[];
  buildManifest(sessions: ReferenceSession[]): HistoryManifest;
}
const historyModuleUrl = new URL('../fixtures/conversations/history.mjs', import.meta.url).href;
const helpers = async (): Promise<HistoryHelpers> => await import(historyModuleUrl) as HistoryHelpers;
const fail = (message: string): never => { throw new Error(`history_import: ${message}`); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(value: unknown, expected: string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) fail(`invalid ${label} fields`);
}
const SESSION_KEYS = ['schema_version','synthetic','response_origin','session_id','profile_id','local_date','timezone','started_at','ended_at','child_age_years','language','title','tags','child_mood','miu_daily_mood','messages'];
const MESSAGE_KEYS = ['id','role','speaker','timestamp','content'];
function digest(manifest: HistoryManifest, sessions: ReferenceSession[], messages: FlatReferenceMessage[]): string {
  return createHash('sha256').update(canonical({ manifest, sessions, messages })).digest('hex');
}
function datasetKey(manifest: HistoryManifest): string {
  return `${manifest.schema_version}:${manifest.persona.profile_id}:${manifest.period.start}:${manifest.period.end}`;
}
async function validate(manifest: HistoryManifest, sessions: ReferenceSession[], messages: FlatReferenceMessage[]): Promise<ConversationHistory> {
  const h = await helpers();
  if (!manifest || !Array.isArray(sessions) || !Array.isArray(messages)) fail('invalid source roots');
  for (const session of sessions) {
    exactKeys(session, SESSION_KEYS, 'session');
    exactKeys(session.child_mood, ['source','start','end'], 'child mood');
    if (typeof session.title !== 'string' || !session.title.trim() || session.title.length > 300 || session.title !== session.title.normalize('NFC')) fail('invalid session title');
    if (!Array.isArray(session.messages)) fail('missing session messages');
    for (const message of session.messages) {
      exactKeys(message, MESSAGE_KEYS, 'message');
      if (typeof message.content !== 'string' || message.content.length > 6000 || message.content !== message.content.normalize('NFC')) fail('invalid message content');
    }
  }
  h.validateHistory(sessions);
  if (manifest.schema_version !== h.VERSION || manifest.synthetic !== true || manifest.response_origin !== 'authored_reference' || manifest.persona?.fictional !== true) fail('only the declared synthetic reference dataset is supported');
  // Includes exact period/counts, provenance, persona, topic/mood distributions,
  // and all documented limitations; annotations never become runtime observations.
  if (canonical(manifest) !== canonical(h.buildManifest(sessions))) fail('manifest differs from validated sessions');
  if (canonical(messages) !== canonical(h.flattenMessages(sessions))) fail('flat messages differ from session messages');
  return { datasetKey: datasetKey(manifest), checksum: digest(manifest, sessions, messages), manifest, sessions, messages };
}
async function jsonLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8');
  const lines = text.trimEnd().split('\n');
  if (!text.trim() || lines.some((line) => !line.trim())) fail(`empty row in ${path}`);
  return lines.map((line, index) => { try { return JSON.parse(line) as unknown; } catch { return fail(`invalid JSON at ${path}:${index + 1}`); } });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const field of Object.values(value)) freeze(field); Object.freeze(value); }
  return value;
}
export async function loadConversationHistory(directory: string): Promise<ConversationHistory> {
  const [manifestText, sessions, messages] = await Promise.all([
    readFile(join(directory, 'manifest.json'), 'utf8'), jsonLines(join(directory, 'sessions.jsonl')), jsonLines(join(directory, 'messages.jsonl')),
  ]);
  let manifest: HistoryManifest;
  try { manifest = JSON.parse(manifestText) as HistoryManifest; } catch { return fail('invalid manifest JSON'); }
  return freeze(await validate(manifest, sessions as ReferenceSession[], messages as FlatReferenceMessage[]));
}
const text = (value: unknown): string => String(value);
const date = (value: unknown): string => (value instanceof Date ? value.toISOString() : text(value)).slice(0, 10);
const millis = (value: unknown): number => value instanceof Date ? value.getTime() : Date.parse(text(value));
async function verify(tx: Queryable, datasetId: string, expected?: ConversationHistory): Promise<HistoryImportReport> {
  const dataset = (await tx.query('SELECT * FROM historical_datasets WHERE id=$1', [datasetId])).rows[0] ?? fail('dataset not found');
  const manifest = dataset.manifest as HistoryManifest;
  // A transaction uses one PostgreSQL connection. Await each read to avoid
  // concurrently executing client.query(), which pg 9 will no longer support.
  const profiles = await tx.query('SELECT * FROM historical_profiles WHERE dataset_id=$1 ORDER BY source_profile_id', [datasetId]);
  const storedSessions = await tx.query('SELECT * FROM historical_sessions WHERE dataset_id=$1 ORDER BY local_date,session_id', [datasetId]);
  const storedMessages = await tx.query('SELECT * FROM historical_messages WHERE dataset_id=$1 ORDER BY session_id,ordinal', [datasetId]);
  if (profiles.rows.length !== Number(dataset.expected_profiles) || storedSessions.rows.length !== Number(dataset.expected_sessions) || storedMessages.rows.length !== Number(dataset.expected_messages)) fail('stored row counts do not match dataset receipt');
  const profile = profiles.rows[0] ?? fail('missing historical profile');
  if (text(profile.source_profile_id) !== manifest.persona.profile_id || text(profile.display_name) !== manifest.persona.display_name || text(profile.age_band) !== manifest.persona.age_band || text(profile.language_mode) !== manifest.persona.language_mode || text(profile.timezone) !== manifest.period.timezone || canonical(profile.persona) !== canonical(manifest.persona)) fail('historical profile differs from manifest');
  const bySession = new Map<string, ReferenceMessage[]>();
  for (const row of storedMessages.rows) {
    if (millis(row.occurred_at) !== Date.parse(text(row.timestamp_source))) fail('message timestamp columns disagree');
    const sessionMessages = bySession.get(text(row.session_id)) ?? [];
    if (Number(row.ordinal) !== sessionMessages.length + 1) fail('message ordinals are not contiguous');
    sessionMessages.push({ id: text(row.message_id), role: row.role as ReferenceMessage['role'], speaker: text(row.speaker), timestamp: text(row.timestamp_source), content: text(row.content) });
    bySession.set(text(row.session_id), sessionMessages);
  }
  const sessions: ReferenceSession[] = storedSessions.rows.map((row) => {
    if (millis(row.started_at) !== Date.parse(text(row.started_at_source)) || millis(row.ended_at) !== Date.parse(text(row.ended_at_source))) fail('session timestamp columns disagree');
    return {
      schema_version: text(dataset.schema_version), synthetic: true, response_origin: row.response_origin as 'authored_reference',
      session_id: text(row.session_id), profile_id: text(row.source_profile_id), local_date: date(row.local_date), timezone: text(profile.timezone),
      started_at: text(row.started_at_source), ended_at: text(row.ended_at_source), child_age_years: Number(row.child_age_years),
      language: row.language as ReferenceSession['language'], title: text(row.title), tags: row.tags as string[],
      child_mood: { source: row.child_mood_source as 'author_annotation', start: text(row.child_mood_start), end: text(row.child_mood_end) },
      miu_daily_mood: text(row.miu_daily_mood), messages: bySession.get(text(row.session_id)) ?? [],
    };
  });
  const reconstructed = await validate(manifest, sessions, (await helpers()).flattenMessages(sessions));
  if (dataset.synthetic !== true || dataset.response_origin !== 'authored_reference' || reconstructed.datasetKey !== dataset.dataset_key || reconstructed.checksum !== dataset.content_checksum || date(dataset.from_date) !== manifest.period.start || date(dataset.to_date) !== manifest.period.end || dataset.timezone !== manifest.period.timezone) fail('stored dataset checksum or metadata mismatch');
  if (expected && (expected.datasetKey !== reconstructed.datasetKey || expected.checksum !== reconstructed.checksum)) fail('stored dataset differs from import source');
  return { datasetId, datasetKey: reconstructed.datasetKey, checksum: reconstructed.checksum, profiles: profiles.rows.length, sessions: sessions.length, messages: storedMessages.rows.length, from: manifest.period.start, to: manifest.period.end, applied: false };
}
export async function verifyConversationHistory(db: Database, source: ConversationHistory | string): Promise<HistoryImportReport> {
  return db.transaction(async (tx) => {
    const dataset = typeof source === 'string'
      ? (await tx.query('SELECT id FROM historical_datasets WHERE id=$1 FOR UPDATE', [source])).rows[0]
      : (await tx.query('SELECT id FROM historical_datasets WHERE dataset_key=$1 FOR UPDATE', [source.datasetKey])).rows[0];
    const datasetId = dataset ? text(dataset.id) : fail('dataset not found');
    return verify(tx, datasetId, typeof source === 'string' ? undefined : source);
  });
}
async function insertBatches(tx: Queryable, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  // All identifiers below are code-authored constants; only values originate in
  // fixtures. Bound batches stay far below PostgreSQL's parameter-count limit.
  for (let offset = 0; offset < rows.length; offset += 100) {
    const values: unknown[] = [];
    const groups = rows.slice(offset, offset + 100).map((row) => `(${row.map((value) => { values.push(value); return `$${values.length}`; }).join(',')})`);
    await tx.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${groups.join(',')}`, values);
  }
}
export async function importConversationHistory(db: Database, input: ConversationHistory): Promise<HistoryImportReport> {
  // Defensive snapshot prevents callers mutating preflighted arrays while SQL is
  // awaiting I/O. All validation completes before the first archive write.
  const copy = JSON.parse(JSON.stringify(input)) as ConversationHistory;
  const payload = await validate(copy.manifest, copy.sessions, copy.messages);
  if (copy.datasetKey !== payload.datasetKey || copy.checksum !== payload.checksum) fail('payload checksum or dataset key mismatch');
  return db.transaction(async (tx) => {
    const { manifest } = payload;
    const id = randomUUID();
    const inserted = await tx.query(`INSERT INTO historical_datasets(id,dataset_key,schema_version,content_checksum,from_date,to_date,timezone,expected_profiles,expected_sessions,expected_messages,manifest)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10) ON CONFLICT(dataset_key) DO NOTHING RETURNING id`,
    [id, payload.datasetKey, manifest.schema_version, payload.checksum, manifest.period.start, manifest.period.end, manifest.period.timezone, manifest.totals.sessions, manifest.totals.messages, JSON.stringify(manifest)]);
    if (!inserted.rows.length) {
      const previous = (await tx.query('SELECT * FROM historical_datasets WHERE dataset_key=$1 FOR UPDATE', [payload.datasetKey])).rows[0]!;
      if (previous.content_checksum !== payload.checksum) fail('dataset key already contains different source content');
      return verify(tx, text(previous.id), payload);
    }
    const persona = manifest.persona;
    await tx.query('INSERT INTO historical_profiles(dataset_id,source_profile_id,display_name,age_band,language_mode,timezone,persona) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, persona.profile_id, persona.display_name, persona.age_band, persona.language_mode, manifest.period.timezone, JSON.stringify(persona)]);
    await insertBatches(tx, 'historical_sessions', ['dataset_id','session_id','source_profile_id','local_date','started_at','ended_at','started_at_source','ended_at_source','language','title','tags','child_age_years','child_mood_source','child_mood_start','child_mood_end','miu_daily_mood'],
      payload.sessions.map((session) => [id, session.session_id, session.profile_id, session.local_date, session.started_at, session.ended_at, session.started_at, session.ended_at, session.language, session.title, session.tags, session.child_age_years, session.child_mood.source, session.child_mood.start, session.child_mood.end, session.miu_daily_mood]));
    await insertBatches(tx, 'historical_messages', ['dataset_id','message_id','session_id','source_profile_id','ordinal','role','speaker','occurred_at','timestamp_source','content'],
      payload.sessions.flatMap((session) => session.messages.map((message, index) => [id, message.id, session.session_id, session.profile_id, index + 1, message.role, message.speaker, message.timestamp, message.timestamp, message.content])));
    return { ...await verify(tx, id, payload), applied: true };
  });
}
