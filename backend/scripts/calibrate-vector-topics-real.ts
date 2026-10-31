import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenAIEmbeddingProvider } from '../pipeline/embeddings.js';
import { AppError } from '../shared/types.js';

const STRIPPED_QUERIES = [
  { key: 'en_event_paraphrase', capture: 'en_pet_event', text: 'pet tumble involving water', group: 'existing_monolingual' },
  { key: 'en_hobby_paraphrase', capture: 'en_hobby', text: 'sketching tiny spacecraft', group: 'existing_monolingual' },
  { key: 'vi_hobby_paraphrase', capture: 'vi_hobby', text: 'làm đồ chơi bằng giấy', group: 'existing_monolingual' },
  { key: 'vi_to_en_event', capture: 'en_pet_event', text: 'con chó ngã vào nước', group: 'existing_crosslanguage' },
  { key: 'en_to_vi_event', capture: 'vi_pet_event', text: 'plant-container mishap', group: 'existing_crosslanguage' },
  { key: 'fictional_story_paraphrase', capture: 'child_story', text: 'make-believe rabbit’s landing place', group: 'existing_monolingual' },
] as const;
const NEW_QUERIES = [
  { key: 'new_vi_to_en_hobby', capture: 'en_hobby', text: 'vẽ tên lửa nhỏ', group: 'new_crosslanguage' },
  { key: 'new_en_to_vi_hobby', capture: 'vi_hobby', text: 'assembling paper models', group: 'new_crosslanguage' },
  { key: 'unknown_far_chess', capture: null, text: 'a submarine chess tournament', group: 'new_unknown_far' },
  { key: 'unknown_far_music', capture: null, text: 'a piano recital with grandma', group: 'new_unknown_far' },
  { key: 'unknown_near_dog', capture: null, text: 'a dog swimming across a lake', group: 'new_unknown_near' },
  { key: 'unknown_near_cat', capture: null, text: 'a cat breaking a flower pot', group: 'new_unknown_near' },
] as const;
const MODEL = 'text-embedding-3-large'; const DIMENSIONS = 1536;
const THRESHOLDS = [.35, .30, .28] as const;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function cosine(left: readonly number[], right: readonly number[]) {
  const value = left.reduce((sum, coordinate, index) => sum + coordinate * right[index]!, 0)
    / (Math.hypot(...left) * Math.hypot(...right));
  check(Number.isFinite(value), 'invalid_cosine'); return Math.max(-1, Math.min(1, value));
}

export async function calibrateVectorTopicsReal(options: {
  sourceReport: string; output: string; environment?: Readonly<Record<string, string | undefined>>; planOnly?: boolean;
}) {
  const env = options.environment ?? process.env;
  if (env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new Error('real_provider_required');
  const output = resolve(options.output); await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const sourcePath = resolve(options.sourceReport); const raw = await readFile(sourcePath, 'utf8'); const source = JSON.parse(raw);
  check(source.run_kind === 'isolated_vector_real_provider_verification' && source.provider_requested === 'real'
    && source.benchmark?.version === 'vector-tiny-real-v2', 'wrong_source_report');
  const documents: { sourceId: string; text: string }[] = source.snapshots.indexed.documents.map((row: { source_id: string; document_text: string }) => ({ sourceId: row.source_id, text: row.document_text }));
  check(documents.length === 6 && new Set(documents.map(document => document.sourceId)).size === 6, 'expected_six_canonical_documents');
  const queries = [...STRIPPED_QUERIES, ...NEW_QUERIES].map(query => {
    const expected: string[] = query.capture ? source.labels[query.capture].sourceIds : [];
    check(expected.every(id => documents.some(document => document.sourceId === id)), 'unknown_expected_source');
    return { ...query, expectedSourceIds: expected };
  });
  const inputs = documents.map(document => document.text).concat(queries.map(query => query.text));
  check(inputs.length === 18 && inputs.every(input => typeof input === 'string' && input.trim() && Buffer.byteLength(input, 'utf8') <= 512), 'invalid_calibration_batch');
  const plan = { version: 'vector-topic-calibration-v1', model: MODEL, dimensions: DIMENSIONS,
    thresholds: THRESHOLDS, documents, queries, input_sha256: inputs.map(hash), input_bytes: inputs.map(input => Buffer.byteLength(input, 'utf8')),
    gold: 'Recorded canonical source IDs. Unknown dog-swim and cat-break are unsupported propositions, distinct from the recorded puddle fall and plant-pot spill.',
    label: 'Calibration, not held-out evaluation. No production policy or threshold is adopted.' };
  const sourceHashes: Record<string, string> = {};
  for (const path of ['backend/pipeline/embeddings.ts', 'backend/scripts/calibrate-vector-topics-real.ts']) sourceHashes[path] = hash(await readFile(path, 'utf8'));
  let provider: OpenAIEmbeddingProvider | undefined; let results: unknown[] = []; let summaries: unknown[] = [];
  let error: { code: string; status?: number } | null = null; const started = performance.now();
  async function save(status: string) {
    const report = { run_kind: 'real_embedding_topic_calibration_not_held_out', status, plan,
      plan_sha256: hash(JSON.stringify(plan)), source_report: sourcePath, source_report_sha256: hash(raw), source_sha256: sourceHashes,
      provider_requested: 'real', production_accessed: false, dialogue_requests: 0, database_connections: 0,
      actual_embedding_requests: provider?.telemetry.length ?? 0, request_cap: 1, telemetry: provider?.telemetry ?? [], results, summaries,
      error, elapsed_ms: Math.round(performance.now() - started),
      limitations: ['Six already observed canonical source records and fixed calibration topics; no held-out/general quality claim.',
        'Four unknown examples cannot establish a safe global threshold. Nearby unsupported propositions can resemble legitimate source memories.',
        'Dense cosine only; no runtime lexical fusion, canonical species filter, dialogue grounding, or physical voice behavior is evaluated.',
        'All accepted candidates across the six-document corpus count toward precision, including unknown-query candidates; top-three selections are recorded separately.'] };
    await writeFile(resolve(output, 'plan.json'), JSON.stringify({ plan, sha256: report.plan_sha256 }, null, 2) + '\n');
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'embedding-requests.jsonl'), (provider?.telemetry ?? []).map(event => JSON.stringify(event)).join('\n') + (provider?.telemetry.length ? '\n' : ''));
    return report;
  }
  await save(options.planOnly ? 'not_attempted_plan_only' : 'running');
  if (options.planOnly) return save('not_attempted_plan_only');
  try {
    check(env.OPENAI_API_KEY?.trim(), 'missing_openai_key');
    provider = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: MODEL, dimensions: DIMENSIONS, timeoutMs: 60_000 });
    const embedded = await provider.embed(inputs); check(embedded.requestId, 'actual_embedding_request_id_missing');
    const evaluated = queries.map((query, index) => {
      const ranked = documents.map((document, documentIndex) => ({ sourceId: document.sourceId,
        score: cosine(embedded.vectors[documents.length + index]!, embedded.vectors[documentIndex]!) }))
        .sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId));
      const thresholds = THRESHOLDS.map(threshold => {
        const allAccepted = ranked.filter(hit => hit.score >= threshold); const selectedTop3 = allAccepted.slice(0, 3);
        const truePositives = allAccepted.filter(hit => query.expectedSourceIds.includes(hit.sourceId)).length;
        return { threshold, allAccepted, selectedTop3, truePositives, falsePositives: allAccepted.length - truePositives,
          precisionAmongAllAccepted: allAccepted.length ? truePositives / allAccepted.length : null,
          targetHitAt3: query.expectedSourceIds.length ? selectedTop3.some(hit => query.expectedSourceIds.includes(hit.sourceId)) : null,
          noAnswerCorrect: query.expectedSourceIds.length ? null : allAccepted.length === 0 };
      });
      return { ...query, ranked, top1Margin: ranked[0]!.score - ranked[1]!.score,
        targets: query.expectedSourceIds.map(id => ({ sourceId: id, rank: ranked.findIndex(hit => hit.sourceId === id) + 1, score: ranked.find(hit => hit.sourceId === id)!.score })), thresholds };
    });
    results = evaluated;
    summaries = THRESHOLDS.map(threshold => {
      const at = evaluated.map(query => ({ query, result: query.thresholds.find(result => result.threshold === threshold)! }));
      const tp = at.reduce((sum, item) => sum + item.result.truePositives, 0); const fp = at.reduce((sum, item) => sum + item.result.falsePositives, 0);
      const grouped = (group: string) => at.filter(item => item.query.group === group);
      return { threshold, positiveQueries: at.filter(item => item.query.expectedSourceIds.length).length,
        positiveHitsAt3: at.filter(item => item.result.targetHitAt3).length,
        existingCrossLanguageHits: grouped('existing_crosslanguage').filter(item => item.result.targetHitAt3).length,
        newCrossLanguageHits: grouped('new_crosslanguage').filter(item => item.result.targetHitAt3).length,
        unknownQueries: at.filter(item => !item.query.expectedSourceIds.length).length,
        unknownsWithCandidates: at.filter(item => item.result.noAnswerCorrect === false).length,
        allAcceptedTruePositives: tp, allAcceptedFalsePositives: fp, precisionAmongAllAccepted: tp + fp ? tp / (tp + fp) : null };
    });
  } catch (failure) {
    error = failure instanceof AppError ? { code: failure.code, status: failure.status }
      : { code: 'embedding_topic_calibration_failed' };
  }
  const report = await save(error ? 'completed_with_unresolved_failures' : 'completed');
  await writeFile(resolve(output, 'report.md'), `Real topic calibration: ${report.status}\n\n${report.actual_embedding_requests} actual embedding request; zero dialogue and database calls. Compare predeclared thresholds 0.35/0.30/0.28 using full JSON only. Calibration, not held-out acceptance; runtime policy unchanged. Exact topics, source IDs, margins and all-accepted precision are in [report.json](report.json).\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' },
    'env-file': { type: 'string' }, 'plan-only': { type: 'boolean', default: false } } });
  check(values.source && values.output, 'source_and_output_required');
  if (!values['plan-only'] && values['env-file']) loadEnvFile(values['env-file']);
  const report = await calibrateVectorTopicsReal({ sourceReport: values.source, output: values.output, planOnly: values['plan-only'] });
  console.log('Topic calibration: ' + report.status + '; actual requests=' + report.actual_embedding_requests);
  if (!values['plan-only'] && report.status !== 'completed') process.exitCode = 1;
}
