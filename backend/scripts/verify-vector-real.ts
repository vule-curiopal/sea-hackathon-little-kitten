import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MiuApplication, type TurnResponse } from '../application.js';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { VectorMemoryService, type RetrievalTrace } from '../memory/vector/service.js';
import { claimEmbeddingJobs, commitEmbedding } from '../memory/vector/store.js';
import type { TypedRetrievalDisposition } from '../memory/vector/types.js';
import { OpenAIEmbeddingProvider, type EmbeddingProvider } from '../pipeline/embeddings.js';
import { FATAL_OPENAI_ERROR_CODES, OpenAIProvider } from '../pipeline/providers.js';
import { AppError } from '../shared/types.js';

const CAPTURES = [
  { key: 'en_pet_event', kind: 'event', text: 'My dog is named Moki. Moki fell in a puddle.', literal: 'puddle' },
  { key: 'en_hobby', kind: 'preference', text: 'I enjoy drawing little rockets.', literal: 'rockets' },
  { key: 'child_story', kind: 'story', text: 'My story is called Pip and the Pillow Planet. Pip is a pretend rabbit who lands on a pillow planet.', literal: 'Pip' },
  { key: 'vi_hobby', kind: 'preference', text: 'Mình thích xếp mô hình bằng giấy.', literal: 'giấy' },
  { key: 'vi_pet_event', kind: 'event', text: 'Mèo nhà mình tên là Bông. Bông làm đổ chậu cây.', literal: 'chậu cây' },
] as const;
const QUERIES = [
  { key: 'en_event_paraphrase', capture: 'en_pet_event', language: 'en', text: 'Do you remember the pet tumble involving water that I told you about?' },
  { key: 'en_hobby_paraphrase', capture: 'en_hobby', language: 'en', text: 'Recall what I said about sketching tiny spacecraft.' },
  { key: 'vi_hobby_paraphrase', capture: 'vi_hobby', language: 'vi', text: 'Nhắc lại điều mình kể về việc làm đồ chơi bằng giấy.' },
  { key: 'vi_to_en_event', capture: 'en_pet_event', language: 'vi', text: 'Bạn còn nhớ chuyện con chó ngã vào nước mình đã kể không?' },
  { key: 'en_to_vi_event', capture: 'vi_pet_event', language: 'en', text: 'Recall the plant-container mishap I told you about.' },
  { key: 'fictional_story_paraphrase', capture: 'child_story', language: 'en', text: 'Can you recall the make-believe rabbit’s landing place I told you about?' },
] as const;
const VALIDATION_QUERIES = [
  { key: 'new_vi_rocket_recall', capture: 'en_hobby', language: 'vi', text: 'Nhớ lại chuyện vẽ tàu vũ trụ nhỏ mình từng kể.', negative: null },
  { key: 'new_en_paper_recall', capture: 'vi_hobby', language: 'en', text: 'Recall the paper folding pastime I shared.', negative: null },
  { key: 'new_unsupported_cat_break', capture: null, language: 'en', text: 'Do you remember Bông breaking the flower pot I told you about?', negative: 'break' },
  { key: 'new_unsupported_dog_swim', capture: null, language: 'en', text: 'Do you recall my dog swimming across a lake?', negative: 'swim' },
  { key: 'new_unsupported_dog_bath', capture: null, language: 'en', text: 'Do you remember my dog getting a bath after the puddle?', negative: 'bath' },
  { key: 'new_unsupported_real_rabbit', capture: null, language: 'en', text: 'Do you recall a real rabbit landing on a pillow planet at my home?', negative: 'real_scope' },
] as const;
const UNKNOWN = 'Do you remember what I told you about my underwater chess tournament?';
const CASES = [...CAPTURES.map(item => 'capture_' + item.key), 'index_corpus', ...QUERIES.map(item => item.key),
  ...VALIDATION_QUERIES.map(item => item.key),
  'unknown_no_answer', 'typed_precedence', 'typed_missing_app', 'typed_ambiguous_app', 'profile_isolation', 'canceled_capture', 'no_save_capture',
  'stale_embedding_after_correction', 'forget_cascade', 'after_forget_no_answer', 'durability_365_days'];
const MAX_EMBEDDING_REQUESTS = 32;
const MIN_COSINE = .30;
const MIN_LEXICAL = .25;
const K = 3;
const FATAL = new Set<string>([...FATAL_OPENAI_ERROR_CODES, 'provider_rate_limited']);
export const VECTOR_REAL_BENCHMARK = {
  version: 'vector-tiny-real-v3', captures: CAPTURES, queries: QUERIES, validationQueries: VALIDATION_QUERIES, unknownQuery: UNKNOWN,
  plannedDialogueTurns: 26, maxEmbeddingRequests: MAX_EMBEDDING_REQUESTS,
  embeddingModel: 'text-embedding-3-large', dimensions: 1536, backend: 'pgvector', minDenseSimilarity: MIN_COSINE,
  minLexicalScore: MIN_LEXICAL, projectionVersion: 'atomic-memory-v2', normalizerVersion: 'nfc-lexical-v2',
  queryTimeoutMs: 5_000, k: K,
  labelPolicy: 'Bind capture keys to persisted canonical IDs from the actual completed capture turn, independent of assistant wording and retrieval selection.',
  lifecycle: { canceled: 'I enjoy pottery.', noSave: "Don't remember this. I like knitting.",
    correction: 'I said the name wrong. My dog is Mochi, not Moki. Please correct it.',
    forget: 'Forget Mochi.', advanceControlledWallDays: 365 },
  typedQueries: { missing: 'What is my favorite color?', ambiguous: "Do you remember my pet's name?" },
  limitations: ['Tiny calibrated integration benchmark plus six new dialogue queries; no broad held-out or 95% retrieval-quality claim.',
    'The six added exact question texts were fixed before new requests and were not inputs to either embedding calibration batch.',
    'Automated negative-word scans catch bounded explicit assertions only; independent review must assess paraphrases, presuppositions and qualified claims.',
    'Typed synthetic EN/VI inputs, age 6-8, friend/ENFP. Receipts are simulated; no physical voice, TTS or browser.',
    'PGlite pgvector only. No native PostgreSQL or production session/connection.',
    'The 365-day step is a controlled clock advance, not a year-long operational soak.',
    'Stale-worker control evicts one derived vector only, then uses a genuine embedding of the old approved projection.',
    'Model replies and source-grounding semantics need separate review; scores and engine approval alone are insufficient.'],
} as const;
class AssertionFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new AssertionFailure(code); }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const safeError = (error: unknown) => error instanceof AppError
  ? { code: error.code, status: error.status, generation: error.generation ?? null }
  : { code: error instanceof AssertionFailure ? error.code : 'vector_verification_failed' };
type CaseResult = { name: string; status: 'not_attempted' | 'passed' | 'failed' | 'blocked'; evidence?: unknown; error?: unknown; elapsed_ms?: number };
type Label = { captureTurnId: string; kind: string; sourceIds: string[] };

async function sourceManifest() {
  const paths = new Set(['backend/application.ts', 'backend/recall.ts', 'backend/pipeline/providers.ts',
    'backend/pipeline/observations.ts', 'backend/pipeline/embeddings.ts', 'backend/scripts/verify-vector-real.ts']);
  async function scan(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = path + '/' + entry.name;
      if (entry.isDirectory()) await scan(child);
      else if (/\.(?:ts|sql|json)$/u.test(entry.name) && !entry.name.endsWith('.test.ts')) paths.add(child);
    }
  }
  for (const dir of ['backend/character', 'backend/shared', 'backend/memory']) await scan(dir);
  const result: Record<string, string> = {};
  for (const path of [...paths].sort()) result[path] = hash(await readFile(path, 'utf8'));
  return result;
}
function laneMetrics(returned: readonly string[], expected: readonly string[]) {
  const ids = [...new Set(returned)].slice(0, K); const relevant = ids.filter(id => expected.includes(id)).length;
  return { sourceIds: ids, relevantReturned: relevant, returned: ids.length, relevantEligible: expected.length,
    hitAt3: expected.length ? relevant > 0 : null, recallAt3: expected.length ? relevant / expected.length : null,
    precisionAmongReturned: ids.length ? relevant / ids.length : null, noAnswerCorrect: expected.length ? null : ids.length === 0 };
}
function negativeWordCheck(turn: TurnResponse, kind: 'break' | 'swim' | 'bath' | 'real_scope') {
  const predicate = {
    break: /\b(?:broke|broken|breaking|breaks)\b/iu,
    swim: /\b(?:swam|swum|swimming|swims)\b/iu,
    bath: /\b(?:bath|bathed|bathing|washed)\b/iu,
    real_scope: /\b(?:real|living|actual) rabbit\b/iu,
  }[kind];
  const flagged = turn.reply.sentences.flatMap(sentence => sentence.split(/;|,?\s+but\s+|,?\s+however\s+/iu)).filter(clause => {
    if (!predicate.test(clause)) return false;
    if (/\b(?:don['’]t|do not|can['’]t|cannot|not sure|unsure|no memory|no record|never told|haven['’]t told|have not told|didn['’]t say|did not say)\b/iu.test(clause)) return false;
    return /^(?:\s*yes\b|\s*(?:i|miu) (?:remember|recall)\b|\s*you (?:told|said|mentioned)\b|\s*(?:bông|moki|mochi|your (?:cat|dog|rabbit)|the (?:cat|dog|rabbit)) (?:broke|has broken|swam|has swum|was swimming|had a bath|got a bath|was bathed|landed)\b)/iu.test(clause);
  });
  check(!flagged.length, 'unsupported_negative_query_assertion');
  return { kind, explicit_assertion_flags: flagged, scope: 'bounded lexical diagnostic; separate semantic review required' };
}

/** Real embedding/dialogue proof only. No archive or authored assistant answers
 * are used to populate canonical data or establish expected source IDs. */
export async function verifyVectorReal(options: { output: string; environment?: Readonly<Record<string, string | undefined>>; planOnly?: boolean }) {
  const env = options.environment ?? process.env;
  if (env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new Error('real_provider_required');
  const output = resolve(options.output);
  await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const sourceHashes = await sourceManifest(); const started = performance.now();
  const cases: CaseResult[] = CASES.map(name => ({ name, status: 'not_attempted' }));
  const turns: Record<string, unknown>[] = []; const retrievals: Record<string, unknown>[] = [];
  const labels: Record<string, Label> = {}; const snapshots: Record<string, unknown> = {};
  let provider: OpenAIProvider | undefined; let embeddings: OpenAIEmbeddingProvider | undefined;
  let memory: MemoryStore | undefined; let service: VectorMemoryService | undefined; let app: MiuApplication | undefined;
  let time = Date.parse('2026-11-01T03:00:00.000Z'); let an = ''; let binh = ''; let session = '';
  let currentCase = ''; let blocker: unknown = null; let cleanup = 'not_started';
  let changedSources: string[] | null = null; const pending = new Map<string, string>();
  const benchmarkHash = hash(JSON.stringify(VECTOR_REAL_BENCHMARK));
  async function save(status: string) {
    const dialogueCalls = provider?.telemetry ?? []; const embeddingCalls = embeddings?.telemetry ?? [];
    const report = { run_kind: 'isolated_vector_real_provider_verification', status, provider_requested: 'real',
      database: 'fresh_in_memory_pglite_pgvector', production_accessed: false, fake_provider_constructed: false,
      benchmark: VECTOR_REAL_BENCHMARK, benchmark_sha256: benchmarkHash, labels, generation: service?.generation ?? null,
      source_sha256: sourceHashes, changed_source_paths_at_completion: changedSources,
      models: provider?.modelIds ?? null, embedding_model: embeddings?.model ?? null, embedding_dimensions: embeddings?.dimensions ?? null,
      actual_dialogue_api_requests: dialogueCalls.length, actual_embedding_api_requests: embeddingCalls.length,
      completed_model_reply_ids: dialogueCalls.filter(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId).map(call => call.responseId),
      completed_embedding_request_ids: embeddingCalls.filter(call => call.outcome === 'completed').map(call => call.requestId),
      coverage: { passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length,
        blocked: cases.filter(item => item.status === 'blocked').length, not_attempted: cases.filter(item => item.status === 'not_attempted').length },
      cases, snapshots, blocker, cleanup, elapsed_ms: Math.round(performance.now() - started),
      controlled_time: new Date(time).toISOString(), semantics: { status: 'needs_separate_review' } };
    await writeFile(resolve(output, 'benchmark.json'), JSON.stringify({ benchmark: VECTOR_REAL_BENCHMARK, sha256: benchmarkHash }, null, 2) + '\n');
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'turns.jsonl'), turns.map(row => JSON.stringify(row)).join('\n') + (turns.length ? '\n' : ''));
    await writeFile(resolve(output, 'retrievals.jsonl'), retrievals.map(row => JSON.stringify(row)).join('\n') + (retrievals.length ? '\n' : ''));
    await writeFile(resolve(output, 'api-requests.jsonl'), dialogueCalls.map(row => JSON.stringify(row)).join('\n') + (dialogueCalls.length ? '\n' : ''));
    await writeFile(resolve(output, 'embedding-requests.jsonl'), embeddingCalls.map(row => JSON.stringify(row)).join('\n') + (embeddingCalls.length ? '\n' : ''));
    await writeFile(resolve(output, 'report.md'), `Real vector verification: ${status}\n\n| Check | Status |\n| --- | --- |\n${cases.map(item => `| ${item.name} | ${item.status} |`).join('\n')}\n\nActual dialogue API requests: ${dialogueCalls.length}; actual embedding requests: ${embeddingCalls.length}. Fixed tiny benchmark; no 95% quality claim. Typed inputs and simulated receipts only. Separate semantic review pending. No production accessed.\n`);
    return report;
  }
  if (options.planOnly) return save('not_attempted_plan_only');
  function hardProviderBlock() {
    const failed = [...(provider?.telemetry ?? []), ...(embeddings?.telemetry ?? [])].find(call => call.errorCode && FATAL.has(call.errorCode));
    if (failed?.errorCode) throw new AppError(failed.errorCode, failed.httpStatus ?? 503);
  }
  async function cancelPending() {
    for (const [turnId, turnSession] of pending) {
      try { await app!.cancel(an, turnSession, turnId); } catch { /* Preserve the first safe failure. */ }
      pending.delete(turnId);
    }
  }
  async function run(name: string, work: () => Promise<unknown>, dependencies: string[] = []) {
    const entry = cases.find(item => item.name === name)!;
    const dependency = dependencies.find(key => cases.find(item => item.name === key)?.status !== 'passed');
    if (blocker || dependency) { entry.status = 'blocked'; entry.error = blocker ?? { code: 'dependency_not_passed', dependency }; await save('running'); return; }
    currentCase = name; const caseStarted = performance.now();
    try { entry.evidence = await work(); hardProviderBlock(); entry.status = 'passed'; }
    catch (error) {
      try { hardProviderBlock(); } catch (hard) { error = hard; }
      entry.status = 'failed'; entry.error = safeError(error);
      if (error instanceof AppError && FATAL.has(error.code)) blocker = { ...safeError(error), source: 'actual_request' };
      await cancelPending();
    }
    entry.elapsed_ms = Math.round(performance.now() - caseStarted); console.log(name + ': ' + entry.status); await save('running');
  }
  async function freshSession() {
    check(pending.size === 0, 'pending_turn_before_new_session');
    if (session) await app!.closeSession(an, session);
    session = (await app!.openSession('an')).session_id;
  }
  async function prepare(text: string) {
    await freshSession(); const turnId = randomUUID(); const start = provider!.telemetry.length;
    const embeddingStart = embeddings!.requestCount; provider!.resetDiagnostics(); pending.set(turnId, session);
    const row: Record<string, unknown> = { case: currentCase, request_id: turnId, input: text,
      controlled_time: new Date(time).toISOString(), fresh_session: true, delivery: 'not_delivered' };
    try {
      const turn = await app!.prepareTurn(an, session, { request_id: turnId, kind: 'utterance', text });
      const calls = provider!.telemetry.slice(start); const reply = provider!.lastReply;
      check(turn.provider_mode === 'real' && calls.some(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId), 'actual_reply_provenance_missing');
      Object.assign(row, { response: turn, classification: provider!.lastClassification, api_calls: calls,
        model_reply: reply && calls.some(call => call.responseId === reply.responseId && call.stage === 'reply') ? reply : null,
        embedding_requests: embeddings!.telemetry.filter(call => call.sequence > embeddingStart),
        retrieval_diagnostics: service!.lastDiagnostics, retrieval_trace: service!.lastTrace, delivery: 'prepared' });
      hardProviderBlock(); return { turn, row, embeddingStart };
    } catch (error) {
      const calls = provider!.telemetry.slice(start); const reply = provider!.lastReply;
      Object.assign(row, { error: safeError(error), api_calls: provider!.telemetry.slice(start), classification: provider!.lastClassification,
        model_reply: reply && calls.some(call => call.stage === 'reply' && call.responseId === reply.responseId) ? reply : null,
        embedding_requests: embeddings!.telemetry.filter(call => call.sequence > embeddingStart),
        retrieval_diagnostics: service!.lastDiagnostics, retrieval_trace: service!.lastTrace });
      throw error;
    } finally { turns.push(row); }
  }
  async function complete(turn: TurnResponse, row: Record<string, unknown>) {
    for (const status of ['started', 'completed'] as const) await app!.playback(an, session, turn.turn_id,
      { request_id: randomUUID(), status, state_version: turn.state_version });
    pending.delete(turn.turn_id); row.delivery = 'completed_simulated';
  }
  async function corpus(label: string) {
    const records = await memory!.db.query('SELECT id,kind,content_revision,scope,learned_local_date,last_reconfirmed_local_date FROM memory_records WHERE profile_id=$1 ORDER BY id', [an]);
    const docs = await memory!.db.query('SELECT id,source_id,source_revision,content_hash,kind,scope,document_text FROM memory_search_documents WHERE profile_id=$1 ORDER BY source_id', [an]);
    const vectors = await memory!.db.query('SELECT document_id,source_revision,content_hash,dimensions FROM memory_embeddings WHERE profile_id=$1 AND generation_id=$2 ORDER BY document_id', [an, service!.generation.id]);
    snapshots[label] = { canonical: records.rows, documents: docs.rows, embeddings: vectors.rows }; return { records: records.rows, docs: docs.rows, vectors: vectors.rows };
  }
  function retrievalMetrics(trace: RetrievalTrace, expected: string[]) {
    return { lexical: laneMetrics(trace.lexical.filter(hit => hit.score >= MIN_LEXICAL).map(hit => hit.sourceId), expected),
      dense: laneMetrics(trace.dense.filter(hit => hit.score >= MIN_COSINE).map(hit => hit.sourceId), expected),
      fusion: laneMetrics(trace.ranked.map(hit => hit.sourceId), expected) };
  }
  async function query(text: string, expected: string[], language = 'en', negative?: 'break' | 'swim' | 'bath' | 'real_scope') {
    const { turn, row, embeddingStart } = await prepare(text); const trace = service!.lastTrace;
    check(trace && embeddings!.requestCount > embeddingStart && service!.lastDiagnostics?.embeddingRequested, 'semantic_query_did_not_use_actual_embedding');
    check(embeddings!.telemetry.some(call => call.sequence > embeddingStart && call.outcome === 'completed' && call.requestId)
      && !service!.lastDiagnostics.embeddingErrorCode && trace.status !== 'degraded', 'semantic_query_embedding_not_completed');
    const cards = turn.presentation.memoryEvidence;
    check(cards && cards.length === service!.lastDiagnostics.returned, 'final_rehydrated_evidence_missing');
    const metrics = { ...retrievalMetrics(trace, expected), finalCards: laneMetrics(cards.map(card => card.sourceId), expected) };
    retrievals.push({ case: currentCase, input: text, expected_source_ids: expected, cards, trace, diagnostics: service!.lastDiagnostics, metrics });
    check(turn.reply.language === language, 'query_reply_wrong_language');
    check(expected.length ? metrics.finalCards.hitAt3 : cards.length === 0 && trace.ranked.length === 0 && trace.status === 'unresolved', expected.length ? 'expected_source_not_retrieved' : 'no_answer_query_returned_source');
    const wordCheck = negative ? negativeWordCheck(turn, negative) : undefined;
    if (wordCheck) row.negative_word_check = wordCheck;
    await complete(turn, row); return { metrics, retrieval_status: trace.status, ...(wordCheck ? { negative_word_check: wordCheck } : {}) };
  }
  try {
    check(env.OPENAI_API_KEY?.trim(), 'missing_openai_key');
    embeddings = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: VECTOR_REAL_BENCHMARK.embeddingModel,
      dimensions: VECTOR_REAL_BENCHMARK.dimensions, timeoutMs: 10_000 });
    const budgeted: EmbeddingProvider = { mode: 'real', model: embeddings.model, dimensions: embeddings.dimensions,
      embed: (inputs, signal) => { check(embeddings!.requestCount < MAX_EMBEDDING_REQUESTS, 'embedding_request_budget_exhausted'); return embeddings!.embed(inputs, signal); } };
    provider = new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, classifyModel: env.OPENAI_CLASSIFY_MODEL,
      replyModel: env.OPENAI_REPLY_MODEL, checkModel: env.OPENAI_CHECK_MODEL, moderationModel: env.OPENAI_MODERATION_MODEL,
      evaluationMode: true, timeoutMs: 60_000 });
    memory = await createMemoryStore({ vectorExtension: true, now: () => new Date(time), clockMode: 'demo' });
    service = await VectorMemoryService.create(memory, budgeted, { backend: 'pgvector', autoStart: false,
      evaluationMode: true, queryTimeoutMs: 5_000, minDenseSimilarity: MIN_COSINE, now: () => new Date(time) });
    check(service.generation.model === VECTOR_REAL_BENCHMARK.embeddingModel && service.generation.dimensions === VECTOR_REAL_BENCHMARK.dimensions
      && service.generation.projectionVersion === VECTOR_REAL_BENCHMARK.projectionVersion
      && service.generation.normalizerVersion === VECTOR_REAL_BENCHMARK.normalizerVersion, 'predeclared_generation_mismatch');
    app = new MiuApplication(memory, provider, () => time, { evaluateRealModel: true, turnTimeoutMs: 180_000, retrieval: service });
    for (const [demoKey, displayName] of [['an', 'An'], ['binh', 'Bình']] as const)
      await memory.createProfile({ demoKey, displayName, ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
    await app.bootstrap(); an = (await memory.findProfile('an'))!.id; binh = (await memory.findProfile('binh'))!.id;
    await save('running');
    for (const capture of CAPTURES) await run('capture_' + capture.key, async () => {
      const { turn, row } = await prepare(capture.text);
      if (capture.key === 'child_story') {
        check(!(turn.presentation.action?.domain === 'memory' && turn.presentation.action.target?.kind === 'pet'), 'child_story_capture_routed_to_pet_identity');
        check(!/(?:don['’]t know|do not know|haven['’]t told|have not told).{0,45}(?:pet['’]s name|name of your pet)/iu.test(turn.reply.text), 'child_story_capture_false_missing_pet_claim');
      }
      await complete(turn, row);
      const source = await memory!.db.query<{ id: string }>('SELECT id FROM memory_records WHERE profile_id=$1 AND source_turn_id=$2 AND kind=$3 ORDER BY id', [an, turn.turn_id, capture.kind]);
      check(source.rows.length > 0, 'canonical_capture_missing');
      const context = await app!.getContext(an);
      const eligible = capture.kind === 'event' ? context.events.filter(item => source.rows.some(row => row.id === item.id)).map(item => item.value)
        : capture.kind === 'story' ? context.stories.filter(item => source.rows.some(row => row.id === item.id)).map(item => item.title + ' ' + item.summary)
          : context.preferences.filter(item => source.rows.some(row => row.id === item.id)).map(item => item.value);
      check(eligible.some(text => text.includes(capture.literal)), 'capture_does_not_support_declared_label');
      labels[capture.key] = { captureTurnId: turn.turn_id, kind: capture.kind, sourceIds: source.rows.map(row => row.id) };
      return { canonical_source_ids: labels[capture.key]!.sourceIds };
    });
    await run('index_corpus', async () => {
      await service!.indexProfile(an); await service!.indexProfile(binh); const work = await service!.flush(4); hardProviderBlock();
      const snapshot = await corpus('indexed'); const expected = Object.values(labels).flatMap(label => label.sourceIds);
      check(expected.every(id => snapshot.docs.some(row => row.source_id === id)), 'canonical_source_not_projected');
      check(snapshot.docs.every(row => snapshot.vectors.some(vector => vector.document_id === row.id && vector.dimensions === 1536)), 'projection_missing_real_embedding');
      check(embeddings!.telemetry.some(call => call.outcome === 'completed' && call.requestId), 'embedding_request_provenance_missing');
      return { work, canonical_label_count: expected.length, documents: snapshot.docs.length, vectors: snapshot.vectors.length };
    }, CAPTURES.map(item => 'capture_' + item.key));
    for (const item of QUERIES) await run(item.key, () => query(item.text, labels[item.capture]!.sourceIds, item.language), ['index_corpus']);
    for (const item of VALIDATION_QUERIES) await run(item.key, () => query(item.text,
      item.capture ? labels[item.capture]!.sourceIds : [], item.language, item.negative ?? undefined), ['index_corpus']);
    await run('unknown_no_answer', () => query(UNKNOWN, []), ['index_corpus']);
    await run('typed_precedence', async () => {
      const before = embeddings!.requestCount; const results = [];
      for (const typedDisposition of ['resolved', 'missing', 'ambiguous'] as const satisfies readonly TypedRetrievalDisposition[]) {
        const result = await service!.search({ profileId: an, topic: QUERIES[0]!.text, typedDisposition,
          actionDomain: 'memory', intent: 'chat', safetyApproved: true, suppressLearning: false });
        check(result.status === 'skipped' && result.reason === 'typed_lane' && !result.cards.length, 'typed_precedence_not_preserved');
        results.push({ typedDisposition, result });
      }
      check(embeddings!.requestCount === before, 'typed_disposition_triggered_paid_embedding'); return { actual_embedding_requests: 0, results };
    }, ['index_corpus']);
    for (const status of ['missing', 'ambiguous'] as const) await run('typed_' + status + '_app', async () => {
      if (status === 'ambiguous') check((await app!.getContext(an)).entities.filter(entity => entity.kind === 'pet').length === 2, 'typed_ambiguity_requires_two_real_captured_pets');
      const { turn, row, embeddingStart } = await prepare(VECTOR_REAL_BENCHMARK.typedQueries[status]);
      check(turn.presentation.action?.domain === 'memory' && turn.presentation.action.target?.status === status, 'actual_typed_query_not_in_exact_lane');
      check(embeddings!.requestCount === embeddingStart && service!.lastDiagnostics?.embeddingRequested === false
        && service!.lastTrace?.reason === 'typed_lane', 'actual_typed_query_triggered_embedding');
      check(!turn.presentation.memoryEvidence?.length, 'typed_query_received_semantic_override');
      await complete(turn, row); return { exact_lane_status: status, actual_embedding_requests: 0 };
    }, ['index_corpus']);
    await run('profile_isolation', async () => {
      const result = await service!.search({ profileId: binh, topic: QUERIES[0]!.text, typedDisposition: 'not_applicable',
        actionDomain: 'conversation', intent: 'chat', safetyApproved: true, suppressLearning: false });
      const trace = service!.lastTrace; hardProviderBlock();
      check(result.status === 'unresolved' && !result.cards.length && trace?.lexical.length === 0 && trace.dense.length === 0, 'cross_profile_source_returned');
      return { result, trace };
    }, ['index_corpus']);
    await run('canceled_capture', async () => {
      const { turn, row } = await prepare(VECTOR_REAL_BENCHMARK.lifecycle.canceled);
      check(provider!.lastClassification?.accepted.candidates.some(candidate => candidate.kind === 'preference' && candidate.value.includes('pottery')), 'canceled_control_missing_eligible_candidate');
      await app!.cancel(an, session, turn.turn_id); pending.delete(turn.turn_id); row.delivery = 'canceled_before_started';
      const result = await memory!.db.query('SELECT id FROM memory_records WHERE profile_id=$1 AND source_turn_id=$2', [an, turn.turn_id]);
      check(result.rows.length === 0, 'canceled_capture_persisted'); await service!.indexProfile(an); await service!.flush(4);
      check((await memory!.db.query('SELECT id FROM memory_search_documents WHERE profile_id=$1 AND document_text ILIKE $2', [an, '%pottery%'])).rows.length === 0, 'canceled_text_indexed');
      return { canonical_sources: 0, indexed_sources: 0 };
    });
    await run('no_save_capture', async () => {
      const { turn, row } = await prepare(VECTOR_REAL_BENCHMARK.lifecycle.noSave);
      check(provider!.lastClassification?.accepted.suppressLearning && turn.presentation.ruleTrace.includes('D10:current_turn_only'), 'no_save_suppression_not_exercised');
      await complete(turn, row);
      const result = await memory!.db.query('SELECT id FROM memory_records WHERE profile_id=$1 AND source_turn_id=$2', [an, turn.turn_id]);
      check(result.rows.length === 0, 'no_save_capture_persisted'); await service!.indexProfile(an); await service!.flush(4);
      check((await memory!.db.query('SELECT id FROM memory_search_documents WHERE profile_id=$1 AND document_text ILIKE $2', [an, '%knitting%'])).rows.length === 0, 'no_save_text_indexed');
      return { canonical_sources: 0, indexed_sources: 0 };
    });
    await run('stale_embedding_after_correction', async () => {
      const old = (await memory!.db.query<{ id: string; content_hash: string; document_text: string }>(
        'SELECT id,content_hash,document_text FROM memory_search_documents WHERE profile_id=$1 AND source_id=$2', [an, labels.en_pet_event!.sourceIds[0]])).rows[0];
      check(old, 'stale_control_source_document_missing');
      await memory!.db.query('DELETE FROM memory_embeddings WHERE profile_id=$1 AND document_id=$2 AND generation_id=$3', [an, old.id, service!.generation.id]);
      await service!.indexProfile(an);
      const jobs = await claimEmbeddingJobs(memory!.db, { workerId: 'isolated-real-stale-control', generationId: service!.generation.id,
        limit: 32, now: new Date(time).toISOString(), leaseMs: 120_000 });
      check(jobs.length === 1 && jobs[0]!.sourceId === labels.en_pet_event!.sourceIds[0], 'stale_control_job_not_isolated');
      const job = jobs[0]!; const embedding = await budgeted.embed([job.text]); hardProviderBlock();
      check(embedding.requestId, 'stale_control_embedding_provenance_missing');
      const before = await app!.getContext(an); const pet = before.entities.find(item => item.kind === 'pet' && item.name === 'Moki');
      check(pet, 'correction_control_pet_missing');
      const { turn, row } = await prepare(VECTOR_REAL_BENCHMARK.lifecycle.correction); await complete(turn, row);
      const corrected = (await app!.getContext(an)).entities.find(item => item.id === pet.id);
      check(corrected?.name === 'Mochi', 'actual_model_correction_not_applied');
      const late = await commitEmbedding(memory!.db, { jobId: job.jobId, leaseToken: job.leaseToken,
        vector: embedding.vectors[0]!, model: embedding.model, dimensions: embedding.dimensions,
        generationId: job.generationId, now: new Date(time).toISOString() });
      check(!late.applied && ['missing', 'stale_source', 'stale_epoch'].includes(late.status), 'stale_actual_embedding_committed');
      await service!.indexProfile(an); await service!.flush(4);
      const current = (await memory!.db.query<{ content_hash: string; document_text: string }>('SELECT content_hash,document_text FROM memory_search_documents WHERE profile_id=$1 AND source_id=$2', [an, job.sourceId])).rows[0];
      check(current && current.content_hash !== old.content_hash && JSON.parse(current.document_text).subject === 'Mochi', 'corrected_projection_not_rebuilt');
      return { mechanics_control: 'derived_vector_eviction_only', same_entity_id: true, late_commit: late,
        actual_embedding: { requestId: embedding.requestId, model: embedding.model, dimensions: embedding.dimensions,
          usage: embedding.usage, vector_sha256: hash(JSON.stringify(embedding.vectors[0])) } };
    }, ['index_corpus']);
    await run('forget_cascade', async () => {
      const before = await corpus('before_forget'); const { turn, row } = await prepare(VECTOR_REAL_BENCHMARK.lifecycle.forget); await complete(turn, row);
      await service!.indexProfile(an); await service!.flush(4); const after = await corpus('after_forget');
      const deleted = labels.en_pet_event!.sourceIds;
      check(deleted.every(id => !after.records.some(record => record.id === id) && !after.docs.some(doc => doc.source_id === id)), 'forgotten_source_or_document_survived');
      const oldDocIds = before.docs.filter(doc => deleted.includes(String(doc.source_id))).map(doc => doc.id);
      const jobs = await memory!.db.query('SELECT id FROM embedding_jobs WHERE profile_id=$1 AND document_id=ANY($2::uuid[])', [an, oldDocIds]);
      check(jobs.rows.length === 0 && !after.vectors.some(vector => oldDocIds.includes(vector.document_id)), 'forgotten_derived_vector_or_job_survived');
      check(!(await app!.getContext(an)).entities.some(pet => pet.name === 'Mochi'), 'forgotten_pet_survived');
      return { deleted_source_ids: deleted, removed_document_ids: oldDocIds };
    }, ['stale_embedding_after_correction']);
    await run('after_forget_no_answer', () => query(QUERIES[0]!.text, []), ['forget_cascade']);
    await run('durability_365_days', async () => {
      if (session) { await app!.closeSession(an, session); session = ''; }
      time += 365 * 86_400_000;
      await app!.getContext(an); const snapshot = await corpus('after_365_days');
      const expected = labels.en_hobby!.sourceIds;
      check(expected.every(id => snapshot.records.some(record => record.id === id) && snapshot.docs.some(doc => doc.source_id === id)), 'durable_source_or_index_expired');
      const result = await query(QUERIES[1]!.text, expected);
      return { controlled_wall_days_advanced: 365, ...result };
    }, ['index_corpus', 'forget_cascade']);
  } catch (error) { blocker = { ...safeError(error), source: 'startup_or_harness' }; }
  finally {
    await cancelPending();
    try { await service?.close(); if (app) await app.close(); else await memory?.close(); cleanup = 'closed'; }
    catch { cleanup = 'failed'; blocker ??= { code: 'isolated_cleanup_failed' }; }
    const finalHashes = await sourceManifest();
    changedSources = [...new Set([...Object.keys(sourceHashes), ...Object.keys(finalHashes)])].filter(path => sourceHashes[path] !== finalHashes[path]);
    if (changedSources.length) blocker ??= { code: 'source_changed_during_run', paths: changedSources };
  }
  return save(blocker || cases.some(item => item.status === 'failed' || item.status === 'blocked') ? 'completed_with_unresolved_failures' : 'completed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'env-file': { type: 'string' },
    'plan-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) console.log('Usage: tsx backend/scripts/verify-vector-real.ts --output NEW_DIRECTORY [--env-file EXPLICIT_FILE] [--plan-only]');
  else {
    if (!values['plan-only'] && values['env-file']) loadEnvFile(values['env-file']);
    const report = await verifyVectorReal({ output: values.output ?? 'reports/vector-real-' + new Date().toISOString().replace(/[:.]/gu, '-'), planOnly: values['plan-only'] });
    console.log('Vector verification: ' + report.status + '; dialogue requests=' + report.actual_dialogue_api_requests + '; embedding requests=' + report.actual_embedding_api_requests);
    if (!values['plan-only'] && report.status !== 'completed') process.exitCode = 1;
  }
}
