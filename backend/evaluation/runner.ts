import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { MiuApplication, type TurnRequest, type TurnResponse } from '../application.js';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { FATAL_OPENAI_ERROR_CODES, OpenAIProvider } from '../pipeline/providers.js';
import { AppError, type DirectorPlan, type Language, type Observation, type Provider, type ProviderClassificationContext, type ReplyPrompt } from '../shared/types.js';
import { SCENARIO_CATALOG_VERSION, validateScenarios } from './catalog.js';
import { EVALUATOR_VERSION, evaluateRun, renderReport } from './evaluate.js';
import { reviewEvidenceHash, reviewKey } from './review-evidence.js';
import type { OperationalResponse, ProviderEvent, Scenario, ScenarioConversation, ScenarioTurn, TurnLog } from './types.js';

const historicalSchema = z.object({
  synthetic: z.literal(true), local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  session_id: z.string(), started_at: z.string(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), timestamp: z.string(), content: z.string().min(1) })).min(2),
});
type HistoricalSession = z.infer<typeof historicalSchema>;
const blockingProviderCodes = new Set<string>([...FATAL_OPENAI_ERROR_CODES, 'provider_rate_limited', 'provider_timeout', 'provider_connection_error', 'provider_unavailable']);
class ProviderEvaluationBlocked extends Error {}
interface EvaluationBlock { code: string; stage: string; scenario_id: string | null; conversation_id: string; turn_id: string }
export interface RunOptions {
  scenarios: Scenario[];
  provider?: 'fake' | 'real';
  /** Unit infrastructure checks only; unavailable in evaluation CLIs. */
  runKind?: 'character_memory_evaluation' | 'harness_self_test';
  /** Explicit injection for integration tests; normal CLI uses the real application providers. */
  providerInstance?: Provider;
  outputDir: string;
  history?: 'full' | 'none';
  historicalPath?: string;
  progress?: (message: string) => void;
}

function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  // Provider/transport error messages may contain request headers. Never put them in logs.
  return 'engine_execution_error';
}

class RecordedProvider implements Provider {
  readonly mode;
  events: ProviderEvent[] = [];
  private apiOffset = 0;
  constructor(private readonly delegate: Provider) { this.mode = delegate.mode; }
  beginTurn() {
    this.events = [];
    this.apiOffset = this.delegate instanceof OpenAIProvider ? this.delegate.telemetry.length : 0;
    if (this.delegate instanceof OpenAIProvider) this.delegate.resetDiagnostics();
  }
  get apiCalls() { return this.delegate instanceof OpenAIProvider ? this.delegate.telemetry.slice(this.apiOffset) : []; }
  get classificationEvidence() { return this.delegate instanceof OpenAIProvider ? this.delegate.lastClassification : null; }
  get modelReply() { return this.delegate instanceof OpenAIProvider ? this.delegate.lastReply : null; }
  private async record<T>(stage: ProviderEvent['stage'], work: () => Promise<T>, describe: (result: T) => unknown): Promise<T> {
    const started = performance.now();
    try {
      const result = await work();
      this.events.push({ stage, elapsed_ms: performance.now() - started, outcome: 'ok', details: describe(result) });
      return result;
    } catch (error) {
      this.events.push({ stage, elapsed_ms: performance.now() - started, outcome: 'error', error_code: errorCode(error) });
      throw error;
    }
  }
  classify(text: string, language: Language, signal?: AbortSignal, context?: ProviderClassificationContext): Promise<Observation> {
    return this.record('classify', () => this.delegate.classify(text, language, signal, context), result => result);
  }
  reply(prompt: ReplyPrompt, plan: DirectorPlan, signal?: AbortSignal): Promise<string> {
    return this.record('reply', () => this.delegate.reply(prompt, plan, signal), text => ({ text }));
  }
  check(text: string, plan: DirectorPlan, signal?: AbortSignal, context?: ReplyPrompt) {
    return this.record('check', () => this.delegate.check(text, plan, signal, context), result => result);
  }
}

export async function loadHistoricalSessions(path = fileURLToPath(new URL('../fixtures/conversations/generated/sessions.jsonl', import.meta.url))): Promise<HistoricalSession[]> {
  const text = await readFile(path, 'utf8');
  const sessions = text.trimEnd().split('\n').map((line, index) => {
    try { return historicalSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Invalid synthetic historical record at line ${index + 1}`); }
  });
  if (sessions.length !== 365 || new Set(sessions.map(session => session.local_date)).size !== 365) throw new Error('Historical fixture must contain 365 unique daily sessions');
  for (const [index, session] of sessions.entries()) {
    if (index > 0 && session.local_date <= sessions[index - 1]!.local_date) throw new Error('Historical dates must be ordered');
    for (const [messageIndex, message] of session.messages.entries()) {
      if (message.role !== (messageIndex % 2 === 0 ? 'user' : 'assistant') || !Number.isFinite(Date.parse(message.timestamp))) throw new Error(`Invalid historical message at ${message.id}`);
    }
  }
  return sessions;
}

export function createRunProvider(mode: 'fake' | 'real'): Provider {
  if (mode !== 'real') throw new Error('Real-model evaluation does not allow fake providers.');
  if (!process.env.OPENAI_API_KEY) throw new Error('Real mode requires OPENAI_API_KEY; load a chosen env file explicitly with Node --env-file.');
  return new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    classifyModel: process.env.OPENAI_CLASSIFY_MODEL,
    replyModel: process.env.OPENAI_REPLY_MODEL,
    checkModel: process.env.OPENAI_CHECK_MODEL,
    moderationModel: process.env.OPENAI_MODERATION_MODEL,
    evaluationMode: true,
    timeoutMs: 60_000,
  });
}

export async function runEvaluation(options: RunOptions): Promise<{ runId: string; outputDir: string; report: ReturnType<typeof evaluateRun>; logCount: number; blocked: EvaluationBlock | null }> {
  if (!options.scenarios.length) throw new Error('At least one evaluation scenario is required.');
  const runKind = options.runKind ?? 'character_memory_evaluation';
  const harnessSelfTest = runKind === 'harness_self_test';
  if (harnessSelfTest && (!process.env.NODE_TEST_CONTEXT || !options.providerInstance)) throw new Error('Harness self-tests require the Node test runner and an explicitly injected test double.');
  if (!harnessSelfTest && options.provider && options.provider !== 'real') throw new Error('Character and memory evaluation requires a real provider; fake is reserved for frontend and pipeline development.');
  const delegate = options.providerInstance ?? createRunProvider('real');
  if (!harnessSelfTest && (!(delegate instanceof OpenAIProvider) || !delegate.evaluationMode)) throw new Error('Character and memory evaluation requires an OpenAIProvider in real-model evaluation mode.');
  validateScenarios(options.scenarios, options.scenarios.length);
  const history = await loadHistoricalSessions(options.historicalPath);
  const byDate = new Map(history.map(session => [session.local_date, session]));
  for (const scenario of options.scenarios) for (const date of scenario.history_dates) {
    if (!byDate.has(date)) throw new Error(`Scenario ${scenario.id} references missing historical date ${date}`);
  }
  const recorded = new RecordedProvider(delegate);
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${recorded.mode}-${randomUUID().slice(0, 8)}`;
  const outputDir = resolve(options.outputDir);
  // Exclusive creation prevents a rerun from silently overwriting previous evidence.
  await mkdir(outputDir, { recursive: false });
  const logFile = await open(resolve(outputDir, 'turns.jsonl'), 'wx');
  const conversationFile = await open(resolve(outputDir, 'conversations.jsonl'), 'wx');
  const transcriptFile = await open(resolve(outputDir, 'transcripts.md'), 'wx');
  const logs: TurnLog[] = [];
  const turnRequests = new Map<string, { profileId: string; request: TurnRequest }>();
  let now = Date.parse(history[0]!.started_at);
  const narrativeOffsets = new Map<'an' | 'binh', number>();
  let memory: MemoryStore | undefined;
  let app: MiuApplication | undefined;
  let currentScenario: string | null = null;
  let blocked: EvaluationBlock | null = null;
  const startedAt = new Date().toISOString();
  const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
  const implementationPaths = ['application.ts', 'recall.ts', 'shared/types.ts', 'shared/semantic-speech.ts', 'shared/affect.ts', 'pipeline/providers.ts', 'pipeline/observations.ts', 'pipeline/language.ts', 'character/action-plan.ts', 'character/learning-activity.ts', 'character/affect.ts', 'character/director.ts', 'character/prompt.ts', 'character/validation.ts', 'character/templates.ts', 'memory/index.ts', 'memory/affect-store.ts', 'memory/database.ts', 'memory/assertions.ts', 'memory/evidence.ts', 'memory/normalization.ts', 'memory/patches.ts', 'evaluation/runner.ts'];
  implementationPaths.push(...(await readdir(new URL('../memory/migrations/', import.meta.url))).filter(path => path.endsWith('.sql')).sort().map(path => `memory/migrations/${path}`));
  const implementationFiles = await Promise.all(implementationPaths.map(async path => ({ path, sha256: fingerprint(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')) })));
  const spec = await readFile(fileURLToPath(new URL('../../docs/product-specification.md', import.meta.url)), 'utf8');
  const manifest = {
    schema_version: 'miu-engine-evaluation-v1', run_id: runId, synthetic: true,
    run_kind: runKind, character_memory_quality_evidence: false,
    status: 'running', started_at: startedAt, completed_at: null as string | null,
    blocked: null as EvaluationBlock | null,
    provider: recorded.mode, audio: false, transport: 'in_process_application',
    database: 'isolated_in_memory_pglite', history: options.history ?? 'none',
    scenario_catalog_version: SCENARIO_CATALOG_VERSION, scenario_count: options.scenarios.length,
    evaluator_version: EVALUATOR_VERSION,
    spec_sha256: fingerprint(spec), scenarios_sha256: fingerprint(JSON.stringify(options.scenarios)),
    history_sha256: fingerprint(JSON.stringify(history)),
    implementation_files: implementationFiles,
    fixture_preconditions: options.scenarios.filter(scenario => scenario.initial_memory).map(scenario => ({ scenario_id: scenario.id, ...scenario.initial_memory })),
    models: delegate instanceof OpenAIProvider ? delegate.modelIds : null,
    limitations: [
      'Text application path only. Playback receipts are simulated by the harness; no audible playback is measured.',
      'Source assistant replies are never inserted as engine output or heard memory.',
      'Each scenario has independent state; selected prior child turns are replayed through the actual application.',
      'Raw text and state are logged only because every record belongs to fictional adult-authored test fixtures.',
      'Rule checks are bounded; semantic rubrics require a separate judge or human review.',
      'Explicit synthetic legacy-memory preconditions test repair only; their authored records are not evidence of learning.',
    ],
  };
  const saveManifest = () => writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const emit = options.progress ?? (() => {});
  async function reset(at: string, scenario?: Scenario) {
    if (app) {
      // Release transient references before resetting this harness-owned database.
      for (const key of ['an', 'binh']) {
        const profile = await memory!.findProfile(key);
        if (profile) await app.getContext(profile.id);
      }
    }
    now = Date.parse(at);
    narrativeOffsets.clear();
    turnRequests.clear();
    if (!Number.isFinite(now)) throw new Error(`Invalid fixture clock: ${at}`);
    if (!memory) memory = await createMemoryStore({ now: () => new Date(now), clockMode: 'demo' });
    else await memory.db.exec('TRUNCATE TABLE profiles CASCADE');
    app = new MiuApplication(memory, recorded, () => now, { evaluateRealModel: !harnessSelfTest, turnTimeoutMs: 180_000 });
    if (scenario?.age_band) {
      for (const [demoKey, displayName] of [['an', 'An'], ['binh', 'Bình']] as const) {
        await memory.createProfile({ demoKey, displayName, ageBand: scenario.age_band, languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
      }
    }
    await app.bootstrap();
    if (scenario?.initial_memory) {
      // The fixture intentionally represents a corrupt legacy report without
      // assertion provenance. It supplies no assistant answer or fake API output.
      const fixture = scenario.initial_memory;
      const profile = await memory.findProfile(fixture.profile);
      const subjectId = randomUUID(); const eventId = randomUUID();
      const source = `fixture:${scenario.id}:legacy`;
      const created = new Date(now).toISOString(); const expires = new Date(now + 30 * 86_400_000).toISOString();
      await memory.db.transaction(async tx => {
        for (const [id, kind] of [[subjectId, 'entity'], [eventId, 'event']]) {
          await tx.query(`INSERT INTO memory_records(id,profile_id,kind,source_turn_id,candidate_key,evidence_kind,scope,created_at,expires_at)
            VALUES($1,$2,$3,$4,$3,'child_reported','reported_real',$5,$6)`, [id, profile!.id, kind, source, created, expires]);
        }
        await tx.query("INSERT INTO entities(profile_id,id,kind,name,normalized_name,species) VALUES($1,$2,'pet',$3,$4,$5)", [profile!.id, subjectId, fixture.pet.name, fixture.pet.name.normalize('NFC').toLocaleLowerCase('vi'), fixture.pet.species]);
        await tx.query("INSERT INTO events(profile_id,id,subject_id,event_type,value,local_date) VALUES($1,$2,$3,'reported_event',$4,$5)", [profile!.id, eventId, subjectId, fixture.event.value, fixture.event.local_date]);
        await tx.query('INSERT INTO memory_dependencies(profile_id,source_id,derived_id) VALUES($1,$2,$3)', [profile!.id, subjectId, eventId]);
        await tx.query('UPDATE profiles SET state_version=state_version+1 WHERE id=$1', [profile!.id]);
      });
    }
  }
  function moveClock(at: string, profile: 'an' | 'binh' = 'an') {
    const next = Date.parse(at) - (narrativeOffsets.get(profile) ?? 0);
    if (!Number.isFinite(next) || next < now) throw new Error(`Fixture attempted to move time backwards: ${at}`);
    now = next;
  }
  const responseEvidence = (response: TurnResponse): OperationalResponse => ({
    turn_id: response.turn_id, session_id: response.session_id,
    state_version: response.state_version, clock_version: response.clock_version,
    reply_text: response.reply.text,
  });
  const providerEvidence = () => ({
    provider_events: structuredClone(recorded.events),
    api_calls: structuredClone(recorded.apiCalls),
    classification_evidence: structuredClone(recorded.classificationEvidence),
    model_reply: structuredClone(recorded.modelReply),
  });
  function clearSessionRequests(sessionId: string) {
    for (const key of turnRequests.keys()) if (key.startsWith(sessionId + '/')) turnRequests.delete(key);
  }
  async function executeTurn(args: {
    phase: TurnLog['phase']; conversationId: string; profile: 'an' | 'binh';
    sessionId: string; profileId: string; turn: ScenarioTurn; sourceMessageId?: string;
    transition?: TurnLog['transition'];
  }): Promise<TurnLog> {
    const { turn, profileId, sessionId } = args;
    recorded.beginTurn();
    const before = await app!.getContext(profileId, sessionId);
    const request = { request_id: randomUUID(), kind: turn.kind ?? 'utterance' as const, ...(turn.text ? { text: turn.text } : {}) };
    turnRequests.set(sessionId + '/' + turn.id, { profileId, request });
    const record: TurnLog = {
      schema_version: 'miu-engine-evaluation-v1', run_id: runId, run_kind: runKind,
      phase: args.phase, scenario_id: currentScenario, conversation_id: args.conversationId,
      turn_spec_id: turn.id, profile_key: args.profile, ...(args.sourceMessageId ? { source_message_id: args.sourceMessageId } : {}),
      input: { kind: request.kind, ...(request.text ? { text: request.text } : {}) },
      at: before.clock.effectiveNow, wall_at: new Date(now).toISOString(), elapsed_ms: 0, provider_mode: recorded.mode,
      response: null, before, after: before, delivery: null, retry: null, error: null,
      operational: { request: { request_id: request.request_id, session_id: sessionId }, original_response: null, retry_response: null },
      provider_events: [], ...(args.transition ? { transition: args.transition } : {}),
      assertions: turn.assertions, rubric: turn.rubric,
    };
    const started = performance.now();
    let stage = 'operational_before';
    let mainEvidence: ReturnType<typeof providerEvidence> | undefined;
    try {
      record.operational!.session_before = await app!.getOperationalState(profileId, sessionId);
      stage = 'prepare';
      const response = await app!.prepareTurn(profileId, sessionId, request);
      record.response = response;
      record.operational!.original_response = responseEvidence(response);
      if (turn.retry === 'turn') {
        stage = 'turn_retry';
        const retry = await app!.prepareTurn(profileId, sessionId, request);
        record.retry = retry;
        record.operational!.retry_response = responseEvidence(retry);
      }
      if (turn.delivery === 'canceled') {
        stage = 'cancel';
        await app!.cancel(profileId, sessionId, response.turn_id);
        record.delivery = { status: 'canceled' };
      } else {
        stage = 'playback_started';
        await app!.playback(profileId, sessionId, response.turn_id, { request_id: randomUUID(), status: 'started', state_version: response.state_version });
        stage = 'playback_final';
        const receipt = { request_id: randomUUID(), status: turn.delivery === 'interrupted' ? 'interrupted' as const : 'completed' as const, state_version: response.state_version };
        const delivery = z.object({ status: z.string(), learning_status: z.string() }).parse(await app!.playback(profileId, sessionId, response.turn_id, receipt));
        record.delivery = { status: receipt.status, receipt_status: delivery.status, learning_status: delivery.learning_status };
        record.operational!.receipt = { request_id: receipt.request_id, status: receipt.status, result: structuredClone(delivery) };
        if (turn.retry === 'receipt') {
          stage = 'receipt_retry';
          record.retry = await app!.playback(profileId, sessionId, response.turn_id, receipt);
        }
      }
      if (turn.probe_stale_replay_of) {
        stage = 'stale_replay_probe';
        mainEvidence = providerEvidence();
        const source = turnRequests.get(sessionId + '/' + turn.probe_stale_replay_of);
        if (!source || source.profileId !== profileId) throw new Error('Missing same-session replay source');
        const callOffset = recorded.apiCalls.length;
        const eventOffset = recorded.events.length;
        const probe: NonNullable<NonNullable<TurnLog['operational']>['stale_replay']> = {
          source_turn_spec_id: turn.probe_stale_replay_of, request_id: source.request.request_id,
          session_id: sessionId, error_code: null, response: null, api_call_count: 0,
        };
        record.operational!.stale_replay = probe;
        try {
          const replay = await app!.prepareTurn(profileId, sessionId, source.request);
          probe.response = responseEvidence(replay);
          // Never play or learn a response unexpectedly generated by this probe.
          try { await app!.cancel(profileId, sessionId, replay.turn_id); } catch { /* Expose the unexpected response even if it was already retired. */ }
        } catch (error) {
          probe.error_code = errorCode(error);
          if (blockingProviderCodes.has(probe.error_code)) record.error = { code: probe.error_code, stage };
          try { await app!.cancel(profileId, sessionId, source.request.request_id); } catch { /* An expected stale request has no active turn. */ }
        }
        probe.api_calls = structuredClone(recorded.apiCalls.slice(callOffset));
        probe.api_call_count = probe.api_calls.length;
        probe.provider_events = structuredClone(recorded.events.slice(eventOffset));
      }
    } catch (error) {
      record.error = { code: errorCode(error), stage };
      if (error instanceof AppError && error.generation) record.generation = error.generation;
      // Release a failed/delivery-blocked turn so later dialogue still runs and is logged.
      try { await app!.cancel(profileId, sessionId, request.request_id); } catch { /* Already retired or session closed. */ }
    }
    record.elapsed_ms = performance.now() - started;
    try { record.after = await app!.getContext(profileId, sessionId); }
    catch (error) {
      record.after_snapshot_error = errorCode(error);
      record.error ??= { code: errorCode(error), stage: 'after_snapshot' };
    }
    try { record.operational!.session_after = await app!.getOperationalState(profileId, sessionId); }
    catch (error) { record.error ??= { code: errorCode(error), stage: 'operational_after' }; }
    Object.assign(record, mainEvidence ?? providerEvidence());
    record.generation ??= record.response?.generation;
    const replyCall = record.api_calls?.find(call => call.stage === 'reply' && call.api === 'responses' && call.outcome === 'completed' && call.responseId && call.responseId === record.model_reply?.responseId);
    record.reply_origin = harnessSelfTest ? 'test_double' : replyCall ? 'model' : record.response ? 'authored_bypass' : 'unavailable';
    logs.push(record);
    await logFile.write(`${JSON.stringify(record)}\n`);
    const label = `${currentScenario ?? 'HISTORY'} / ${args.conversationId} / ${turn.id}`;
    await transcriptFile.write(`\n### ${label}\n\n${record.at} · ${record.provider_mode} · ${record.delivery?.status ?? 'undelivered'}\n\n**Child:** ${request.text ?? '[greeting request]'}\n\n**Miu:** ${record.response?.reply.text ?? '[no approved answer]'}${record.error ? `\n\n**Execution error:** ${record.error.code} (${record.error.stage})` : ''}\n`);
    if (record.error && blockingProviderCodes.has(record.error.code)) {
      blocked = { code: record.error.code, stage: record.error.stage, scenario_id: currentScenario, conversation_id: args.conversationId, turn_id: turn.id };
      throw new ProviderEvaluationBlocked(record.error.code);
    }
    return record;
  }
  async function replayHistorical(session: HistoricalSession, phase: 'history' | 'scenario_history') {
    moveClock(session.started_at);
    const opened = await app!.openSession('an');
    const profileId = app!.profileForToken(opened.demo_token);
    const first = logs.length;
    for (const message of session.messages.filter(message => message.role === 'user')) {
      moveClock(message.timestamp);
      await executeTurn({
        phase, conversationId: session.session_id, profile: 'an', sessionId: opened.session_id, profileId,
        turn: { id: message.id, text: message.content, assertions: [], rubric: [] }, sourceMessageId: message.id,
      });
    }
    await app!.closeSession(profileId, opened.session_id);
    clearSessionRequests(opened.session_id);
    await conversationFile.write(`${JSON.stringify({ phase, scenario_id: currentScenario, conversation_id: session.session_id, profile_key: 'an', at: session.started_at, turns: logs.length - first, errors: logs.slice(first).filter(log => log.error).length })}\n`);
  }
  async function runConversation(conversation: ScenarioConversation) {
    let transition: TurnLog['transition'];
    if (conversation.transition === 'reload') {
      app = new MiuApplication(memory!, recorded, () => now, { evaluateRealModel: !harnessSelfTest, turnTimeoutMs: 180_000 });
      transition = { type: 'reload' };
    } else if (conversation.transition === 'next_day' || conversation.transition === 'next_day_retry') {
      const profile = await memory!.findProfile(conversation.profile);
      const before = await app!.getContext(profile!.id);
      const requestId = randomUUID();
      const first = await app!.nextDay(profile!.id, requestId, before.clock.version);
      const retry = conversation.transition === 'next_day_retry' ? await app!.nextDay(profile!.id, requestId, before.clock.version) : undefined;
      transition = { type: conversation.transition, first, ...(retry ? { retry } : {}) };
      // Next day advances the story clock, not privacy expiry. Align subsequent fixture
      // instants by recording that offset instead of editing any engine-owned clock row.
      narrativeOffsets.set(conversation.profile, Date.parse(first.clock.effectiveNow) - now);
    }
    moveClock(conversation.at, conversation.profile);
    const profile = await memory!.findProfile(conversation.profile);
    if (conversation.config) await app!.updateConfig(profile!.id, conversation.config);
    const opened = await app!.openSession(conversation.profile);
    const profileId = app!.profileForToken(opened.demo_token);
    const first = logs.length;
    for (const [index, turn] of conversation.turns.entries()) {
      moveClock(new Date(Date.parse(conversation.at) + index * 60_000).toISOString(), conversation.profile);
      await executeTurn({ phase: 'scenario', conversationId: conversation.id, profile: conversation.profile, sessionId: opened.session_id, profileId, turn, ...(index === 0 && transition ? { transition } : {}) });
    }
    await app!.closeSession(profileId, opened.session_id);
    clearSessionRequests(opened.session_id);
    await conversationFile.write(`${JSON.stringify({ phase: 'scenario', scenario_id: currentScenario, conversation_id: conversation.id, profile_key: conversation.profile, at: conversation.at, transition: transition ?? null, turns: logs.length - first, errors: logs.slice(first).filter(log => log.error).length })}\n`);
  }
  try {
    await saveManifest();
    await writeFile(resolve(outputDir, 'scenarios.json'), `${JSON.stringify({ version: SCENARIO_CATALOG_VERSION, scenarios: options.scenarios }, null, 2)}\n`);
    await transcriptFile.write(`# Miu engine answers\n\nSynthetic fixtures only. Provider: ${recorded.mode}. These are actual application replies, with simulated text delivery receipts.\n`);
    try {
    if ((options.history ?? 'none') === 'full') {
      await reset(history[0]!.started_at);
      emit(`Replaying ${history.length} historical conversations through the ${recorded.mode} engine.`);
      for (const [index, session] of history.entries()) {
        await replayHistorical(session, 'history');
        if ((index + 1) % 50 === 0) emit(`History: ${index + 1}/${history.length} conversations, ${logs.length} engine answers.`);
      }
    }
    for (const [index, scenario] of options.scenarios.entries()) {
      currentScenario = scenario.id;
      const firstHistorical = scenario.history_dates.length ? byDate.get(scenario.history_dates[0]!) : undefined;
      await reset(firstHistorical?.started_at ?? scenario.conversations[0]!.at, scenario);
      for (const date of scenario.history_dates) await replayHistorical(byDate.get(date)!, 'scenario_history');
      for (const conversation of scenario.conversations) await runConversation(conversation);
      if ((index + 1) % 10 === 0 || index === options.scenarios.length - 1) emit(`Scenarios: ${index + 1}/${options.scenarios.length}; ${logs.length} total recorded turns.`);
    }
    } catch (error) {
      if (!(error instanceof ProviderEvaluationBlocked)) throw error;
      emit(`Real-provider evaluation blocked: ${error.message}. Remaining turns were not attempted.`);
    }
    const report = evaluateRun(logs);
    const reviewTasks = logs.filter(log => log.phase === 'scenario').map(log => ({
      key: reviewKey(log), evidence_sha256: reviewEvidenceHash(log), source: 'human', reviewer: '',
      criteria: log.rubric.map((criterion, index) => ({ index, criterion, status: 'needs_review', evidence: '' })),
      overall: { status: 'needs_review', evidence: '' },
    }));
    await writeFile(resolve(outputDir, 'review-tasks.jsonl'), `${reviewTasks.map(task => JSON.stringify(task)).join('\n')}\n`);
    await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(resolve(outputDir, 'report.md'), renderReport(report));
    manifest.status = blocked ? 'blocked' : 'complete';
    manifest.blocked = blocked;
    manifest.character_memory_quality_evidence = !harnessSelfTest && !blocked && logs.filter(log => log.response).every(log => log.reply_origin === 'model');
    manifest.completed_at = new Date().toISOString();
    await saveManifest();
    return { runId, outputDir, report, logCount: logs.length, blocked };
  } catch (error) {
    manifest.status = 'incomplete';
    manifest.completed_at = new Date().toISOString();
    await saveManifest();
    throw error;
  } finally {
    await logFile.close();
    await conversationFile.close();
    await transcriptFile.close();
    if (app) await app.close();
  }
}
