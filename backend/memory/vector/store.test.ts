/** SQL/queue/math mechanics only. Synthetic coordinates are not embedding or
 * character-quality evidence; these checks make zero provider requests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '../database.js';
import { MemoryStore } from '../index.js';
import { ensureVectorCapability } from './capability.js';
import { projectCanonicalProfile } from './projections.js';
import { VECTOR_NORMALIZER_VERSION, VECTOR_PROJECTION_VERSION } from './types.js';
import { claimEmbeddingJobs, commitEmbedding, denseCandidates, ensureGeneration, failEmbedding,
  lexicalCandidates, readClaimedEmbeddingJob, synchronizeDocuments } from './store.js';

const INITIAL = '2026-10-31T03:00:00.000Z';
async function fixture(native = false) {
  const db = await createDatabase({ vectorExtension: native });
  await migrate(db);
  const memory = new MemoryStore(db, () => new Date(INITIAL), 'demo');
  const a = await memory.createProfile({ demoKey: 'vector-a', displayName: 'Fixture A', ageBand: '6-8', languageMode: 'en', timezone: 'Asia/Ho_Chi_Minh' });
  const b = await memory.createProfile({ demoKey: 'vector-b', displayName: 'Fixture B', ageBand: '6-8', languageMode: 'en', timezone: 'Asia/Ho_Chi_Minh' });
  await ensureVectorCapability(db, { backend: native ? 'pgvector' : 'array_exact', install: native });
  const config = { model: 'mechanical-vector-fixture', dimensions: 3, projectionVersion: VECTOR_PROJECTION_VERSION,
    normalizerVersion: VECTOR_NORMALIZER_VERSION, distance: 'cosine' as const, backend: native ? 'pgvector' as const : 'array_exact' as const };
  const generation = await ensureGeneration(db, config, INITIAL);
  const learn = async (profileId: string, value: 'drawing' | 'reading' = 'drawing') => {
    const context = await memory.getContext(profileId); const source = `My hobby is ${value}`;
    await memory.learn({ profileId, turnId: randomUUID(), deletionEpoch: context.profile.deletionEpoch, localDate: context.clock.localDate,
      sourceText: source, candidates: [{ kind: 'preference', category: 'hobby', value, evidence: source }] });
  };
  const puddle = async () => {
    const context = await memory.getContext(a.id); const source = 'My dog Mochi fell in a puddle';
    await memory.learn({ profileId: a.id, turnId: randomUUID(), deletionEpoch: context.profile.deletionEpoch, localDate: context.clock.localDate,
      sourceText: source, candidates: [{ kind: 'entity', entityKind: 'pet', name: 'Mochi', species: 'dog', evidence: source },
        { kind: 'event', subjectName: 'Mochi', eventType: 'fell_in_puddle', value: 'fell in a puddle', evidence: source }] });
  };
  const sync = async (profileId = a.id, extra: { retryDead?: boolean } = {}) => db.transaction(async tx => {
    await tx.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [profileId]);
    return synchronizeDocuments(tx, { profileId, generationId: generation.id, documents: await projectCanonicalProfile(tx, profileId), realNow: INITIAL, replace: true, ...extra });
  });
  const claim = (now = INITIAL, leaseMs = 30_000) => claimEmbeddingJobs(db, { workerId: 'mechanical-fixture', generationId: generation.id, limit: 8, now, leaseMs });
  return { db, memory, a, b, generation, config, learn, puddle, sync, claim, close: () => memory.close() };
}

test('mechanical selected-profile drain never leases another profile job', async () => {
  const f = await fixture();
  try {
    await f.learn(f.a.id); await f.learn(f.b.id); await f.sync(); await f.sync(f.b.id);
    const claimed = await claimEmbeddingJobs(f.db, { workerId: 'selected-profile-fixture',
      generationId: f.generation.id, profileId: f.a.id, limit: 8, now: INITIAL });
    assert.equal(claimed.length, 1); assert.equal(claimed[0]!.profileId, f.a.id);
    const other = (await f.db.query('SELECT status,lease_token FROM embedding_jobs WHERE profile_id=$1', [f.b.id])).rows;
    assert.deepEqual(other, [{ status: 'pending', lease_token: null }]);
  } finally { await f.close(); }
});

for (const native of [false, true]) test(`mechanical ${native ? 'bundled pgvector' : 'explicit array'} profile search and idempotence`, async () => {
  const f = await fixture(native);
  try {
    await f.learn(f.a.id); await f.puddle(); await f.learn(f.b.id);
    assert.deepEqual(await f.sync(), { upserted: 2, enqueued: 2, removed: 0 });
    await f.sync(f.b.id);
    const jobs = await f.claim(); assert.equal(jobs.length, 3);
    for (const job of jobs) {
      assert.ok(job.text.length > 0); assert.ok(await readClaimedEmbeddingJob(f.db, { jobId: job.jobId, leaseToken: job.leaseToken, now: INITIAL }));
      const coordinates = job.text.includes('drawing') ? [1, 0, 0] : [0, 1, 0];
      const input = { jobId: job.jobId, leaseToken: job.leaseToken, vector: coordinates, now: INITIAL, model: job.model, dimensions: job.dimensions, generationId: job.generationId };
      assert.deepEqual(await commitEmbedding(f.db, input), { applied: true, status: 'committed' });
      assert.deepEqual(await commitEmbedding(f.db, input), { applied: false, status: 'already_done' });
      await assert.rejects(commitEmbedding(f.db, { ...input, vector: [0, 0, 1] }), error => (error as { code?: string }).code === 'idempotency_conflict');
    }
    assert.deepEqual(await f.sync(), { upserted: 0, enqueued: 0, removed: 0 });
    const dense = await denseCandidates(f.db, { profileId: f.a.id, generationId: f.generation.id, vector: [1, 0, 0], now: INITIAL });
    assert.equal(dense.length, 2); assert.equal(dense[0]!.score, 1); assert.ok(dense.every(hit => hit.profileId === f.a.id));
    const lexical = await lexicalCandidates(f.db, { profileId: f.a.id, generationId: f.generation.id, query: 'drawing' });
    assert.equal(lexical.length, 1); assert.equal(lexical[0]!.sourceId, dense[0]!.sourceId);
    // Reconfirmation is an age-anchor change, not embedding content mutation.
    const before = (await f.db.query('SELECT content_revision FROM memory_records WHERE id=$1', [dense[0]!.sourceId])).rows[0];
    await f.db.query("UPDATE memory_records SET last_reconfirmed_local_date='2026-11-01' WHERE id=$1", [dense[0]!.sourceId]);
    assert.deepEqual((await f.db.query('SELECT content_revision FROM memory_records WHERE id=$1', [dense[0]!.sourceId])).rows[0], before);
    assert.equal((await denseCandidates(f.db, { profileId: f.a.id, generationId: f.generation.id, vector: [1, 0, 0] })).length, 2);
    // Deleting another fact increments the profile epoch without hiding a
    // surviving event vector. Existing vectors have source-specific guards.
    const context = await f.memory.getContext(f.a.id);
    await f.memory.forget(f.a.id, lexical[0]!.sourceId, context.profile.deletionEpoch);
    const surviving = await denseCandidates(f.db, { profileId: f.a.id, generationId: f.generation.id, vector: [0, 1, 0] });
    assert.equal(surviving.length, 1); assert.equal(surviving[0]!.kind, 'event');
    // A dependency change invalidates its copied name in every derived space.
    await f.db.query("UPDATE entities SET name='Moki',normalized_name='moki' WHERE profile_id=$1", [f.a.id]);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM memory_search_documents WHERE profile_id=$1', [f.a.id])).rows[0]!.n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM memory_embeddings WHERE profile_id=$1', [f.a.id])).rows[0]!.n, 0);
    await f.sync(); assert.equal((await f.claim()).length, 1);
    const latest = await f.memory.getContext(f.a.id);
    await f.memory.forget(f.a.id, 'all', latest.profile.deletionEpoch);
    for (const table of ['memory_search_documents', 'memory_search_document_dependencies', 'memory_embeddings', 'embedding_jobs'])
      assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${table} WHERE profile_id=$1`, [f.a.id])).rows[0]!.n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM memory_embeddings WHERE profile_id=$1', [f.b.id])).rows[0]!.n, 1);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM pg_extension WHERE extname='vector'")).rows[0]!.n, native ? 1 : 0);
  } finally { await f.close(); }
});

test('mechanical worker leases, source deletion, epoch fences, retry and exact guards', async () => {
  const f = await fixture();
  try {
    await f.learn(f.a.id); await f.learn(f.a.id, 'reading'); await f.sync();
    const first = await f.claim(INITIAL, 100); assert.equal(first.length, 2);
    const later = '2026-10-31T03:00:00.200Z'; const second = await f.claim(later, 30_000); assert.equal(second.length, 2);
    const stale = first[0]!; const current = second.find(job => job.jobId === stale.jobId)!;
    assert.notEqual(current.leaseToken, stale.leaseToken);
    assert.equal((await commitEmbedding(f.db, { jobId: stale.jobId, leaseToken: stale.leaseToken, vector: [1, 0, 0], now: later })).status, 'stale_lease');
    await assert.rejects(commitEmbedding(f.db, { jobId: current.jobId, leaseToken: current.leaseToken, vector: [1, 0], now: later }));
    await assert.rejects(commitEmbedding(f.db, { jobId: current.jobId, leaseToken: current.leaseToken, vector: [0, 0, 0], now: later }));
    await assert.rejects(commitEmbedding(f.db, { jobId: current.jobId, leaseToken: current.leaseToken, vector: [NaN, 0, 1], now: later }));
    await assert.rejects(commitEmbedding(f.db, { jobId: current.jobId, leaseToken: current.leaseToken, vector: [1, 0, 0], model: 'other-model', now: later }));
    const other = second.find(job => job.jobId !== current.jobId)!;
    const context = await f.memory.getContext(f.a.id);
    await f.memory.forget(f.a.id, other.sourceId, context.profile.deletionEpoch);
    assert.equal((await commitEmbedding(f.db, { jobId: other.jobId, leaseToken: other.leaseToken, vector: [1, 0, 0], now: later })).status, 'missing');
    assert.equal((await commitEmbedding(f.db, { jobId: current.jobId, leaseToken: current.leaseToken, vector: [1, 0, 0], now: later })).status, 'stale_epoch');
    const retry = (await f.claim(later))[0]!;
    assert.equal(await readClaimedEmbeddingJob(f.db, { jobId: current.jobId, leaseToken: current.leaseToken, now: later }), null);
    assert.deepEqual(await failEmbedding(f.db, { jobId: retry.jobId, leaseToken: retry.leaseToken, code: 'provider_quota_exceeded', now: later, retryable: false }), { applied: true, status: 'failed' });
    await f.sync(); assert.equal((await f.claim(later)).length, 0);
    await f.sync(f.a.id, { retryDead: true }); const recovered = (await f.claim(later))[0]!;
    assert.ok(recovered); assert.equal(recovered.attempt, 1);
    assert.deepEqual(await failEmbedding(f.db, { jobId: recovered.jobId, leaseToken: recovered.leaseToken, code: 'provider_timeout', now: later }), { applied: true, status: 'pending' });
    assert.equal((await f.claim(later)).length, 0);
    const due = '2026-10-31T03:00:01.200Z'; const afterBackoff = (await f.claim(due))[0]!;
    assert.ok(afterBackoff); assert.equal(afterBackoff.attempt, 2);
    assert.equal((await commitEmbedding(f.db, { jobId: afterBackoff.jobId, leaseToken: afterBackoff.leaseToken, vector: [1, 0, 0], now: due })).status, 'committed');
    const rows = (await f.db.query("SELECT column_name FROM information_schema.columns WHERE table_name='embedding_jobs' AND table_schema=current_schema() ORDER BY ordinal_position")).rows.map(row => row.column_name);
    assert.ok(!rows.includes('text') && !rows.includes('document_text') && !rows.includes('source_text'));
  } finally { await f.close(); }
});

test('mechanical protected source classes and retired generations stay ineligible', async () => {
  const f = await fixture();
  try {
    await f.learn(f.a.id); const original = (await projectCanonicalProfile(f.db, f.a.id))[0]!;
    await f.sync(); const job = (await f.claim())[0]!;
    await f.db.query("UPDATE search_generations SET status='retired' WHERE id=$1", [f.generation.id]);
    assert.equal((await commitEmbedding(f.db, { jobId: job.jobId, leaseToken: job.leaseToken, vector: [1, 0, 0], now: INITIAL })).status, 'retired_generation');
    assert.equal((await denseCandidates(f.db, { profileId: f.a.id, generationId: f.generation.id, vector: [1, 0, 0] })).length, 0);
    await f.db.query("UPDATE search_generations SET status='shadow' WHERE id=$1", [f.generation.id]);
    await f.db.query("UPDATE facts SET category='self_description' WHERE profile_id=$1", [f.a.id]);
    const revision = Number((await f.db.query('SELECT content_revision FROM memory_records WHERE id=$1', [original.sourceId])).rows[0]!.content_revision);
    await assert.rejects(f.db.transaction(tx => synchronizeDocuments(tx, { profileId: f.a.id, generationId: f.generation.id,
      documents: [{ ...original, sourceRevision: revision }], realNow: INITIAL })), error => (error as { code?: string }).code === 'ineligible_vector_source');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM memory_search_documents WHERE profile_id=$1', [f.a.id])).rows[0]!.n, 0);
  } finally { await f.close(); }
});

test('mechanical source revision/hash/profile guards and SQL vector bounds', async () => {
  const f = await fixture();
  try {
    await f.learn(f.a.id); const docs = await projectCanonicalProfile(f.db, f.a.id); const doc = docs[0]!;
    await assert.rejects(f.db.transaction(tx => synchronizeDocuments(tx, { profileId: f.b.id, generationId: f.generation.id, documents: docs, realNow: INITIAL })));
    await assert.rejects(f.db.transaction(tx => synchronizeDocuments(tx, { profileId: f.a.id, generationId: f.generation.id, documents: [{ ...doc, contentHash: 'f'.repeat(64) }], realNow: INITIAL })));
    await f.sync(); const old = (await f.claim())[0]!;
    await f.db.query("UPDATE facts SET value='reading',normalized_value='reading' WHERE profile_id=$1", [f.a.id]);
    assert.equal((await commitEmbedding(f.db, { jobId: old.jobId, leaseToken: old.leaseToken, vector: [1, 0, 0], now: INITIAL })).status, 'missing');
    await assert.rejects(f.db.transaction(tx => synchronizeDocuments(tx, { profileId: f.a.id, generationId: f.generation.id, documents: docs, realNow: INITIAL })));
    await f.sync(); const fresh = (await f.claim())[0]!;
    await commitEmbedding(f.db, { jobId: fresh.jobId, leaseToken: fresh.leaseToken, vector: [1, 0, 0], now: INITIAL });
    for (const values of ['ARRAY[0,0,0]::real[]', "ARRAY['NaN'::real,0,1]", "ARRAY['Infinity'::real,0,1]", 'ARRAY[1,0]::real[]'])
      await assert.rejects(f.db.transaction(tx => tx.exec(`UPDATE memory_embeddings SET coordinates=${values}`)));
    assert.equal((await denseCandidates(f.db, { profileId: f.a.id, generationId: f.generation.id, vector: [1, 0, 0] })).length, 1);
  } finally { await f.close(); }
});
