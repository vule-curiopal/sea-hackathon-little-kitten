import { randomUUID } from 'node:crypto';
import { OpenAIEmbeddingProvider, type EmbeddingProvider } from '../../pipeline/embeddings.js';
import { AppError, type MemoryEvidenceCard, type MemoryRetrievalResult } from '../../shared/types.js';
import type { MemoryStore } from '../index.js';
import { canonicalDependencies, projectCanonicalProfile } from './projections.js';
import { extractProperNameAnchors, matchesProperNameAnchors, matchesQuerySourceConstraints, rankHybridCandidates, semanticQueryEligibility } from './ranking.js';
import { claimEmbeddingJobs, commitEmbedding, denseCandidates, failEmbedding, getGeneration, lexicalCandidates,
  readClaimedEmbeddingJob, type EmbeddingJob, type SearchGeneration } from './store.js';
import { VECTOR_NORMALIZER_VERSION, VECTOR_PROJECTION_VERSION, type RankedVectorCandidate,
  type SemanticQueryInput, type VectorSearchHit } from './types.js';
import type { VectorBackend } from './capability.js';

export interface VectorMemoryOptions {
  backend: VectorBackend;
  autoStart?: boolean;
  queryTimeoutMs?: number;
  minDenseSimilarity?: number;
  evaluationMode?: boolean;
  now?: () => Date;
}
export interface RetrievalDiagnostics {
  generationId: string; backend: VectorBackend; mode: 'hybrid' | 'lexical';
  embeddingRequested: boolean; embeddingErrorCode?: string;
  lexicalCandidates: number; denseCandidates: number; returned: number; elapsedMs: number;
}
export interface RetrievalTrace {
  lexical: VectorSearchHit[]; dense: VectorSearchHit[]; ranked: RankedVectorCandidate[];
  status: MemoryRetrievalResult['status']; reason?: string;
}
export interface EmbeddingWorkSummary { processed: number; committed: number; discarded: number; failed: number }
const FATAL = new Set(['provider_authentication_failed', 'provider_permission_denied', 'provider_model_unavailable',
  'provider_quota_exceeded', 'provider_rate_limited']);
const safeCode = (error: unknown): string => error instanceof AppError ? error.code
  : error instanceof RangeError && /^vector_[a-z_]+$/u.test(error.message) ? error.message : 'embedding_unavailable';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Derived search only. Provider work never runs in a canonical transaction. */
export class VectorMemoryService {
  private readonly controller = new AbortController();
  private readonly now: () => Date;
  private interval?: ReturnType<typeof setInterval>;
  private running?: Promise<EmbeddingWorkSummary>;
  private readonly searches = new Set<Promise<MemoryRetrievalResult>>();
  private closed = false;
  private pausedCode?: string;
  private trace?: RetrievalTrace;
  private diagnostics?: RetrievalDiagnostics;
  readonly generation: SearchGeneration;

  private constructor(readonly memory: MemoryStore, readonly provider: EmbeddingProvider,
    generation: SearchGeneration, private readonly options: VectorMemoryOptions) {
    this.generation = generation;
    this.now = options.now ?? (() => memory.realNow());
    if (options.autoStart !== false) {
      this.interval = setInterval(() => this.wake(), 2_000);
      this.interval.unref();
    }
  }
  static async create(memory: MemoryStore, provider: EmbeddingProvider, options: VectorMemoryOptions) {
    if (provider.mode !== 'real') throw new AppError('real_embedding_provider_required', 400);
    const timeout = options.queryTimeoutMs ?? 1_000;
    const threshold = options.minDenseSimilarity ?? (provider.model === 'text-embedding-3-large' ? .30 : .35);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000
      || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new AppError('invalid_vector_configuration');
    const generation = await memory.enableSearch({ model: provider.model, dimensions: provider.dimensions,
      projectionVersion: VECTOR_PROJECTION_VERSION, normalizerVersion: VECTOR_NORMALIZER_VERSION,
      distance: 'cosine', backend: options.backend });
    return new VectorMemoryService(memory, provider, generation, options);
  }
  get lastDiagnostics() { return this.diagnostics ? { ...this.diagnostics } : undefined; }
  /** Source-ID traces are available only in explicitly isolated evaluations. */
  get lastTrace() { return this.options.evaluationMode && this.trace ? structuredClone(this.trace) : undefined; }
  get workerState() { return { paused: !!this.pausedCode, errorCode: this.pausedCode ?? null, closed: this.closed }; }
  async indexProfile(profileId: string, options: { retryFailed?: boolean } = {}) {
    if (this.closed) throw new AppError('memory_search_closed', 503);
    return this.memory.backfillSearch(profileId, options);
  }
  async validateEvidence(profileId: string, cards: readonly MemoryEvidenceCard[]): Promise<boolean> {
    if (this.closed || cards.length > 3) return false;
    return this.memory.searchTransaction(async tx => {
      if (!(await tx.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE', [profileId])).rows.length) return false;
      if ((await getGeneration(tx, this.generation.id)).status !== 'active') return false;
      const canonical = await projectCanonicalProfile(tx, profileId);
      return cards.every(card => canonical.some(source => source.sourceId === card.sourceId
        && source.sourceRevision === card.sourceRevision && source.contentHash === card.contentHash
        && source.projectionKey === card.projectionKey && source.projectionVersion === card.projectionVersion
        && source.text === card.text && source.kind === card.kind && source.scope === card.scope
        && same(canonicalDependencies(source.dependencies), canonicalDependencies(card.dependencies))));
    });
  }
  wake() {
    if (this.closed || this.pausedCode || this.options.autoStart === false) return;
    void this.flush(8).catch(error => { this.pausedCode = safeCode(error); });
  }
  async flush(maxBatches = 100, profileId?: string): Promise<EmbeddingWorkSummary> {
    if (this.running) {
      if (!profileId) return this.running;
      await this.running;
      return this.flush(maxBatches, profileId);
    }
    if (this.closed) throw new AppError('memory_search_closed', 503);
    if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1_000) throw new AppError('invalid_worker_budget');
    if (this.pausedCode) throw new AppError(this.pausedCode, 503);
    const work = this.process(maxBatches, profileId);
    this.running = work;
    try { return await work; }
    finally { if (this.running === work) this.running = undefined; }
  }
  private async process(maxBatches: number, profileId?: string): Promise<EmbeddingWorkSummary> {
    const total = { processed: 0, committed: 0, discarded: 0, failed: 0 };
    for (let batch = 0; batch < maxBatches && !this.closed && !this.pausedCode; batch++) {
      const jobs = await claimEmbeddingJobs(this.memory.db, { workerId: randomUUID(), generationId: this.generation.id,
        ...(profileId ? { profileId } : {}),
        limit: 8, now: this.now().toISOString(), leaseMs: 60_000 });
      if (!jobs.length) break;
      const groups = new Map<string, EmbeddingJob[]>();
      for (const job of jobs) groups.set(job.profileId, [...(groups.get(job.profileId) ?? []), job]);
      for (const group of groups.values()) {
        const live: EmbeddingJob[] = [];
        for (const job of group) {
          const fresh = await readClaimedEmbeddingJob(this.memory.db, { jobId: job.jobId,
            leaseToken: job.leaseToken, now: this.now().toISOString() });
          if (fresh) live.push(fresh); else { total.processed++; total.discarded++; }
        }
        if (!live.length) continue;
        const remaining = [...live];
        try {
          // Each group belongs to one profile. No transaction/row lock is held.
          const result = await this.provider.embed(live.map(job => job.text), this.controller.signal);
          for (const [index, job] of live.entries()) {
            const committed = await commitEmbedding(this.memory.db, { jobId: job.jobId, leaseToken: job.leaseToken,
              vector: result.vectors[index]!, model: result.model, dimensions: result.dimensions,
              generationId: job.generationId, now: this.now().toISOString() });
            total.processed++;
            if (committed.applied) total.committed++; else total.discarded++;
            remaining.shift();
          }
        } catch (error) {
          const code = safeCode(error);
          // Failed provider jobs require an explicit operator retry. Lease
          // recovery after a crashed worker remains a separate bounded path.
          for (const job of remaining) await failEmbedding(this.memory.db, { jobId: job.jobId, leaseToken: job.leaseToken,
            code, now: this.now().toISOString(), retryable: this.closed && code === 'provider_aborted' });
          total.processed += remaining.length; total.failed += remaining.length;
          if (FATAL.has(code)) { this.pausedCode = code; throw error; }
        }
      }
    }
    return total;
  }
  search(input: SemanticQueryInput & { profileId: string; signal?: AbortSignal }): Promise<MemoryRetrievalResult> {
    const work = this.performSearch(input);
    this.searches.add(work);
    void work.then(() => this.searches.delete(work), () => this.searches.delete(work));
    return work;
  }
  private async performSearch(input: SemanticQueryInput & { profileId: string; signal?: AbortSignal }): Promise<MemoryRetrievalResult> {
    const started = performance.now();
    const eligibility = semanticQueryEligibility(input);
    let lexical: VectorSearchHit[] = []; let dense: VectorSearchHit[] = []; let ranked: RankedVectorCandidate[] = [];
    let embeddingRequested = false; let embeddingErrorCode: string | undefined;
    const finish = (status: MemoryRetrievalResult['status'], cards: MemoryEvidenceCard[], reason?: string): MemoryRetrievalResult => {
      this.diagnostics = { generationId: this.generation.id, backend: this.generation.backend,
        mode: dense.length ? 'hybrid' : 'lexical', embeddingRequested, ...(embeddingErrorCode ? { embeddingErrorCode } : {}),
        lexicalCandidates: lexical.length, denseCandidates: dense.length, returned: cards.length, elapsedMs: Math.round(performance.now() - started) };
      if (this.options.evaluationMode) this.trace = { lexical, dense, ranked, status, ...(reason ? { reason } : {}) };
      return { status, cards, ...(reason ? { reason } : {}), diagnostics: this.diagnostics };
    };
    if (this.closed) return finish('skipped', [], 'memory_search_closed');
    if (!eligibility.eligible) return finish('skipped', [], eligibility.reason);
    try {
      const before = await this.memory.searchTransaction(async tx => {
        const generation = await getGeneration(tx, this.generation.id);
        if (generation.status !== 'active') throw new AppError('retired_search_generation', 409);
        const profile = (await tx.query('SELECT deletion_epoch FROM profiles WHERE id=$1 FOR UPDATE', [input.profileId])).rows[0];
        if (!profile) throw new AppError('profile_not_found', 404);
        lexical = await lexicalCandidates(tx, { profileId: input.profileId, generationId: this.generation.id,
          query: eligibility.topic, limit: 20, now: this.now().toISOString() });
        const indexed = await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM memory_search_documents WHERE profile_id=$1 AND projection_version=$2', [input.profileId, generation.projectionVersion]);
        return { epoch: Number(profile.deletion_epoch), indexed: Number(indexed.rows[0]!.count) };
      });
      if (!before.indexed) return finish('unresolved', [], 'no_indexed_evidence');
      let queryVector: number[] | undefined;
      if (this.pausedCode) embeddingErrorCode = this.pausedCode;
      else {
        embeddingRequested = true;
        try {
          const signal = AbortSignal.any([this.controller.signal, ...(input.signal ? [input.signal] : []),
            AbortSignal.timeout(this.options.queryTimeoutMs ?? 1_000)]);
          const response = await this.provider.embed([eligibility.topic], signal);
          queryVector = response.vectors[0];
        } catch (error) {
          embeddingErrorCode = safeCode(error);
          if (FATAL.has(embeddingErrorCode)) this.pausedCode = embeddingErrorCode;
          if (input.signal?.aborted || this.closed) return finish('skipped', [], 'request_aborted');
        }
      }
      if (this.closed || input.signal?.aborted) return finish('skipped', [], 'request_aborted');
      const cards = await this.memory.searchTransaction(async tx => {
        if (this.closed) return [];
        const profile = (await tx.query('SELECT deletion_epoch FROM profiles WHERE id=$1 FOR UPDATE', [input.profileId])).rows[0];
        if (!profile || Number(profile.deletion_epoch) !== before.epoch) return [];
        const generation = await getGeneration(tx, this.generation.id);
        if (generation.status !== 'active') return [];
        if (queryVector) dense = await denseCandidates(tx, { profileId: input.profileId, generationId: generation.id,
          vector: queryVector, limit: 20, now: this.now().toISOString() });
        const canonical = await projectCanonicalProfile(tx, input.profileId);
        const anchors = extractProperNameAnchors(eligibility.topic);
        const eligible = new Set(canonical.filter(source => matchesProperNameAnchors(source.text, anchors)
          && matchesQuerySourceConstraints(source.text, eligibility.topic)).map(source => source.sourceId));
        lexical = lexical.filter(candidate => eligible.has(candidate.sourceId));
        dense = dense.filter(candidate => eligible.has(candidate.sourceId));
        const fused = rankHybridCandidates({ profileId: input.profileId, generationId: generation.id,
          typedDisposition: input.typedDisposition, query: eligibility.topic, lexical, dense,
          allowedScopes: ['reported_real', 'fictional'], minLexicalScore: .25, minDenseSimilarity: this.options.minDenseSimilarity
            ?? (this.provider.model === 'text-embedding-3-large' ? .30 : .35) });
        ranked = fused.candidates;
        if (!ranked.length) return [];
        // Reconstruct from canonical tables; stored index prose is never evidence.
        return ranked.flatMap(candidate => {
          const current = canonical.find(source => source.sourceId === candidate.sourceId && source.projectionKey === candidate.projectionKey);
          if (!current || current.sourceRevision !== candidate.sourceRevision || current.contentHash !== candidate.contentHash
            || !same(canonicalDependencies(current.dependencies), canonicalDependencies(candidate.dependencies))) return [];
          return [{ sourceId: current.sourceId, sourceRevision: current.sourceRevision, contentHash: current.contentHash,
            projectionKey: current.projectionKey, projectionVersion: current.projectionVersion, dependencies: current.dependencies,
            kind: current.kind, scope: current.scope, text: current.text } satisfies MemoryEvidenceCard];
        });
      });
      return finish(embeddingErrorCode ? 'degraded' : cards.length ? 'available' : 'unresolved', cards,
        embeddingErrorCode ?? (cards.length ? undefined : 'no_eligible_evidence'));
    } catch (error) {
      return finish('degraded', [], safeCode(error));
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    if (this.interval) clearInterval(this.interval);
    await this.running?.catch(() => undefined);
    await Promise.allSettled([...this.searches]);
  }
}

function integer(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number, minimum: number, maximum: number) {
  const result = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new AppError('invalid_vector_configuration', 503);
  return result;
}
export function vectorSearchEnabled(env: Readonly<Record<string, string | undefined>>) {
  const value = env.MIU_MEMORY_SEARCH_ENABLED ?? '0';
  if (!['0', '1', 'false', 'true'].includes(value)) throw new AppError('invalid_vector_configuration', 503);
  return value === '1' || value === 'true';
}
export function vectorBackend(env: Readonly<Record<string, string | undefined>>): VectorBackend {
  const value = env.MEMORY_VECTOR_BACKEND ?? 'pgvector';
  if (!['pgvector', 'array_exact'].includes(value)) throw new AppError('invalid_vector_configuration', 503);
  return value as VectorBackend;
}
export async function createVectorMemoryFromEnv(memory: MemoryStore, env: Readonly<Record<string, string | undefined>>) {
  if (!vectorSearchEnabled(env)) return undefined;
  const provider = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-large',
    dimensions: integer(env, 'OPENAI_EMBEDDING_DIMENSIONS', 1536, 1, 16000),
    timeoutMs: integer(env, 'OPENAI_EMBEDDING_TIMEOUT_MS', 10_000, 1, 60_000) });
  const threshold = env.MEMORY_MIN_COSINE_SIMILARITY === undefined
    ? (provider.model === 'text-embedding-3-large' ? .30 : .35) : Number(env.MEMORY_MIN_COSINE_SIMILARITY);
  const service = await VectorMemoryService.create(memory, provider, { backend: vectorBackend(env),
    queryTimeoutMs: integer(env, 'MEMORY_SEARCH_TIMEOUT_MS', 1_000, 1, 60_000), minDenseSimilarity: threshold });
  try {
    const profiles = await memory.db.query<{ id: string }>('SELECT id FROM profiles ORDER BY id');
    for (const profile of profiles.rows) {
      try { await service.indexProfile(profile.id); }
      catch (error) { if (!(error instanceof RangeError) || error.message !== 'vector_corpus_limit_exceeded') throw error; }
    }
    service.wake();
    return service;
  } catch (error) { await service.close(); throw error; }
}
