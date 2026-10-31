import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryStore } from '../memory/index.js';
import { VectorMemoryService, vectorBackend } from '../memory/vector/service.js';
import { VECTOR_NORMALIZER_VERSION, VECTOR_PROJECTION_VERSION } from '../memory/vector/types.js';
import { OpenAIEmbeddingProvider } from '../pipeline/embeddings.js';
import { AppError } from '../shared/types.js';

/** Enqueue a canonical backfill; --run explicitly drains real embedding jobs.
 * The synthetic historical archive is never part of the canonical projection. */
export async function indexVectorMemory(options: {
  env: Readonly<Record<string, string | undefined>>;
  profile?: string; allProfiles?: boolean; dataDir?: string;
  run?: boolean; retryFailed?: boolean; maxBatches?: number;
}) {
  const env = options.env;
  const backend = vectorBackend(env);
  const model = env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-large';
  const dimensions = Number(env.OPENAI_EMBEDDING_DIMENSIONS ?? 1536);
  const maxBatches = options.maxBatches ?? 100;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 16000
    || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) throw new AppError('invalid_vector_configuration');
  if (options.run && env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new AppError('real_embedding_provider_required');
  const memory = await createMemoryStore({
    // An explicit local directory wins over an inherited server URL.
    databaseUrl: options.dataDir ? undefined : env.DATABASE_URL,
    dataDir: options.dataDir ?? (env.DATABASE_URL ? undefined : env.MIU_DATA_DIR ?? resolve('.miu-data')),
    clockMode: 'real', vectorExtension: backend === 'pgvector',
  });
  let service: VectorMemoryService | undefined;
  let provider: OpenAIEmbeddingProvider | undefined;
  try {
    const generation = await memory.enableSearch({ model, dimensions, backend, distance: 'cosine',
      projectionVersion: VECTOR_PROJECTION_VERSION, normalizerVersion: VECTOR_NORMALIZER_VERSION });
    const profileKey = options.profile ?? 'an';
    const profiles = options.allProfiles
      ? (await memory.db.query<{ id: string }>('SELECT id FROM profiles ORDER BY id')).rows
      : (await memory.db.query<{ id: string }>('SELECT id FROM profiles WHERE demo_key=$1 OR id::text=$1', [profileKey])).rows;
    if (!profiles.length) throw new AppError('profile_not_found', 404);
    const indexing = { upserted: 0, enqueued: 0, removed: 0 };
    for (const profile of profiles) {
      const result = await memory.backfillSearch(profile.id, { retryFailed: options.retryFailed });
      indexing.upserted += result.upserted; indexing.enqueued += result.enqueued; indexing.removed += result.removed;
    }
    const worker = { processed: 0, committed: 0, discarded: 0, failed: 0 };
    if (options.run) {
      provider = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model, dimensions });
      service = await VectorMemoryService.create(memory, provider, { backend, autoStart: false });
      for (const profile of profiles) {
        const result = await service.flush(maxBatches, profile.id);
        worker.processed += result.processed; worker.committed += result.committed;
        worker.discarded += result.discarded; worker.failed += result.failed;
      }
    }
    const jobs = await memory.db.query<{ status: string; count: string }>(`SELECT status,count(*)::text AS count
      FROM embedding_jobs WHERE generation_id=$1 AND profile_id=ANY($2::uuid[]) GROUP BY status ORDER BY status`,
    [generation.id, profiles.map(profile => profile.id)]);
    return { mode: options.run ? 'real_embedding_backfill' : 'enqueue_only', profiles: profiles.length,
      generation, indexing, worker, jobs: Object.fromEntries(jobs.rows.map(row => [row.status, Number(row.count)])),
      actualEmbeddingRequests: provider?.requestCount ?? 0,
      usage: (provider?.telemetry ?? []).reduce((total, call) => ({ promptTokens: total.promptTokens + (call.promptTokens ?? 0),
        totalTokens: total.totalTokens + (call.totalTokens ?? 0) }), { promptTokens: 0, totalTokens: 0 }),
      syntheticArchiveIndexed: false, personalTextLogged: false };
  } finally { await service?.close(); await memory.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string', default: '.env' }, profile: { type: 'string' }, 'all-profiles': { type: 'boolean', default: false },
    'data-dir': { type: 'string' }, run: { type: 'boolean', default: false },
    'retry-failed': { type: 'boolean', default: false }, 'max-batches': { type: 'string', default: '100' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) console.log('Usage: tsx backend/scripts/index-vector-memory.ts [--env-file .env] [--profile an | --all-profiles] [--data-dir LOCAL_DIRECTORY] [--run] [--retry-failed] [--max-batches 100]\nDefault: migrate the configured database and enqueue canonical projections without provider requests. --run generates real embeddings. --retry-failed explicitly requeues failed jobs.');
  else {
    try {
      if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
      const result = await indexVectorMemory({ env: process.env, profile: values.profile, allProfiles: values['all-profiles'],
        dataDir: values['data-dir'], run: values.run, retryFailed: values['retry-failed'], maxBatches: Number(values['max-batches']) });
      console.log(JSON.stringify(result, null, 2));
      if (values.run && (result.worker.failed || result.jobs.failed || result.jobs.pending || result.jobs.leased)) process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ error: { code: error instanceof AppError ? error.code : 'vector_backfill_failed' } }));
      process.exitCode = 1;
    }
  }
}
