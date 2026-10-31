/** Offline CLI/storage mechanics only. Manual database fixtures establish no
 * character, memory, or embedding quality; no provider is constructed or used. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../memory/index.js';
import type { MemoryStore } from '../memory/index.js';
import { indexVectorMemory } from './index-vector-memory.js';

const SEED_TIME = '2025-10-31T03:00:00.000Z';
const ONE_YEAR_LATER = '2026-10-31T03:00:00.000Z';
const script = fileURLToPath(new URL('./index-vector-memory.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'miu-vector-cli-mechanics-'));
  const directory = join(root, 'postgres');
  const memory = await createMemoryStore({ dataDir: directory, now: () => new Date(SEED_TIME), clockMode: 'demo' });
  const profiles: Record<'an' | 'binh', { profileId: string; sourceId: string }> = {} as Record<'an' | 'binh', { profileId: string; sourceId: string }>;
  try {
    for (const [key, name, value] of [['an', 'Fixture An', 'drawing'], ['binh', 'Fixture Binh', 'reading']] as const) {
      const profile = await memory.createProfile({ demoKey: key, displayName: name, ageBand: '6-8', languageMode: 'en', timezone: 'Asia/Ho_Chi_Minh' });
      const sourceId = randomUUID();
      // Deliberate SQL fixture insertion; no heard conversation or classifier
      // result is being simulated or counted as successful behavior.
      await memory.db.transaction(async tx => {
        await tx.query(`INSERT INTO memory_records(id,profile_id,kind,source_turn_id,candidate_key,evidence_kind,scope,
          created_at,expires_at,learned_local_date,last_reconfirmed_local_date)
          VALUES($1,$2,'preference',$3,'manual_fixture','child_reported','reported_real',$4,NULL,'2025-10-31','2025-10-31')`,
        [sourceId, profile.id, 'mechanical-cli-fixture:' + key, SEED_TIME]);
        await tx.query('INSERT INTO facts(profile_id,id,category,value,normalized_value) VALUES($1,$2,$3,$4,$4)', [profile.id, sourceId, 'hobby', value]);
      });
      profiles[key] = { profileId: profile.id, sourceId };
    }
  } finally { await memory.close(); }
  // Intentionally malformed URL fails parsing before opening any socket if the
  // explicit local-directory override ever regresses. No real env is inherited.
  const env = { PATH: process.env.PATH, DATABASE_URL: 'postgresql://[invalid', DATABASE_SSH_TUNNEL: 'false',
    MEMORY_VECTOR_BACKEND: 'array_exact', OPENAI_EMBEDDING_DIMENSIONS: '3', MIU_PROVIDER: 'real' };
  const open = () => createMemoryStore({ dataDir: directory, now: () => new Date(ONE_YEAR_LATER), clockMode: 'demo' });
  const counts = async (store: MemoryStore, profileId: string) => ({
    documents: Number((await store.db.query('SELECT count(*)::int n FROM memory_search_documents WHERE profile_id=$1', [profileId])).rows[0]!.n),
    jobs: Number((await store.db.query('SELECT count(*)::int n FROM embedding_jobs WHERE profile_id=$1', [profileId])).rows[0]!.n),
    vectors: Number((await store.db.query('SELECT count(*)::int n FROM memory_embeddings WHERE profile_id=$1', [profileId])).rows[0]!.n),
  });
  const cli = (profile: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, reject) => {
    // The temporary cwd contains no .env. Omit --env-file because tsx/Node can
    // intercept that runtime flag before the script's own option parser runs.
    execFile(process.execPath, ['--import', loader, script, '--data-dir', directory, '--profile', profile],
      { cwd: root, env, timeout: 15_000, maxBuffer: 256_000 }, (error, stdout, stderr) => {
      if (error && (!('code' in error) || typeof error.code !== 'number')) { reject(error); return; }
      resolveRun({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
  return { root, directory, profiles, env, open, counts, cli, close: () => rm(root, { recursive: true, force: true }) };
}

test('mechanical enqueue-only CLI selects one profile, overrides inherited URL, and preserves durable dates', async () => {
  const f = await fixture();
  try {
    const response = await f.cli('an');
    assert.equal(response.code, 0, response.stderr);
    const result = JSON.parse(response.stdout) as { mode: string; profiles: number; actualEmbeddingRequests: number;
      indexing: { upserted: number; enqueued: number }; jobs: Record<string, number>; generation: { backend: string }; syntheticArchiveIndexed: boolean };
    assert.equal(result.mode, 'enqueue_only'); assert.equal(result.profiles, 1);
    assert.equal(result.actualEmbeddingRequests, 0); assert.equal(result.generation.backend, 'array_exact');
    assert.equal(result.indexing.upserted, 1); assert.equal(result.indexing.enqueued, 1); assert.equal(result.jobs.pending, 1);
    assert.equal(result.syntheticArchiveIndexed, false);
    let memory = await f.open();
    try {
      assert.deepEqual(await f.counts(memory, f.profiles.an.profileId), { documents: 1, jobs: 1, vectors: 0 });
      assert.deepEqual(await f.counts(memory, f.profiles.binh.profileId), { documents: 0, jobs: 0, vectors: 0 });
      for (const profile of Object.values(f.profiles)) {
        const context = await memory.getContext(profile.profileId);
        assert.ok(context.preferences.some(preference => preference.id === profile.sourceId && preference.expiresAt === null));
        const source = (await memory.db.query('SELECT expires_at,learned_local_date,last_reconfirmed_local_date FROM memory_records WHERE profile_id=$1 AND id=$2', [profile.profileId, profile.sourceId])).rows[0]!;
        assert.equal(source.expires_at, null); assert.equal(source.learned_local_date, '2025-10-31');
        assert.equal(source.last_reconfirmed_local_date, '2025-10-31');
      }
      assert.equal((await memory.db.query("SELECT count(*)::int n FROM pg_extension WHERE extname='vector'")).rows[0]!.n, 0);
    } finally { await memory.close(); }
    const retry = await f.cli('an'); assert.equal(retry.code, 0, retry.stderr);
    const retried = JSON.parse(retry.stdout) as { indexing: { upserted: number; enqueued: number }; actualEmbeddingRequests: number };
    assert.equal(retried.indexing.upserted, 0); assert.equal(retried.indexing.enqueued, 0); assert.equal(retried.actualEmbeddingRequests, 0);
    memory = await f.open();
    try {
      assert.deepEqual(await f.counts(memory, f.profiles.an.profileId), { documents: 1, jobs: 1, vectors: 0 });
      assert.deepEqual(await f.counts(memory, f.profiles.binh.profileId), { documents: 0, jobs: 0, vectors: 0 });
    } finally { await memory.close(); }
  } finally { await f.close(); }
});

test('mechanical exported enqueue-only path has no credential requirement and missing profile is explicit', async () => {
  const f = await fixture();
  try {
    const result = await indexVectorMemory({ env: f.env, dataDir: f.directory, profile: 'binh', run: false });
    assert.equal(result.mode, 'enqueue_only'); assert.equal(result.actualEmbeddingRequests, 0);
    assert.deepEqual(result.worker, { processed: 0, committed: 0, discarded: 0, failed: 0 });
    const response = await f.cli('not-a-profile');
    assert.equal(response.code, 1); assert.deepEqual(JSON.parse(response.stderr), { error: { code: 'profile_not_found' } });
    const memory = await f.open();
    try {
      assert.deepEqual(await f.counts(memory, f.profiles.an.profileId), { documents: 0, jobs: 0, vectors: 0 });
      assert.deepEqual(await f.counts(memory, f.profiles.binh.profileId), { documents: 1, jobs: 1, vectors: 0 });
      assert.equal((await memory.db.query('SELECT count(*)::int n FROM profiles')).rows[0]!.n, 2);
    } finally { await memory.close(); }
  } finally { await f.close(); }
});
