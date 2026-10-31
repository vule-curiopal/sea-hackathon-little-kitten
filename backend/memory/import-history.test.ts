import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, migrate, type Database, type Queryable } from './database.js';
import { importConversationHistory, loadConversationHistory, verifyConversationHistory, type ConversationHistory } from './import-history.js';

const directory = fileURLToPath(new URL('../fixtures/conversations/generated/', import.meta.url));
let db: Database;
let payload: ConversationHistory;
before(async () => { db = await createDatabase(); await migrate(db); payload = await loadConversationHistory(directory); });
after(async () => { await db?.close(); });
const count = async (table: string): Promise<number> => Number((await db.query(`SELECT count(*) count FROM ${table}`)).rows[0]!.count);
type FixtureSource = { manifest: Record<string, unknown>; sessions: Record<string, unknown>[]; messages: Record<string, unknown>[] };
async function changedFixture(change: (source: FixtureSource) => void): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'miu-history-import-'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const sessions = (await readFile(join(directory, 'sessions.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const messages = (await readFile(join(directory, 'messages.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  change({ manifest, sessions, messages });
  await Promise.all([
    writeFile(join(path, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(path, 'sessions.jsonl'), sessions.map((value) => JSON.stringify(value)).join('\n') + '\n'),
    writeFile(join(path, 'messages.jsonl'), messages.map((value) => JSON.stringify(value)).join('\n') + '\n'),
  ]);
  return path;
}

test('loader validates the complete synthetic year and freezes the verified source', () => {
  assert.equal(payload.sessions.length, 365);
  assert.equal(payload.messages.length, 2932);
  assert.equal(payload.manifest.persona.profile_id, 'synthetic-an-001');
  assert.equal(payload.sessions[0]!.started_at, '2025-11-01T16:25:58+07:00');
  assert.equal(payload.sessions.at(-1)!.ended_at, '2026-10-31T19:30:28+07:00');
  assert.match(payload.checksum, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(payload.sessions[0]!.messages));
});

test('archive import stores one profile, 365 sessions and 2932 exact messages without runtime memory', async () => {
  const report = await importConversationHistory(db, payload);
  assert.equal(report.applied, true);
  assert.deepEqual([report.profiles, report.sessions, report.messages], [1, 365, 2932]);
  assert.equal(report.from, '2025-11-01'); assert.equal(report.to, '2026-10-31');
  const repeated = await importConversationHistory(db, payload);
  assert.equal(repeated.applied, false); assert.equal(repeated.datasetId, report.datasetId);
  assert.equal(await count('historical_datasets'), 1);
  assert.equal(await count('profiles'), 0);
  assert.equal(await count('memory_records'), 0);
  assert.equal(await count('turn_learning'), 0);
  assert.equal((await verifyConversationHistory(db, report.datasetId)).checksum, payload.checksum);
  const row = (await db.query('SELECT * FROM historical_messages WHERE dataset_id=$1 AND message_id=$2', [report.datasetId, payload.messages[0]!.id])).rows[0]!;
  assert.equal(row.timestamp_source, payload.messages[0]!.timestamp);
  assert.equal(row.content, payload.messages[0]!.content);
  assert.equal(row.speaker, 'An');
  const roles = await db.query('SELECT role,count(*)::integer count FROM historical_messages GROUP BY role ORDER BY role');
  assert.deepEqual(roles.rows.map((value) => value.count), [1466,1466]);
});

test('preflight rejects disagreeing flat messages, non-synthetic provenance, extra fields and incomplete periods', async () => {
  const cases: ((source: FixtureSource) => void)[] = [
    (source) => { source.messages[0]!.content = 'Unmatched flat content'; },
    (source) => { source.manifest.synthetic = false; },
    (source) => { source.sessions[0]!.unexpected_private_field = 'unsupported'; },
    (source) => { source.sessions.pop(); },
  ];
  for (const change of cases) {
    const path = await changedFixture(change);
    try { await assert.rejects(loadConversationHistory(path)); }
    finally { await rm(path, { recursive: true, force: true }); }
  }
  assert.equal(await count('historical_datasets'), 1);
});

test('changed source with the same dataset key conflicts instead of overwriting imported dialogue', async () => {
  const path = await changedFixture((source) => {
    const nested = (source.sessions[0]!.messages as Record<string, unknown>[])[0]!;
    nested.content = String(nested.content) + ' Bạn ơi.';
    source.messages[0]!.content = nested.content;
  });
  try {
    const changed = await loadConversationHistory(path);
    assert.equal(changed.datasetKey, payload.datasetKey);
    assert.notEqual(changed.checksum, payload.checksum);
    await assert.rejects(importConversationHistory(db, changed), /different source content/);
    assert.equal((await verifyConversationHistory(db, payload)).checksum, payload.checksum);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('idempotent reimport checks existing message contents and counts rather than trusting its receipt', async () => {
  const first = payload.messages[0]!;
  await db.query('UPDATE historical_messages SET content=$2 WHERE message_id=$1', [first.id, first.content + ' altered']);
  try { await assert.rejects(importConversationHistory(db, payload), /checksum/); }
  finally { await db.query('UPDATE historical_messages SET content=$2 WHERE message_id=$1', [first.id, first.content]); }
  const last = (await db.query('DELETE FROM historical_messages WHERE message_id=$1 RETURNING *', [payload.messages.at(-1)!.id])).rows[0]!;
  try { await assert.rejects(importConversationHistory(db, payload), /row counts/); }
  finally {
    await db.query('INSERT INTO historical_messages(dataset_id,message_id,session_id,source_profile_id,ordinal,role,speaker,occurred_at,timestamp_source,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [last.dataset_id,last.message_id,last.session_id,last.source_profile_id,last.ordinal,last.role,last.speaker,last.occurred_at,last.timestamp_source,last.content]);
  }
});

test('archive message foreign keys reject a different profile for the same session', async () => {
  const dataset = await verifyConversationHistory(db, payload);
  await assert.rejects(db.query('UPDATE historical_messages SET source_profile_id=$2 WHERE dataset_id=$1', [dataset.datasetId, 'wrong-source-profile']));
  assert.equal((await verifyConversationHistory(db, payload)).messages, 2932);
});

test('a database failure after session insertion rolls back the entire archive transaction', async () => {
  const isolated = await createDatabase(); await migrate(isolated);
  let attemptedMessageInsert = false;
  const faulting: Database = {
    ...isolated,
    transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return isolated.transaction((tx) => work({
        exec: (sql) => tx.exec(sql),
        async query<R>(sql: string, values?: unknown[]) {
          if (sql.startsWith('INSERT INTO historical_messages')) { attemptedMessageInsert = true; throw new Error('injected_archive_failure'); }
          return tx.query<R>(sql, values);
        },
      }));
    },
  };
  try {
    await assert.rejects(importConversationHistory(faulting, payload), /injected_archive_failure/);
    assert.equal(attemptedMessageInsert, true);
    for (const table of ['historical_datasets','historical_profiles','historical_sessions','historical_messages']) assert.equal(Number((await isolated.query(`SELECT count(*) count FROM ${table}`)).rows[0]!.count), 0);
  } finally { await isolated.close(); }
});
