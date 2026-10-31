import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MiuApplication, type TurnResponse } from '../application.js';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { VectorMemoryService } from '../memory/vector/service.js';
import { OpenAIEmbeddingProvider, type EmbeddingProvider } from '../pipeline/embeddings.js';
import { FATAL_OPENAI_ERROR_CODES, OpenAIProvider } from '../pipeline/providers.js';
import { AppError, type DirectorPlan, type ProviderCheck, type ReplyPrompt } from '../shared/types.js';

const CASES = [
  { name: 'capture_dog_fall', text: 'My dog is named Moki. Moki fell in a puddle.', kind: 'event' },
  { name: 'capture_cat_pot', text: 'Mèo nhà mình tên là Bông. Bông làm đổ chậu cây.', kind: 'event' },
  { name: 'capture_child_story', text: 'My story is called Pip and the Pillow Planet. Pip is a pretend rabbit who lands on a pillow planet.', kind: 'story' },
  { name: 'typed_explicit_dog_name', text: "What is my dog's name?", kind: 'resolved' },
  { name: 'typed_bare_dog', text: 'Do you remember my dog?', kind: 'resolved' },
  { name: 'typed_ambiguous_pet_name', text: "Do you remember my pet's name?", kind: 'ambiguous' },
  { name: 'semantic_known_dog_fall', text: 'Do you remember the pet tumble involving water that I told you about?', kind: 'available' },
  { name: 'semantic_unknown_dog_swim', text: 'Do you recall my dog swimming across a lake?', kind: 'unresolved' },
] as const;
const PLAN = { version: 'vector-pet-router-focused-real-v1', cases: CASES, plannedDialogueTurns: 8,
  maximumDraftsUnderExistingSingleRepairPolicy: 16, maxEmbeddingRequests: 12,
  model: 'text-embedding-3-large', dimensions: 1536, minDenseSimilarity: .30,
  projectionVersion: 'atomic-memory-v2', normalizerVersion: 'nfc-lexical-v2', backend: 'pgvector', queryTimeoutMs: 5_000,
  scope: 'Focused pet identity versus event routing regression, not a full v3 29-case rerun.',
  provenance: 'Transparent delegation records every actual provider.reply draft and provider.check result with its own matching API metadata; returned values, arguments, errors and approval policy are unmodified.' } as const;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
class AssertionFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new AssertionFailure(code); }
const safeError = (error: unknown) => error instanceof AppError ? { code: error.code, status: error.status, generation: error.generation ?? null }
  : { code: error instanceof AssertionFailure ? error.code : 'focused_router_verification_failed' };

/** Real provider delegation only. These overrides never supply answers, change
 * approval, retry, catch-and-fallback, or substitute another provider. */
class AuditedOpenAIProvider extends OpenAIProvider {
  readonly drafts: Record<string, unknown>[] = [];
  readonly checks: Record<string, unknown>[] = [];
  auditContext: { case: string; turnId: string } | null = null;
  override async reply(prompt: ReplyPrompt, plan: DirectorPlan, signal?: AbortSignal): Promise<string> {
    const start = this.telemetry.length; const context = this.auditContext;
    try {
      const text = await super.reply(prompt, plan, signal); const calls = this.telemetry.slice(start);
      const evidence = this.lastReply;
      this.drafts.push({ context, text, evidence: evidence && calls.some(call => call.stage === 'reply' && call.responseId === evidence.responseId) ? evidence : null,
        api_calls: calls, outcome: 'returned' });
      return text;
    } catch (error) { this.drafts.push({ context, error: safeError(error), api_calls: this.telemetry.slice(start), outcome: 'failed' }); throw error; }
  }
  override async check(text: string, plan: DirectorPlan, signal?: AbortSignal, prompt?: ReplyPrompt): Promise<ProviderCheck> {
    const start = this.telemetry.length; const context = this.auditContext;
    try {
      const verdict = await super.check(text, plan, signal, prompt);
      this.checks.push({ context, candidate: text, verdict: structuredClone(verdict), api_calls: this.telemetry.slice(start), outcome: 'returned' });
      return verdict;
    } catch (error) { this.checks.push({ context, candidate: text, error: safeError(error), api_calls: this.telemetry.slice(start), outcome: 'failed' }); throw error; }
  }
}
async function sourceManifest(output: string) {
  const paths = new Set(['backend/application.ts', 'backend/recall.ts', 'backend/pipeline/providers.ts',
    'backend/pipeline/observations.ts', 'backend/pipeline/embeddings.ts', 'backend/scripts/verify-vector-router-real.ts']);
  async function scan(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = path + '/' + entry.name;
      if (entry.isDirectory()) await scan(child);
      else if (/\.(?:ts|sql|json)$/u.test(entry.name) && !entry.name.endsWith('.test.ts')) paths.add(child);
    }
  }
  for (const directory of ['backend/character', 'backend/shared', 'backend/memory']) await scan(directory);
  const hashes: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const bytes = await readFile(path); hashes[path] = createHash('sha256').update(bytes).digest('hex');
    const target = resolve(output, 'source-snapshot', path); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, bytes);
  }
  await writeFile(resolve(output, 'source-snapshot/manifest.json'), JSON.stringify({ source_sha256: hashes }, null, 2) + '\n');
  return hashes;
}

export async function verifyVectorRouterReal(options: { output: string; environment?: Readonly<Record<string, string | undefined>>; planOnly?: boolean }) {
  const env = options.environment ?? process.env;
  if (env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new Error('real_provider_required');
  const output = resolve(options.output); await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const sources = await sourceManifest(output); const started = performance.now();
  const cases: Array<{ name: string; status: string; evidence?: unknown; error?: unknown; elapsed_ms?: number }> = CASES.map(item => ({ name: item.name, status: 'not_attempted' }));
  const turns: Record<string, unknown>[] = []; const labels: Record<string, string[]> = {};
  let provider: AuditedOpenAIProvider | undefined; let embeddings: OpenAIEmbeddingProvider | undefined;
  let memory: MemoryStore | undefined; let service: VectorMemoryService | undefined; let app: MiuApplication | undefined;
  let profileId = ''; let session = ''; let attemptedTurns = 0; let pending: string | null = null;
  let indexing: unknown = null; let blocker: unknown = null; let cleanup = 'not_started'; let changedSources: string[] | null = null;
  const fatal = new Set<string>([...FATAL_OPENAI_ERROR_CODES, 'provider_rate_limited']);
  async function save(status: string) {
    const calls = provider?.telemetry ?? []; const embeddingCalls = embeddings?.telemetry ?? [];
    const report = { run_kind: 'isolated_vector_router_real_regression', status, plan: PLAN, plan_sha256: hash(JSON.stringify(PLAN)),
      provider_requested: 'real', database: 'fresh_in_memory_pglite_pgvector', production_accessed: false,
      source_sha256: sources, changed_source_paths_at_completion: changedSources, labels, indexing,
      generation: service?.generation ?? null, models: provider?.modelIds ?? null, attempted_turns: attemptedTurns,
      actual_dialogue_api_requests: calls.length, actual_embedding_api_requests: embeddingCalls.length,
      actual_reply_drafts: calls.filter(call => call.stage === 'reply' && call.outcome === 'completed').length,
      reply_response_ids: calls.filter(call => call.stage === 'reply' && call.responseId).map(call => call.responseId),
      captured_drafts: provider?.drafts.length ?? 0, captured_checks: provider?.checks.length ?? 0,
      coverage: { passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length,
        blocked: cases.filter(item => item.status === 'blocked').length, not_attempted: cases.filter(item => item.status === 'not_attempted').length },
      cases, blocker, cleanup, elapsed_ms: Math.round(performance.now() - started), semantics: { status: 'needs_separate_review' },
      limitations: ['Eight fresh synthetic typed turns with simulated receipts, age 6-8, EN/VI follow-child; no physical voice/browser testing.',
        'Focused router regression only; full v3 source guards/lifecycle/365-day coverage was not rerun.',
        'Prior v3 had one real repair whose first raw draft was not retained; this run does not reconstruct that missing evidence.',
        'Every native reply/check invocation in this run is recorded, including local checker short circuits and any real constrained repair.'] };
    await writeFile(resolve(output, 'plan.json'), JSON.stringify({ plan: PLAN, sha256: report.plan_sha256 }, null, 2) + '\n');
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    for (const [file, rows] of [['turns.jsonl', turns], ['drafts.jsonl', provider?.drafts ?? []], ['checks.jsonl', provider?.checks ?? []],
      ['api-requests.jsonl', calls], ['embedding-requests.jsonl', embeddingCalls]] as const)
      await writeFile(resolve(output, file), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    return report;
  }
  if (options.planOnly) return save('not_attempted_plan_only');
  function guardFatal() {
    const failed = [...(provider?.telemetry ?? []), ...(embeddings?.telemetry ?? [])].find(call => call.errorCode && fatal.has(call.errorCode));
    if (failed?.errorCode) throw new AppError(failed.errorCode, failed.httpStatus ?? 503);
  }
  try {
    check(env.OPENAI_API_KEY?.trim(), 'missing_openai_key');
    embeddings = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: PLAN.model, dimensions: PLAN.dimensions, timeoutMs: 10_000 });
    const budgeted: EmbeddingProvider = { mode: 'real', model: embeddings.model, dimensions: embeddings.dimensions,
      embed: (inputs, signal) => { check(embeddings!.requestCount < PLAN.maxEmbeddingRequests, 'embedding_budget_exhausted'); return embeddings!.embed(inputs, signal); } };
    provider = new AuditedOpenAIProvider({ apiKey: env.OPENAI_API_KEY, classifyModel: env.OPENAI_CLASSIFY_MODEL,
      replyModel: env.OPENAI_REPLY_MODEL, checkModel: env.OPENAI_CHECK_MODEL, moderationModel: env.OPENAI_MODERATION_MODEL,
      evaluationMode: true, timeoutMs: 60_000 });
    const time = Date.parse('2026-11-01T03:00:00.000Z');
    memory = await createMemoryStore({ vectorExtension: true, now: () => new Date(time), clockMode: 'demo' });
    service = await VectorMemoryService.create(memory, budgeted, { backend: 'pgvector', autoStart: false, evaluationMode: true,
      minDenseSimilarity: PLAN.minDenseSimilarity, queryTimeoutMs: PLAN.queryTimeoutMs, now: () => new Date(time) });
    check(service.generation.model === PLAN.model && service.generation.projectionVersion === PLAN.projectionVersion
      && service.generation.normalizerVersion === PLAN.normalizerVersion, 'wrong_predeclared_generation');
    app = new MiuApplication(memory, provider, () => time, { evaluateRealModel: true, turnTimeoutMs: 180_000, retrieval: service });
    await memory.createProfile({ demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
    await app.bootstrap(); profileId = (await memory.findProfile('an'))!.id; await save('running');
    for (const [index, spec] of CASES.entries()) {
      const entry = cases[index]!;
      if (blocker) { entry.status = 'blocked'; entry.error = blocker; continue; }
      if (index >= 3 && (!labels.capture_dog_fall?.length || !labels.capture_cat_pot?.length || !indexing)) {
        entry.status = 'blocked'; entry.error = { code: 'capture_or_index_precondition_failed' }; continue;
      }
      const caseStarted = performance.now(); const before = provider.telemetry.length; const embeddingStart = embeddings.requestCount;
      const row: Record<string, unknown> = { case: spec.name, input: spec.text, fresh_session: true, delivery: 'not_delivered' };
      try {
        if (session) await app.closeSession(profileId, session);
        session = (await app.openSession('an')).session_id;
        check(attemptedTurns < PLAN.plannedDialogueTurns, 'dialogue_turn_budget_exhausted'); attemptedTurns++;
        const requestId = randomUUID(); pending = requestId; provider.auditContext = { case: spec.name, turnId: requestId };
        const turn: TurnResponse = await app.prepareTurn(profileId, session, { request_id: requestId, kind: 'utterance', text: spec.text });
        const calls = provider.telemetry.slice(before);
        Object.assign(row, { request_id: requestId, response: turn, classification: provider.lastClassification,
          api_calls: calls, embedding_requests: embeddings.telemetry.filter(event => event.sequence > embeddingStart),
          retrieval_diagnostics: service.lastDiagnostics, retrieval_trace: service.lastTrace, delivery: 'prepared' });
        check(turn.provider_mode === 'real' && calls.some(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId), 'actual_model_reply_missing');
        guardFatal();
        if (index < 3) {
          if (spec.name === 'capture_child_story') {
            check(turn.presentation.action?.domain === 'child_story', 'child_story_routed_outside_fiction');
            check(!/(?:don['’]t know|do not know).{0,40}pet['’]s name/iu.test(turn.reply.text), 'false_missing_pet_detour');
          }
        } else if (index < 6) {
          const action = turn.presentation.action;
          check(action?.domain === 'memory' && action.target?.kind === 'pet' && action.target.status === spec.kind, 'typed_identity_not_in_expected_lane');
          check(embeddings.requestCount === embeddingStart && service.lastTrace?.reason === 'typed_lane'
            && service.lastDiagnostics?.embeddingRequested === false, 'typed_identity_triggered_embedding');
          check(!turn.presentation.memoryEvidence?.length, 'semantic_evidence_overrode_typed_identity');
          if (spec.kind === 'resolved') check(/\bMoki\b/u.test(turn.reply.text), 'known_dog_name_not_answered');
        } else {
          check(turn.presentation.action?.domain === 'conversation', 'episode_query_routed_to_identity');
          check(embeddings.telemetry.some(event => event.sequence > embeddingStart && event.outcome === 'completed' && event.requestId), 'episode_query_missing_completed_embedding');
          const cards = turn.presentation.memoryEvidence;
          check(cards && service.lastTrace?.status === spec.kind && !service.lastDiagnostics?.embeddingErrorCode, 'episode_retrieval_status_wrong');
          if (spec.kind === 'available') check(cards.length > 0 && cards.every(card => labels.capture_dog_fall!.includes(card.sourceId)), 'known_fall_source_missing_or_contaminated');
          else {
            check(cards.length === 0 && service.lastTrace.ranked.length === 0, 'unsupported_swim_source_returned');
            check(!/^(?:yes\b|you told me (?:that )?(?:your dog|Moki) swam|(?:your dog|Moki) swam)/iu.test(turn.reply.text), 'unsupported_swim_affirmed');
          }
        }
        for (const status of ['started', 'completed'] as const) await app.playback(profileId, session, turn.turn_id,
          { request_id: randomUUID(), status, state_version: turn.state_version });
        pending = null; row.delivery = 'completed_simulated';
        if (index < 3) {
          const records = await memory.db.query<{ id: string }>('SELECT id FROM memory_records WHERE profile_id=$1 AND source_turn_id=$2 AND kind=$3 ORDER BY id', [profileId, turn.turn_id, spec.kind]);
          check(records.rows.length > 0, 'actual_canonical_capture_missing'); labels[spec.name] = records.rows.map(record => record.id);
          if (index === 2) {
            await service.indexProfile(profileId); const work = await service.flush(4); guardFatal();
            const documents = await memory.db.query('SELECT id,source_id,source_revision,content_hash,document_text FROM memory_search_documents WHERE profile_id=$1 ORDER BY source_id', [profileId]);
            const vectors = await memory.db.query('SELECT document_id,dimensions FROM memory_embeddings WHERE profile_id=$1 AND generation_id=$2', [profileId, service.generation.id]);
            check(Object.values(labels).flat().every(id => documents.rows.some(document => document.source_id === id)), 'capture_not_projected');
            check(documents.rows.length > 0 && documents.rows.every(document => vectors.rows.some(vector => vector.document_id === document.id && vector.dimensions === PLAN.dimensions)), 'source_missing_real_vector');
            indexing = { work, documents: documents.rows, embeddings: vectors.rows };
          }
        }
        entry.status = 'passed'; entry.evidence = { action: turn.presentation.action, memory_evidence: turn.presentation.memoryEvidence ?? [],
          embedding_requests: embeddings.requestCount - embeddingStart, generation: turn.generation };
      } catch (error) {
        try { guardFatal(); } catch (failure) { error = failure; }
        entry.status = 'failed'; entry.error = safeError(error); row.error = safeError(error);
        if (error instanceof AppError && fatal.has(error.code)) blocker = safeError(error);
        if (pending) { try { await app.cancel(profileId, session, pending); } catch { /* Preserve original failure. */ } pending = null; }
      }
      turns.push(row); entry.elapsed_ms = Math.round(performance.now() - caseStarted); console.log(spec.name + ': ' + entry.status); await save('running');
    }
    const completedReplies = provider.telemetry.filter(call => call.stage === 'reply' && call.outcome === 'completed');
    check(completedReplies.every(call => provider!.drafts.some(draft => (draft.evidence as { responseId?: string } | null)?.responseId === call.responseId)), 'actual_reply_draft_not_journaled');
    check(provider.telemetry.filter(call => call.stage === 'check' && call.outcome === 'completed').every(call => provider!.checks.some(verdict =>
      (verdict.api_calls as Array<{ responseId?: string | null }>).some(event => event.responseId === call.responseId))), 'actual_checker_result_not_journaled');
  } catch (error) { blocker = { ...safeError(error), source: 'startup_or_harness' }; }
  finally {
    try { if (pending && app) await app.cancel(profileId, session, pending); await service?.close(); if (app) await app.close(); else await memory?.close(); cleanup = 'closed'; }
    catch { cleanup = 'failed'; blocker ??= { code: 'isolated_cleanup_failed' }; }
    changedSources = [];
    for (const [path, expected] of Object.entries(sources)) if (createHash('sha256').update(await readFile(path)).digest('hex') !== expected) changedSources.push(path);
    if (changedSources.length) blocker ??= { code: 'source_changed_during_run', paths: changedSources };
  }
  const report = await save(blocker || cases.some(entry => entry.status !== 'passed') ? 'completed_with_unresolved_failures' : 'completed');
  await writeFile(resolve(output, 'report.md'), `Focused real router regression: ${report.status}\n\n| Check | Status |\n| --- | --- |\n${cases.map(entry => `| ${entry.name} | ${entry.status} |`).join('\n')}\n\n${report.attempted_turns} actual typed turns; ${report.actual_reply_drafts} actual model drafts, ${report.actual_dialogue_api_requests} dialogue API requests, ${report.actual_embedding_api_requests} embedding requests. Every delegated draft and checker result is recorded. Simulated receipts only; no production accessed. This is not a full v3 rerun; independent semantic review remains separate.\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'env-file': { type: 'string' }, 'plan-only': { type: 'boolean', default: false } } });
  check(values.output, 'output_required'); if (!values['plan-only'] && values['env-file']) loadEnvFile(values['env-file']);
  const report = await verifyVectorRouterReal({ output: values.output, planOnly: values['plan-only'] });
  console.log('Focused router verification: ' + report.status + '; actual turns=' + report.attempted_turns + '; drafts=' + report.actual_reply_drafts);
  if (!values['plan-only'] && report.status !== 'completed') process.exitCode = 1;
}
