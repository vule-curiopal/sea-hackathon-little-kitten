import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../shared/types.js';
import type { Database, Queryable, Row } from '../database.js';
import { quoteIdentifier, readVectorCapability, type VectorBackend } from './capability.js';
import { MAX_DOCUMENT_BYTES, MAX_QUERY_BYTES, type VectorDependency, type VectorDocumentCandidate, type VectorSearchHit } from './types.js';
import { projectionContentHash } from './projections.js';
import { lexicalScore } from './ranking.js';

export interface SearchGeneration {
  id: string; model: string; dimensions: number; projectionVersion: string; normalizerVersion: string;
  distance: 'cosine'; backend: VectorBackend; status: 'building' | 'shadow' | 'active' | 'retired';
}
export type SearchGenerationInput = Omit<SearchGeneration, 'id' | 'status'> & { status?: SearchGeneration['status'] };
export interface EmbeddingJob {
  jobId: string; profileId: string; documentId: string; generationId: string;
  model: string; dimensions: number; text: string; sourceId: string; sourceRevision: number; contentHash: string;
  dependencies: VectorDependency[]; deletionEpoch: number; leaseToken: string; leaseExpiresAt: string; attempt: number;
}
export interface StoredSearchDocument extends VectorDocumentCandidate { documentId: string }
export interface EmbeddingCommitResult {
  applied: boolean;
  status: 'committed' | 'already_done' | 'missing' | 'stale_lease' | 'stale_source' | 'stale_epoch' | 'retired_generation';
}

const MAX_SCAN = 2_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const milliseconds = (value: unknown) => value instanceof Date ? value.getTime() : Date.parse(String(value));
const calendarDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
const id = (value: string) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new AppError('invalid_vector_identifier');
  return value.toLowerCase();
};
const digest = (value: string) => { if (!/^[0-9a-f]{64}$/u.test(value)) throw new AppError('invalid_vector_hash'); return value; };
const integer = (value: number, min: number, max: number) => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError('invalid_vector_number'); return value; };
const time = (value: string) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError('invalid_vector_timestamp');
  return new Date(value).toISOString();
};
const label = (value: string, max = 100) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value) || value.length > max) throw new AppError('invalid_vector_configuration'); return value; };
const generationFrom = (row: Row): SearchGeneration => ({ id: String(row.id), model: String(row.model), dimensions: Number(row.dimensions),
  projectionVersion: String(row.projection_version), normalizerVersion: String(row.normalizer_version), distance: 'cosine',
  backend: row.backend as VectorBackend, status: row.status as SearchGeneration['status'] });

export async function getGeneration(tx: Queryable, generationId: string, lock = false): Promise<SearchGeneration> {
  const row = (await tx.query(`SELECT * FROM search_generations WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [digest(generationId)])).rows[0];
  if (!row) throw new AppError('search_generation_not_found', 404);
  return generationFrom(row);
}

export async function ensureGeneration(tx: Queryable, input: SearchGenerationInput, realNow = new Date().toISOString()): Promise<SearchGeneration> {
  const config = { model: label(input.model, 200), dimensions: integer(input.dimensions, 1, 16_000),
    projectionVersion: label(input.projectionVersion), normalizerVersion: label(input.normalizerVersion), distance: input.distance, backend: input.backend };
  if (config.distance !== 'cosine' || !['pgvector', 'array_exact'].includes(config.backend)) throw new AppError('invalid_vector_configuration');
  const status = input.status ?? 'shadow';
  if (!['building', 'shadow', 'active', 'retired'].includes(status)) throw new AppError('invalid_vector_configuration');
  if (config.backend === 'pgvector') await readVectorCapability(tx);
  const generationId = hash(JSON.stringify(config));
  await tx.query(`INSERT INTO search_generations(id,model,dimensions,projection_version,normalizer_version,distance,backend,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
  [generationId, config.model, config.dimensions, config.projectionVersion, config.normalizerVersion, config.distance, config.backend, status, time(realNow)]);
  return getGeneration(tx, generationId);
}

/** Caller validates rebuild coverage before requesting an atomic cutover. */
export async function activateGeneration(tx: Queryable, generationId: string): Promise<void> {
  await tx.query('LOCK TABLE search_generations IN SHARE ROW EXCLUSIVE MODE');
  await getGeneration(tx, generationId);
  await tx.query("UPDATE search_generations SET status='retired' WHERE status='active' AND id<>$1", [generationId]);
  await tx.query("UPDATE search_generations SET status='active' WHERE id=$1", [generationId]);
}

function dependencies(candidate: Pick<VectorDocumentCandidate, 'sourceId' | 'sourceRevision' | 'dependencies'>): VectorDependency[] {
  const values = new Map<string, number>();
  for (const dependency of [{ sourceId: candidate.sourceId, revision: candidate.sourceRevision }, ...candidate.dependencies]) {
    const sourceId = id(dependency.sourceId); const revision = integer(dependency.revision, 1, Number.MAX_SAFE_INTEGER);
    if (values.has(sourceId) && values.get(sourceId) !== revision) throw new AppError('conflicting_vector_dependency');
    values.set(sourceId, revision);
  }
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([sourceId, revision]) => ({ sourceId, revision }));
}

function documentFrom(row: Row, guards: VectorDependency[]): StoredSearchDocument {
  return { documentId: String(row.id), profileId: String(row.profile_id), sourceId: String(row.source_id), sourceRevision: Number(row.source_revision),
    contentHash: String(row.content_hash), projectionKey: String(row.projection_key), projectionVersion: String(row.projection_version), text: String(row.document_text),
    kind: row.kind as VectorDocumentCandidate['kind'], scope: row.scope as VectorDocumentCandidate['scope'], dependencies: guards.filter(guard => guard.sourceId !== String(row.source_id)),
    embeddingEligible: Boolean(row.embedding_eligible), ...(row.learned_local_date ? { learnedLocalDate: calendarDate(row.learned_local_date) } : {}) };
}

function recordValid(row: Row | undefined, revision: number): boolean { return !!row && Number(row.content_revision) === revision; }

const SOURCE_GUARDS = `SELECT r.*,f.slot AS vector_slot,f.category AS vector_category,
  (f.id IS NOT NULL) AS vector_fact_present,(e.id IS NOT NULL) AS vector_event_present,
  (s.id IS NOT NULL) AS vector_story_present,
  EXISTS(SELECT 1 FROM address_preferences a WHERE a.profile_id=r.profile_id AND a.id=r.id) AS vector_address
  FROM memory_records r LEFT JOIN facts f ON f.profile_id=r.profile_id AND f.id=r.id
  LEFT JOIN events e ON e.profile_id=r.profile_id AND e.id=r.id
  LEFT JOIN child_stories s ON s.profile_id=r.profile_id AND s.id=r.id`;

function sourceEligible(row: Row, candidate: Pick<VectorDocumentCandidate, 'kind' | 'scope'>): boolean {
  if (row.vector_address || row.scope !== candidate.scope || !['child_reported', 'reported_plan'].includes(String(row.evidence_kind))) return false;
  if (candidate.kind === 'preference') return row.kind === 'preference' && Boolean(row.vector_fact_present) && row.vector_slot === null && row.vector_category !== 'self_description';
  if (candidate.kind === 'event') return row.kind === 'event' && Boolean(row.vector_event_present);
  return row.kind === 'story' && Boolean(row.vector_story_present);
}

/** Full snapshots opt into replace. Ordinary completed learning is incremental. */
export async function synchronizeDocuments(tx: Queryable, input: {
  profileId: string; generationId: string; documents: readonly VectorDocumentCandidate[]; realNow: string; replace?: boolean; retryDead?: boolean;
}): Promise<{ upserted: number; enqueued: number; removed: number }> {
  const profileId = id(input.profileId); const now = time(input.realNow);
  integer(input.documents.length, 0, MAX_SCAN);
  const generation = await getGeneration(tx, input.generationId);
  if (generation.status === 'retired') throw new AppError('retired_search_generation', 409);
  const profile = (await tx.query('SELECT deletion_epoch FROM profiles WHERE id=$1 FOR UPDATE', [profileId])).rows[0];
  if (!profile) throw new AppError('profile_not_found', 404);
  const candidates: Array<{ candidate: VectorDocumentCandidate; guards: VectorDependency[] }> = [];
  const seen = new Set<string>();
  for (const value of input.documents) {
    if (id(value.profileId) !== profileId || value.projectionVersion !== generation.projectionVersion
      || !['event', 'preference', 'child_story'].includes(value.kind) || !['reported_real', 'fictional'].includes(value.scope)
      || typeof value.text !== 'string' || value.text.length === 0 || Buffer.byteLength(value.text, 'utf8') > 16_384
      || typeof value.embeddingEligible !== 'boolean' || value.embeddingEligible && Buffer.byteLength(value.text, 'utf8') > MAX_DOCUMENT_BYTES
      || value.dependencies.length > 64) throw new AppError('invalid_vector_document');
    const candidate = { ...value, profileId, sourceId: id(value.sourceId), sourceRevision: integer(value.sourceRevision, 1, Number.MAX_SAFE_INTEGER), projectionKey: label(value.projectionKey) };
    digest(candidate.contentHash);
    if (projectionContentHash(candidate.text, candidate.dependencies, candidate.projectionVersion) !== candidate.contentHash) throw new AppError('vector_projection_hash_mismatch');
    const key = candidate.sourceId + ':' + candidate.projectionKey;
    if (seen.has(key)) throw new AppError('duplicate_vector_document');
    seen.add(key);
    candidates.push({ candidate, guards: dependencies(candidate) });
  }
  const sourceIds = [...new Set(candidates.flatMap(value => value.guards.map(guard => guard.sourceId)))].sort();
  const records = sourceIds.length ? (await tx.query(`${SOURCE_GUARDS} WHERE r.profile_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id FOR SHARE OF r`, [profileId, sourceIds])).rows : [];
  const recordMap = new Map(records.map(row => [String(row.id), row]));
  for (const { candidate, guards } of candidates) {
    if (guards.some(guard => !recordValid(recordMap.get(guard.sourceId), guard.revision))) throw new AppError('vector_source_stale', 409);
    if (guards.some(guard => recordMap.get(guard.sourceId)!.vector_address)) throw new AppError('ineligible_vector_source', 409);
    const root = recordMap.get(candidate.sourceId)!;
    if (!sourceEligible(root, candidate)) throw new AppError('ineligible_vector_source', 409);
  }
  const previous = (await tx.query('SELECT * FROM memory_search_documents WHERE profile_id=$1 AND projection_version=$2 FOR UPDATE', [profileId, generation.projectionVersion])).rows;
  if (previous.length + candidates.length > MAX_SCAN * 2) throw new AppError('vector_capacity_exceeded', 503);
  const previousDeps = (await tx.query(`SELECT x.* FROM memory_search_document_dependencies x JOIN memory_search_documents d
    ON d.profile_id=x.profile_id AND d.id=x.document_id WHERE x.profile_id=$1 AND d.projection_version=$2 ORDER BY x.source_id`, [profileId, generation.projectionVersion])).rows;
  const dependencyMap = new Map<string, VectorDependency[]>();
  for (const row of previousDeps) { const key = String(row.document_id); const values = dependencyMap.get(key) ?? []; values.push({ sourceId: String(row.source_id), revision: Number(row.source_revision) }); dependencyMap.set(key, values); }
  const oldByKey = new Map(previous.map(row => [String(row.source_id) + ':' + String(row.projection_key), row]));
  const ready = new Set((await tx.query('SELECT document_id FROM memory_embeddings WHERE profile_id=$1 AND generation_id=$2', [profileId, generation.id])).rows.map(row => String(row.document_id)));
  const jobs = new Map((await tx.query('SELECT document_id,status FROM embedding_jobs WHERE profile_id=$1 AND generation_id=$2', [profileId, generation.id])).rows.map(row => [String(row.document_id), String(row.status)]));
  let upserted = 0; let enqueued = 0; let removed = 0;
  for (const { candidate, guards } of candidates) {
    const old = oldByKey.get(candidate.sourceId + ':' + candidate.projectionKey);
    const documentId = old ? String(old.id) : randomUUID();
    const changed = !old || Number(old.source_revision) !== candidate.sourceRevision || old.content_hash !== candidate.contentHash
      || old.document_text !== candidate.text || old.kind !== candidate.kind || old.scope !== candidate.scope
      || Boolean(old.embedding_eligible) !== candidate.embeddingEligible || JSON.stringify(dependencyMap.get(documentId) ?? []) !== JSON.stringify(guards);
    if (changed) {
      if (old) {
        await tx.query('DELETE FROM embedding_jobs WHERE profile_id=$1 AND document_id=$2', [profileId, documentId]);
        await tx.query('DELETE FROM memory_embeddings WHERE profile_id=$1 AND document_id=$2', [profileId, documentId]);
        await tx.query('DELETE FROM memory_search_document_dependencies WHERE profile_id=$1 AND document_id=$2', [profileId, documentId]);
      }
      await tx.query(`INSERT INTO memory_search_documents(profile_id,id,source_id,source_revision,content_hash,projection_version,projection_key,
        kind,scope,document_text,embedding_eligible,learned_local_date,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) ON CONFLICT(profile_id,id) DO UPDATE SET
        source_revision=EXCLUDED.source_revision,content_hash=EXCLUDED.content_hash,kind=EXCLUDED.kind,scope=EXCLUDED.scope,
        document_text=EXCLUDED.document_text,embedding_eligible=EXCLUDED.embedding_eligible,learned_local_date=EXCLUDED.learned_local_date,updated_at=EXCLUDED.updated_at`,
      [profileId, documentId, candidate.sourceId, candidate.sourceRevision, candidate.contentHash, candidate.projectionVersion, candidate.projectionKey,
        candidate.kind, candidate.scope, candidate.text, candidate.embeddingEligible, candidate.learnedLocalDate ?? null, now]);
      for (const guard of guards) await tx.query(`INSERT INTO memory_search_document_dependencies(profile_id,document_id,source_id,source_revision) VALUES($1,$2,$3,$4)`, [profileId, documentId, guard.sourceId, guard.revision]);
      upserted++;
    } else if ((old!.learned_local_date ? calendarDate(old!.learned_local_date) : '') !== String(candidate.learnedLocalDate ?? '')) {
      await tx.query('UPDATE memory_search_documents SET learned_local_date=$3 WHERE profile_id=$1 AND id=$2', [profileId, documentId, candidate.learnedLocalDate ?? null]);
    }
    if (candidate.embeddingEligible && (changed || !ready.has(documentId)) && (changed || !jobs.has(documentId) || jobs.get(documentId) === 'done' || input.retryDead === true && jobs.get(documentId) === 'failed')) {
      await tx.query(`INSERT INTO embedding_jobs(id,profile_id,document_id,generation_id,source_revision,content_hash,captured_deletion_epoch,next_attempt_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8) ON CONFLICT(profile_id,document_id,generation_id,source_revision,content_hash)
        DO UPDATE SET status='pending',attempts=0,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,
          captured_deletion_epoch=EXCLUDED.captured_deletion_epoch,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=EXCLUDED.updated_at`,
      [randomUUID(), profileId, documentId, generation.id, candidate.sourceRevision, candidate.contentHash, Number(profile.deletion_epoch), now]);
      enqueued++;
    }
  }
  if (input.replace) {
    const obsolete = previous.filter(row => !seen.has(String(row.source_id) + ':' + String(row.projection_key))).map(row => String(row.id));
    if (obsolete.length) removed = (await tx.query('DELETE FROM memory_search_documents WHERE profile_id=$1 AND id=ANY($2::uuid[]) RETURNING id', [profileId, obsolete])).rows.length;
  }
  return { upserted, enqueued, removed };
}

async function guardedDocument(tx: Queryable, profileId: string, documentId: string, generation: SearchGeneration, lock = false): Promise<StoredSearchDocument | null> {
  const row = (await tx.query('SELECT * FROM memory_search_documents WHERE profile_id=$1 AND id=$2 AND projection_version=$3', [profileId, documentId, generation.projectionVersion])).rows[0];
  if (!row) return null;
  const guards = (await tx.query('SELECT source_id,source_revision FROM memory_search_document_dependencies WHERE profile_id=$1 AND document_id=$2 ORDER BY source_id', [profileId, documentId])).rows.map(value => ({ sourceId: String(value.source_id), revision: Number(value.source_revision) }));
  if (!guards.some(guard => guard.sourceId === String(row.source_id) && guard.revision === Number(row.source_revision))) return null;
  const records = (await tx.query(`${SOURCE_GUARDS} WHERE r.profile_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id${lock ? ' FOR SHARE OF r' : ''}`, [profileId, guards.map(value => value.sourceId)])).rows;
  const current = new Map(records.map(value => [String(value.id), value]));
  if (guards.some(guard => !recordValid(current.get(guard.sourceId), guard.revision))) return null;
  const document = documentFrom(row, guards);
  if (!sourceEligible(current.get(document.sourceId)!, document) || guards.some(guard => current.get(guard.sourceId)!.vector_address)) return null;
  if (projectionContentHash(document.text, document.dependencies, document.projectionVersion) !== document.contentHash) return null;
  return document;
}

/** Bounded exact profile scan; overflow is an explicit fallback condition. */
export async function listEligibleDocuments(tx: Queryable, input: { profileId: string; generationId: string; limit?: number; now?: string }): Promise<StoredSearchDocument[]> {
  const profileId = id(input.profileId); const generation = await getGeneration(tx, input.generationId);
  if (generation.status === 'retired') return [];
  const limit = integer(input.limit ?? MAX_SCAN, 1, MAX_SCAN);
  const rows = (await tx.query(`SELECT d.* FROM memory_search_documents d JOIN memory_records root
    ON root.profile_id=d.profile_id AND root.id=d.source_id AND root.content_revision=d.source_revision AND root.scope=d.scope
    LEFT JOIN facts f ON f.profile_id=root.profile_id AND f.id=root.id
    LEFT JOIN events e ON e.profile_id=root.profile_id AND e.id=root.id
    LEFT JOIN child_stories s ON s.profile_id=root.profile_id AND s.id=root.id
    WHERE d.profile_id=$1 AND d.projection_version=$2 AND root.evidence_kind IN ('child_reported','reported_plan')
    AND ((d.kind='preference' AND root.kind='preference' AND f.id IS NOT NULL AND f.slot IS NULL AND f.category<>'self_description')
      OR (d.kind='event' AND root.kind='event' AND e.id IS NOT NULL) OR (d.kind='child_story' AND root.kind='story' AND s.id IS NOT NULL))
    AND EXISTS(SELECT 1 FROM memory_search_document_dependencies own WHERE own.profile_id=d.profile_id
      AND own.document_id=d.id AND own.source_id=d.source_id AND own.source_revision=d.source_revision)
    AND NOT EXISTS(SELECT 1 FROM memory_search_document_dependencies x LEFT JOIN memory_records r
      ON r.profile_id=x.profile_id AND r.id=x.source_id AND r.content_revision=x.source_revision
      WHERE x.profile_id=d.profile_id AND x.document_id=d.id AND r.id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM memory_search_document_dependencies x JOIN address_preferences a
      ON a.profile_id=x.profile_id AND a.id=x.source_id WHERE x.profile_id=d.profile_id AND x.document_id=d.id)
    ORDER BY d.id LIMIT $3`, [profileId, generation.projectionVersion, limit + 1])).rows;
  if (rows.length > limit) throw new AppError('vector_capacity_exceeded', 503);
  if (!rows.length) return [];
  const guardRows = (await tx.query('SELECT * FROM memory_search_document_dependencies WHERE profile_id=$1 AND document_id=ANY($2::uuid[]) ORDER BY source_id', [profileId, rows.map(row => row.id)])).rows;
  const guards = new Map<string, VectorDependency[]>();
  for (const row of guardRows) { const key = String(row.document_id); const values = guards.get(key) ?? []; values.push({ sourceId: String(row.source_id), revision: Number(row.source_revision) }); guards.set(key, values); }
  return rows.map(row => documentFrom(row, guards.get(String(row.id)) ?? []))
    .filter(document => projectionContentHash(document.text, document.dependencies, document.projectionVersion) === document.contentHash);
}

function hit(document: StoredSearchDocument, method: VectorSearchHit['method'], score: number, rank: number, generationId?: string): VectorSearchHit {
  return { profileId: document.profileId, documentId: document.documentId, sourceId: document.sourceId, sourceRevision: document.sourceRevision,
    contentHash: document.contentHash, projectionKey: document.projectionKey, projectionVersion: document.projectionVersion,
    ...(generationId ? { generationId } : {}), method, score, rank, dependencies: document.dependencies, kind: document.kind, scope: document.scope,
    ...(document.learnedLocalDate ? { learnedLocalDate: document.learnedLocalDate } : {}) };
}

export async function lexicalCandidates(tx: Queryable, input: { profileId: string; generationId: string; query: string; limit?: number; now?: string }): Promise<VectorSearchHit[]> {
  const limit = integer(input.limit ?? 20, 1, 20);
  if (typeof input.query !== 'string' || Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES) throw new AppError('invalid_vector_query');
  return (await listEligibleDocuments(tx, { ...input, limit: MAX_SCAN })).map(document => ({ document, score: lexicalScore(input.query, document.text) }))
    .filter(value => value.score > 0).sort((a, b) => b.score - a.score || a.document.sourceId.localeCompare(b.document.sourceId)).slice(0, limit)
    .map((value, index) => hit(value.document, 'lexical', value.score, index + 1));
}

function vector(value: readonly number[], dimensions?: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16_000 || dimensions !== undefined && value.length !== dimensions
    || value.some(element => !Number.isFinite(element) || !Number.isFinite(Math.fround(element)))) throw new AppError('invalid_embedding_vector');
  const rounded = value.map(element => Math.fround(element));
  if (!rounded.some(element => element !== 0)) throw new AppError('invalid_embedding_vector');
  return rounded;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new AppError('embedding_dimensions_mismatch');
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index]! * b[index]!; aa += a[index]! ** 2; bb += b[index]! ** 2; }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}

export async function denseCandidates(tx: Queryable, input: { profileId: string; generationId: string; vector: readonly number[]; limit?: number; now?: string }): Promise<VectorSearchHit[]> {
  const profileId = id(input.profileId); const generation = await getGeneration(tx, input.generationId);
  if (generation.status === 'retired') return [];
  const query = vector(input.vector, generation.dimensions); const limit = integer(input.limit ?? 20, 1, 20);
  const documents = new Map((await listEligibleDocuments(tx, { ...input, limit: MAX_SCAN })).map(document => [document.documentId, document]));
  let rows: Row[];
  if (generation.backend === 'pgvector') {
    const capability = await readVectorCapability(tx); const schema = quoteIdentifier(capability.extensionSchema!);
    rows = (await tx.query(`SELECT e.document_id,1-(e.embedding_vector OPERATOR(${schema}.<=>) $3::${schema}.vector) AS score
      FROM memory_embeddings e WHERE e.profile_id=$1 AND e.generation_id=$2 AND e.embedding_vector IS NOT NULL
      ORDER BY e.embedding_vector OPERATOR(${schema}.<=>) $3::${schema}.vector,e.document_id LIMIT $4`, [profileId, generation.id, JSON.stringify(query), MAX_SCAN + 1])).rows;
  } else rows = (await tx.query('SELECT document_id,coordinates FROM memory_embeddings WHERE profile_id=$1 AND generation_id=$2 ORDER BY document_id LIMIT $3', [profileId, generation.id, MAX_SCAN + 1])).rows;
  if (rows.length > MAX_SCAN) throw new AppError('vector_capacity_exceeded', 503);
  return rows.map(row => ({ document: documents.get(String(row.document_id)), score: generation.backend === 'pgvector' ? Number(row.score) : cosine(query, vector(row.coordinates as number[], generation.dimensions)) }))
    .filter((value): value is { document: StoredSearchDocument; score: number } => !!value.document && Number.isFinite(value.score))
    .sort((a, b) => b.score - a.score || a.document.sourceId.localeCompare(b.document.sourceId)).slice(0, limit)
    .map((value, index) => hit(value.document, 'dense', value.score, index + 1, generation.id));
}

function jobFrom(row: Row, document: StoredSearchDocument, generation: SearchGeneration): EmbeddingJob {
  return { jobId: String(row.id), profileId: String(row.profile_id), documentId: String(row.document_id), generationId: generation.id,
    model: generation.model, dimensions: generation.dimensions, text: document.text, sourceId: document.sourceId,
    sourceRevision: document.sourceRevision, contentHash: document.contentHash, dependencies: document.dependencies,
    deletionEpoch: Number(row.captured_deletion_epoch), leaseToken: String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at instanceof Date ? row.lease_expires_at.toISOString() : String(row.lease_expires_at), attempt: Number(row.attempts) };
}

/** Claims are short transactions. The caller must release them before invoking
 * a provider; document text exists only in the returned transient payload. */
export async function claimEmbeddingJobs(db: Database, input: {
  workerId: string; generationId?: string; profileId?: string; limit: number; now: string; leaseMs?: number;
}): Promise<EmbeddingJob[]> {
  const workerId = label(input.workerId); const limit = integer(input.limit, 1, 32); const now = time(input.now);
  const leaseMs = integer(input.leaseMs ?? 30_000, 100, 120_000);
  const generationId = input.generationId ? digest(input.generationId) : null;
  const profileId = input.profileId ? id(input.profileId) : null;
  return db.transaction(async tx => {
    const candidates = (await tx.query(`SELECT j.id,j.profile_id FROM embedding_jobs j JOIN search_generations g ON g.id=j.generation_id
      WHERE g.status<>'retired' AND ($2::text IS NULL OR j.generation_id=$2)
      AND ($4::uuid IS NULL OR j.profile_id=$4)
      AND ((j.status='pending' AND j.attempts<j.max_attempts AND j.next_attempt_at<=$1) OR (j.status='leased' AND j.lease_expires_at<=$1))
      ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT $3`, [now, generationId, limit * 4, profileId])).rows;
    const result: EmbeddingJob[] = [];
    for (const candidate of candidates) {
      if (result.length >= limit) break;
      const profile = (await tx.query('SELECT deletion_epoch FROM profiles WHERE id=$1 FOR UPDATE SKIP LOCKED', [candidate.profile_id])).rows[0];
      if (!profile) continue;
      const row = (await tx.query(`SELECT * FROM embedding_jobs WHERE id=$1
        AND ((status='pending' AND attempts<max_attempts AND next_attempt_at<=$2) OR (status='leased' AND lease_expires_at<=$2)) FOR UPDATE SKIP LOCKED`, [candidate.id, now])).rows[0];
      if (!row) continue;
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        await tx.query("UPDATE embedding_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,last_error_code='attempts_exhausted',updated_at=$2 WHERE id=$1", [row.id, now]);
        continue;
      }
      const generation = await getGeneration(tx, String(row.generation_id), true);
      if (generation.status === 'retired') continue;
      const document = await guardedDocument(tx, String(row.profile_id), String(row.document_id), generation, true);
      if (!document || !document.embeddingEligible || Number(row.source_revision) !== document.sourceRevision || row.content_hash !== document.contentHash) {
        await tx.query("UPDATE embedding_jobs SET status='failed',last_error_code='stale_source',lease_token=NULL,lease_expires_at=NULL,updated_at=$2 WHERE id=$1", [row.id, now]);
        continue;
      }
      const leaseToken = randomUUID(); const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const leased = (await tx.query(`UPDATE embedding_jobs SET status='leased',attempts=attempts+1,lease_token=$2,lease_expires_at=$3,
        worker_id=$4,captured_deletion_epoch=$5,updated_at=$6 WHERE id=$1 RETURNING *`, [row.id, leaseToken, leaseUntil, workerId, Number(profile.deletion_epoch), now])).rows[0]!;
      result.push(jobFrom(leased, document, generation));
    }
    return result;
  });
}

/** Optional second guard immediately before dispatching a previously claimed
 * batch. A concurrent deletion can never be unsent after the API has started. */
export async function readClaimedEmbeddingJob(db: Database, input: { jobId: string; leaseToken: string; now: string }): Promise<EmbeddingJob | null> {
  const jobId = id(input.jobId); const token = id(input.leaseToken); const now = time(input.now);
  const candidate = (await db.query('SELECT profile_id FROM embedding_jobs WHERE id=$1', [jobId])).rows[0];
  if (!candidate) return null;
  return db.transaction(async tx => {
    const profile = (await tx.query('SELECT deletion_epoch FROM profiles WHERE id=$1 FOR UPDATE', [candidate.profile_id])).rows[0];
    const row = (await tx.query('SELECT * FROM embedding_jobs WHERE id=$1', [jobId])).rows[0];
    if (!profile || !row || row.status !== 'leased' || row.lease_token !== token || milliseconds(row.lease_expires_at) <= Date.parse(now)
      || Number(profile.deletion_epoch) !== Number(row.captured_deletion_epoch)) return null;
    const generation = await getGeneration(tx, String(row.generation_id), true);
    if (generation.status === 'retired') return null;
    const document = await guardedDocument(tx, String(row.profile_id), String(row.document_id), generation, true);
    return document && document.embeddingEligible ? jobFrom(row, document, generation) : null;
  });
}

export async function commitEmbedding(db: Database, input: {
  jobId: string; leaseToken: string; vector: readonly number[]; now: string;
  model?: string; dimensions?: number; generationId?: string;
}): Promise<EmbeddingCommitResult> {
  const jobId = id(input.jobId); const token = id(input.leaseToken); const now = time(input.now);
  const coordinates = vector(input.vector); const vectorHash = hash(JSON.stringify(coordinates));
  const candidate = (await db.query('SELECT profile_id FROM embedding_jobs WHERE id=$1', [jobId])).rows[0];
  if (!candidate) return { applied: false, status: 'missing' };
  return db.transaction(async tx => {
    const profile = (await tx.query('SELECT deletion_epoch FROM profiles WHERE id=$1 FOR UPDATE', [candidate.profile_id])).rows[0];
    const row = (await tx.query('SELECT * FROM embedding_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
    if (!profile || !row) return { applied: false, status: 'missing' };
    const generation = await getGeneration(tx, String(row.generation_id), true);
    if (input.model !== undefined && input.model !== generation.model || input.dimensions !== undefined && input.dimensions !== generation.dimensions
      || input.generationId !== undefined && input.generationId !== generation.id) throw new AppError('embedding_generation_mismatch', 409);
    vector(coordinates, generation.dimensions);
    if (row.status === 'done' && row.lease_token === token) {
      const existing = (await tx.query('SELECT vector_hash FROM memory_embeddings WHERE profile_id=$1 AND document_id=$2 AND generation_id=$3', [row.profile_id, row.document_id, generation.id])).rows[0];
      if (existing?.vector_hash === vectorHash) return { applied: false, status: 'already_done' };
      throw new AppError('idempotency_conflict', 409);
    }
    if (row.status !== 'leased' || row.lease_token !== token || milliseconds(row.lease_expires_at) <= Date.parse(now)) return { applied: false, status: 'stale_lease' };
    if (generation.status === 'retired') {
      await tx.query("UPDATE embedding_jobs SET status='failed',lease_expires_at=NULL,last_error_code='retired_generation',updated_at=$2 WHERE id=$1", [jobId, now]);
      return { applied: false, status: 'retired_generation' };
    }
    if (Number(profile.deletion_epoch) !== Number(row.captured_deletion_epoch)) {
      await tx.query("UPDATE embedding_jobs SET status='pending',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=$2,last_error_code='stale_epoch',updated_at=$2 WHERE id=$1", [jobId, now]);
      return { applied: false, status: 'stale_epoch' };
    }
    const document = await guardedDocument(tx, String(row.profile_id), String(row.document_id), generation, true);
    if (!document || !document.embeddingEligible || document.sourceRevision !== Number(row.source_revision) || document.contentHash !== row.content_hash) {
      await tx.query("UPDATE embedding_jobs SET status='failed',lease_expires_at=NULL,last_error_code='stale_source',updated_at=$2 WHERE id=$1", [jobId, now]);
      return { applied: false, status: 'stale_source' };
    }
    const values = [row.profile_id, row.document_id, generation.id, row.source_revision, row.content_hash, generation.dimensions, coordinates, vectorHash, now];
    if (generation.backend === 'pgvector') {
      const capability = await readVectorCapability(tx); const schema = quoteIdentifier(capability.extensionSchema!);
      await tx.query(`INSERT INTO memory_embeddings(profile_id,document_id,generation_id,source_revision,content_hash,dimensions,coordinates,vector_hash,created_at,embedding_vector)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::${schema}.vector) ON CONFLICT(profile_id,document_id,generation_id) DO NOTHING`, [...values, JSON.stringify(coordinates)]);
    } else await tx.query(`INSERT INTO memory_embeddings(profile_id,document_id,generation_id,source_revision,content_hash,dimensions,coordinates,vector_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(profile_id,document_id,generation_id) DO NOTHING`, values);
    const saved = (await tx.query('SELECT vector_hash FROM memory_embeddings WHERE profile_id=$1 AND document_id=$2 AND generation_id=$3', [row.profile_id, row.document_id, generation.id])).rows[0];
    if (saved?.vector_hash !== vectorHash) throw new AppError('idempotency_conflict', 409);
    await tx.query("UPDATE embedding_jobs SET status='done',lease_expires_at=NULL,last_error_code=NULL,updated_at=$2 WHERE id=$1", [jobId, now]);
    return { applied: true, status: 'committed' };
  });
}

export async function failEmbedding(db: Database, input: { jobId: string; leaseToken: string; code: string; now: string; retryable?: boolean }): Promise<{ applied: boolean; status: 'pending' | 'failed' | 'stale_lease' | 'missing' }> {
  const jobId = id(input.jobId); const token = id(input.leaseToken); const now = time(input.now);
  if (!/^[a-zA-Z0-9_]{1,100}$/u.test(input.code)) throw new AppError('invalid_embedding_error_code');
  const candidate = (await db.query('SELECT profile_id FROM embedding_jobs WHERE id=$1', [jobId])).rows[0];
  if (!candidate) return { applied: false, status: 'missing' };
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [candidate.profile_id]);
    const row = (await tx.query('SELECT * FROM embedding_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
    if (!row) return { applied: false, status: 'missing' };
    if (row.status !== 'leased' || row.lease_token !== token || milliseconds(row.lease_expires_at) <= Date.parse(now)) return { applied: false, status: 'stale_lease' };
    const retry = input.retryable !== false && Number(row.attempts) < Number(row.max_attempts);
    const due = new Date(Date.parse(now) + Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, Number(row.attempts) - 1))).toISOString();
    await tx.query(`UPDATE embedding_jobs SET status=$2,lease_token=NULL,lease_expires_at=NULL,last_error_code=$3,next_attempt_at=$4,updated_at=$5 WHERE id=$1`, [jobId, retry ? 'pending' : 'failed', input.code, due, now]);
    return { applied: true, status: retry ? 'pending' : 'failed' };
  });
}
