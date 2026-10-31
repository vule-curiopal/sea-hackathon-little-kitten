import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenAIEmbeddingProvider, type OpenAIEmbeddingTelemetry } from '../pipeline/embeddings.js';
import { FATAL_OPENAI_ERROR_CODES } from '../pipeline/providers.js';
import { AppError } from '../shared/types.js';

const MODELS = ['text-embedding-3-small', 'text-embedding-3-large'] as const;
const DIMENSIONS = 1536;
const THRESHOLD = .35;
const K = 3;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class CalibrationError extends Error { constructor(readonly code: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new CalibrationError(code); }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeError = (error: unknown) => error instanceof AppError ? { code: error.code, status: error.status }
  : { code: error instanceof CalibrationError ? error.code : 'embedding_calibration_failed' };

/** No summaries, translations, truncation, guessed predicates or assistant
 * text. These are complete existing literal fields from the recorded source. */
function compactLiteralProjection(fullJson: string): string {
  const record = object(JSON.parse(fullJson)); const parts: string[] = [];
  for (const key of ['subject', 'literal_title', 'literal_text', 'literal_value']) {
    const value = record[key];
    if (value !== undefined && value !== null) { check(typeof value === 'string', 'invalid_literal_field'); parts.push(value); }
  }
  if (record.conditions !== undefined) {
    check(Array.isArray(record.conditions) && record.conditions.every(value => typeof value === 'string'), 'invalid_conditions');
    parts.push(...record.conditions);
  }
  if (record.qualifiers !== undefined) {
    check(record.qualifiers !== null && typeof record.qualifiers === 'object' && !Array.isArray(record.qualifiers), 'invalid_qualifiers');
    parts.push(JSON.stringify(record.qualifiers));
  }
  const text = parts.join('\n'); check(text.trim(), 'empty_compact_projection'); return text;
}
function cosine(left: readonly number[], right: readonly number[]) {
  check(left.length === right.length && left.length === DIMENSIONS, 'vector_shape_changed');
  const denominator = Math.hypot(...left) * Math.hypot(...right);
  const score = left.reduce((total, value, index) => total + value * right[index]!, 0) / denominator;
  check(Number.isFinite(score), 'invalid_cosine'); return Math.max(-1, Math.min(1, score));
}
type CorpusDocument = { sourceId: string; fullJson: string; compactLiteral: string };
type Query = { key: string; input: string; expectedSourceIds: string[] };
type ModelResult = { model: string; status: 'not_attempted' | 'completed' | 'failed' | 'blocked'; error?: unknown;
  telemetry?: readonly Readonly<OpenAIEmbeddingTelemetry>[]; variants?: unknown; vectorHashes?: string[] };

export async function calibrateVectorEmbeddingsReal(options: {
  sourceReport: string; output: string; environment?: Readonly<Record<string, string | undefined>>; planOnly?: boolean;
}) {
  const env = options.environment ?? process.env;
  if (env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new Error('real_provider_required');
  const output = resolve(options.output); const sourcePath = resolve(options.sourceReport);
  await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const raw = await readFile(sourcePath, 'utf8'); const source = JSON.parse(raw);
  check(source.run_kind === 'isolated_vector_real_provider_verification' && source.provider_requested === 'real'
    && source.benchmark?.version === 'vector-tiny-real-v2', 'wrong_source_report');
  const indexed = source.snapshots?.indexed?.documents;
  check(Array.isArray(indexed) && indexed.length === 6, 'expected_six_recorded_documents');
  const documents: CorpusDocument[] = indexed.map((row: unknown) => {
    const record = object(row); check(typeof record.source_id === 'string' && typeof record.document_text === 'string', 'invalid_recorded_document');
    return { sourceId: record.source_id, fullJson: record.document_text, compactLiteral: compactLiteralProjection(record.document_text) };
  });
  check(new Set(documents.map(document => document.sourceId)).size === documents.length, 'duplicate_recorded_source');
  const queries: Query[] = source.benchmark.queries.map((item: unknown) => {
    const record = object(item); check(typeof record.key === 'string' && typeof record.text === 'string' && typeof record.capture === 'string', 'invalid_recorded_query');
    const label = source.labels?.[record.capture];
    check(Array.isArray(label?.sourceIds) && label.sourceIds.length && label.sourceIds.every((id: unknown) => typeof id === 'string' && documents.some(document => document.sourceId === id)), 'missing_recorded_label');
    return { key: record.key, input: record.text, expectedSourceIds: label.sourceIds };
  });
  check(queries.length === 6 && typeof source.benchmark.unknownQuery === 'string', 'expected_six_queries_and_unknown');
  queries.push({ key: 'unknown_no_answer', input: source.benchmark.unknownQuery, expectedSourceIds: [] });
  const inputs = documents.map(document => document.fullJson).concat(documents.map(document => document.compactLiteral), queries.map(query => query.input));
  check(inputs.length === 19 && inputs.every(input => Buffer.byteLength(input, 'utf8') <= 512), 'calibration_batch_out_of_bounds');
  const bindings = documents.map(document => ({ type: 'full_json', sourceId: document.sourceId }))
    .concat(documents.map(document => ({ type: 'compact_literal', sourceId: document.sourceId })))
    .concat(queries.map(query => ({ type: 'query', sourceId: query.key })));
  const started = performance.now(); const models: ModelResult[] = MODELS.map(model => ({ model, status: 'not_attempted' }));
  const sourceHashes: Record<string, string> = {};
  for (const path of ['backend/pipeline/embeddings.ts', 'backend/scripts/calibrate-vector-embeddings-real.ts']) sourceHashes[path] = hash(await readFile(path, 'utf8'));
  let blocker: unknown = null;
  async function save(status: string) {
    const telemetry = models.flatMap(model => model.telemetry ?? []);
    const report = { run_kind: 'real_embedding_calibration_not_held_out', status, source_report: sourcePath,
      source_report_sha256: hash(raw), source_benchmark_sha256: source.benchmark_sha256,
      source_sha256: sourceHashes, provider_requested: 'real', production_accessed: false,
      dialogue_requests: 0, database_connections: 0, actual_embedding_requests: telemetry.length,
      model_request_cap: 2, inputs_per_request: 19, dimensions: DIMENSIONS, threshold: THRESHOLD, k: K,
      design: 'Within each model, one batch contains the same six full canonical JSON documents, six literal-only variants, six fixed labeled queries and one unknown query. Query vectors are shared between the two projection comparisons.',
      compact_projection_policy: 'Join complete subject/literal_title/literal_text/literal_value/conditions and full JSON qualifiers with newlines; no translation, summary, guessed predicate, or truncation.',
      documents, queries, input_sha256: inputs.map(hash), input_bytes: inputs.map(input => Buffer.byteLength(input, 'utf8')), bindings,
      models, blocker, elapsed_ms: Math.round(performance.now() - started),
      limitations: ['Calibration on already observed v2 failures, not held-out accuracy or acceptance.',
        'Six source records represent five captured statements; two preference IDs support one hobby statement.',
        'Dense cosine comparison only; no lexical fusion, dialogue, source-eligibility, deletion, native PostgreSQL, or production behavior is reevaluated.',
        'Compact texts exclude metadata tags from the embedding input. Production evidence must continue preserving scope, category, dates and all guards outside this experiment.'],
    };
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'embedding-requests.jsonl'), telemetry.map(row => JSON.stringify(row)).join('\n') + (telemetry.length ? '\n' : ''));
    return report;
  }
  await save(options.planOnly ? 'not_attempted_plan_only' : 'running');
  if (options.planOnly) return save('not_attempted_plan_only');
  check(env.OPENAI_API_KEY?.trim(), 'missing_openai_key');
  for (const model of models) {
    if (blocker) { model.status = 'blocked'; model.error = blocker; continue; }
    const provider = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: model.model, dimensions: DIMENSIONS, timeoutMs: 60_000 });
    try {
      const result = await provider.embed(inputs);
      check(result.requestId, 'actual_embedding_request_id_missing');
      model.vectorHashes = result.vectors.map(vector => hash(JSON.stringify(vector)));
      const variants = (['full_json', 'compact_literal'] as const).map((variant, variantIndex) => {
        const evaluated = queries.map((query, queryIndex) => {
          const queryVector = result.vectors[documents.length * 2 + queryIndex]!;
          const ranked = documents.map((document, documentIndex) => ({ sourceId: document.sourceId,
            score: cosine(queryVector, result.vectors[variantIndex * documents.length + documentIndex]!) }))
            .sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId));
          const accepted = ranked.filter(hit => hit.score >= THRESHOLD).slice(0, K);
          const relevant = accepted.filter(hit => query.expectedSourceIds.includes(hit.sourceId)).length;
          return { key: query.key, expectedSourceIds: query.expectedSourceIds, ranked,
            targets: query.expectedSourceIds.map(sourceId => ({ sourceId, rank: ranked.findIndex(hit => hit.sourceId === sourceId) + 1, score: ranked.find(hit => hit.sourceId === sourceId)!.score })),
            accepted, hitAt3: query.expectedSourceIds.length ? relevant > 0 : null,
            sourceRecallAt3: query.expectedSourceIds.length ? relevant / query.expectedSourceIds.length : null,
            precisionAmongAccepted: accepted.length ? relevant / accepted.length : null,
            unknownCorrect: query.expectedSourceIds.length ? null : accepted.length === 0 };
        });
        const positives = evaluated.filter(query => query.expectedSourceIds.length);
        const cross = positives.filter(query => ['vi_to_en_event', 'en_to_vi_event'].includes(query.key));
        const unknown = evaluated.find(query => query.key === 'unknown_no_answer')!;
        return { variant, hits: positives.filter(query => query.hitAt3).length, positives: positives.length,
          crossLanguageHits: cross.filter(query => query.hitAt3).length, crossLanguageQueries: cross.length,
          unknownHighestSimilarity: unknown.ranked[0]!.score, unknownAccepted: unknown.accepted.length,
          unknownCorrect: unknown.unknownCorrect, queries: evaluated };
      });
      model.status = 'completed'; model.variants = variants;
    } catch (error) {
      model.status = 'failed'; model.error = safeError(error);
      if (error instanceof AppError && ([...FATAL_OPENAI_ERROR_CODES, 'provider_rate_limited'] as readonly string[]).includes(error.code)) blocker = safeError(error);
    }
    model.telemetry = provider.telemetry;
    console.log(model.model + ': ' + model.status); await save('running');
  }
  const report = await save(models.every(model => model.status === 'completed') ? 'completed' : 'completed_with_unresolved_failures');
  await writeFile(resolve(output, 'report.md'), `Real embedding calibration: ${report.status}\n\nCalibration only, not held-out acceptance. ${report.actual_embedding_requests} actual embedding requests; zero dialogue requests and database connections. Dimensions ${DIMENSIONS}; unchanged threshold ${THRESHOLD}; full rankings and source-ID labels in [report.json](report.json).\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' },
    'env-file': { type: 'string' }, 'plan-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) console.log('Usage: tsx backend/scripts/calibrate-vector-embeddings-real.ts --source REPORT_JSON --output NEW_DIRECTORY [--env-file EXPLICIT_FILE] [--plan-only]');
  else {
    check(values.source && values.output, 'source_and_output_required');
    if (!values['plan-only'] && values['env-file']) loadEnvFile(values['env-file']);
    const report = await calibrateVectorEmbeddingsReal({ sourceReport: values.source, output: values.output, planOnly: values['plan-only'] });
    console.log('Embedding calibration: ' + report.status + '; actual requests=' + report.actual_embedding_requests);
    if (!values['plan-only'] && report.status !== 'completed') process.exitCode = 1;
  }
}
