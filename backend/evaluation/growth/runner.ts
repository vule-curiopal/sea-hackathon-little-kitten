import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MiuApplication } from '../../application.js';
import { createMemoryStore, type MemoryStore } from '../../memory/index.js';
import { atLocalHour, dateDifference } from '../../memory/clock.js';
import { classifyLocal } from '../../pipeline/observations.js';
import { OpenAIProvider } from '../../pipeline/providers.js';
import { AppError, type DirectorPlan, type Language, type Observation, type Provider, type ProviderClassificationContext, type ReplyPrompt } from '../../shared/types.js';
import type { ReferenceSession } from '../../memory/import-history.js';
import type {
  GrowthAPICall, GrowthBlockedReason, GrowthCheck, GrowthDatabaseEvidence, GrowthDayLog, GrowthMaintenanceEvidence, GrowthModelIds,
  GrowthProviderCall, GrowthReplayOptions, GrowthReplayResult, GrowthReplaySummary, GrowthSnapshot, GrowthTurnLog,
} from './types.js';

export type { GrowthReplayOptions, GrowthReplayResult, GrowthReplaySummary } from './types.js';
const VERSION = 'miu-growth-replay-v1' as const;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const date = (value: unknown): string => iso(value).slice(0, 10);
const FATAL_CODES = new Set(['provider_authentication_failed', 'provider_permission_denied', 'provider_model_unavailable', 'provider_quota_exceeded', 'provider_invalid_request', 'provider_network_unavailable', 'provider_timeout', 'provider_rate_limited']);
function fatalProviderError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; status?: unknown; name?: unknown };
  if (typeof value.code === 'string' && FATAL_CODES.has(value.code)) return value.code;
  if (error instanceof AppError) return null;
  if (value.status === 401 || value.code === 'invalid_api_key') return 'provider_authentication_failed';
  if (value.status === 403) return 'provider_permission_denied';
  if (value.status === 404 || value.code === 'model_not_found') return 'provider_model_unavailable';
  if (value.code === 'insufficient_quota' || value.code === 'quota_exceeded') return 'provider_quota_exceeded';
  if (value.status === 429) return 'provider_rate_limited';
  if (value.status === 400) return 'provider_invalid_request';
  if (value.name === 'APIConnectionError') return 'provider_network_unavailable';
  if (value.name === 'APIConnectionTimeoutError') return 'provider_timeout';
  return null;
}
const errorCode = (error: unknown): string => fatalProviderError(error) ?? (error instanceof AppError ? error.code
  : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'growth_execution_error');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const check = (id: string, passed: boolean, evidence: string, expected?: unknown, actual?: unknown): GrowthCheck => ({ id, status: passed ? 'pass' : 'fail', evidence, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) });

class ObservedProvider implements Provider {
  readonly mode: Provider['mode'];
  observation: Observation | null = null;
  calls: GrowthProviderCall[] = [];
  fatal: { stage: string; code: string } | null = null;
  private apiOffset = 0;
  constructor(private readonly delegate: Provider, private readonly models?: Readonly<GrowthModelIds>) { this.mode = delegate.mode; }
  private allAPICalls(): GrowthAPICall[] {
    const source = (this.delegate as Provider & { readonly telemetry?: readonly Record<string, unknown>[] }).telemetry;
    if (!Array.isArray(source)) return [];
    const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    return source.map((event) => ({
      sequence: Number(event.sequence), stage: event.stage as GrowthAPICall['stage'], api: event.api as GrowthAPICall['api'],
      requestedModel: String(event.requestedModel), returnedModel: typeof event.returnedModel === 'string' ? event.returnedModel : null,
      responseId: typeof event.responseId === 'string' ? event.responseId : null, requestId: typeof event.requestId === 'string' ? event.requestId : null,
      startedAt: String(event.startedAt), elapsedMs: Number(event.elapsedMs), outcome: event.outcome as GrowthAPICall['outcome'],
      inputTokens: numberOrNull(event.inputTokens), outputTokens: numberOrNull(event.outputTokens), totalTokens: numberOrNull(event.totalTokens), reasoningTokens: numberOrNull(event.reasoningTokens),
      errorCode: typeof event.errorCode === 'string' ? event.errorCode : null, httpStatus: numberOrNull(event.httpStatus),
    }));
  }
  beginTurn() {
    this.observation = null; this.calls = []; this.fatal = null; this.apiOffset = this.allAPICalls().length;
    (this.delegate as Provider & { resetDiagnostics?: () => void }).resetDiagnostics?.();
  }
  get apiCalls(): GrowthAPICall[] { return this.allAPICalls().slice(this.apiOffset); }
  get classificationEvidence(): unknown | null {
    return (this.delegate as Provider & { readonly lastClassification?: unknown }).lastClassification ?? null;
  }
  get modelReply(): GrowthTurnLog['modelReply'] {
    const reply = (this.delegate as Provider & { readonly lastReply?: { text?: unknown; requestedModel?: unknown; returnedModel?: unknown; responseId?: unknown } | null }).lastReply;
    if (!reply || typeof reply.text !== 'string') return null;
    return { text: reply.text.slice(0, 4000), requestedModel: typeof reply.requestedModel === 'string' ? reply.requestedModel : '', returnedModel: typeof reply.returnedModel === 'string' ? reply.returnedModel : null, responseId: typeof reply.responseId === 'string' ? reply.responseId : null };
  }
  private async record<T>(stage: GrowthProviderCall['stage'], work: () => Promise<T>, mayBypass = false): Promise<T> {
    const started = performance.now(); const offset = this.allAPICalls().length;
    try {
      const result = await work();
      const observed = this.allAPICalls().slice(offset);
      this.calls.push({ stage, outcome: 'ok', elapsedMs: performance.now() - started, model: this.models?.[stage] ?? observed.find((call) => call.stage === stage)?.requestedModel ?? null, authoredBypass: stage === 'reply' && mayBypass && !observed.some((call) => call.stage === 'reply' && call.api === 'responses') });
      return result;
    } catch (error) {
      const code = errorCode(error); const fatal = fatalProviderError(error);
      this.calls.push({ stage, outcome: 'error', elapsedMs: performance.now() - started, model: this.models?.[stage] ?? null, authoredBypass: false, errorCode: code });
      if (fatal) this.fatal = { stage, code: fatal };
      throw error;
    }
  }
  async classify(text: string, language: Language, signal?: AbortSignal, context?: ProviderClassificationContext) {
    const result = await this.record('classify', () => this.delegate.classify(text, language, signal, context));
    this.observation = structuredClone(result);
    return result;
  }
  reply(prompt: ReplyPrompt, plan: DirectorPlan, signal?: AbortSignal) { return this.record('reply', () => this.delegate.reply(prompt, plan, signal), plan.exactText !== null); }
  check(text: string, plan: DirectorPlan, signal?: AbortSignal, context?: ReplyPrompt) { return this.record('check', () => this.delegate.check(text, plan, signal, context)); }
}

function validateSessions(sessions: ReferenceSession[]): void {
  if (!sessions.length) throw new Error('growth_sessions_required');
  let previousTimestamp = -Infinity;
  let previousDate = '';
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.synthetic !== true || session.response_origin !== 'authored_reference' || session.schema_version !== 'miu-synthetic-year-v1' || session.timezone !== 'Asia/Ho_Chi_Minh' || session.profile_id !== sessions[0]!.profile_id) throw new Error('growth_requires_one_synthetic_profile');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(session.local_date) || session.local_date <= previousDate || session.messages.length < 2 || session.messages.length % 2) throw new Error('growth_sessions_not_chronological');
    if (session.started_at !== session.messages[0]!.timestamp || session.ended_at !== session.messages.at(-1)!.timestamp) throw new Error('growth_invalid_session_boundaries');
    previousDate = session.local_date;
    for (const [index, message] of session.messages.entries()) {
      const at = Date.parse(message.timestamp);
      if (!Number.isFinite(at) || at <= previousTimestamp || !message.timestamp.startsWith(session.local_date) || message.role !== (index % 2 ? 'assistant' : 'user') || typeof message.content !== 'string' || !message.content.trim() || ids.has(message.id)) throw new Error('growth_invalid_source_message');
      ids.add(message.id); previousTimestamp = at;
    }
  }
}

/** Direct SQL deliberately avoids getContext's automatic rollover/catch-up. */
async function maintenanceEvidence(memory: MemoryStore, profileId: string, localDate: string): Promise<GrowthMaintenanceEvidence> {
  const row = (await memory.db.query(`SELECT p.state_version,p.deletion_epoch,d.local_date,d.growth_days,d.mood,d.diary_template_id,d.episode_template_id,
    (SELECT count(*) FROM night_job_runs WHERE profile_id=p.id) night_job_count,
    (SELECT count(*) FROM night_job_runs WHERE profile_id=p.id AND local_date=$2) current_date_job_count,
    (SELECT count(*) FROM diary_entries WHERE profile_id=p.id AND local_date=$2) current_date_diary_count,
    (SELECT count(*) FROM daily_states WHERE profile_id=p.id) current_daily_rows
    FROM profiles p LEFT JOIN daily_states d ON d.profile_id=p.id WHERE p.id=$1`, [profileId, localDate])).rows[0]!;
  return {
    nightJobCount: Number(row.night_job_count), currentDateJobCount: Number(row.current_date_job_count),
    currentDateDiaryCount: Number(row.current_date_diary_count), currentDailyRows: Number(row.current_daily_rows),
    dailyDate: row.local_date === null ? null : date(row.local_date), growthDays: row.growth_days === null ? null : Number(row.growth_days),
    dailyMood: row.mood === null ? null : String(row.mood), diaryTemplateId: row.diary_template_id === null ? null : String(row.diary_template_id),
    episodeTemplateId: row.episode_template_id === null ? null : String(row.episode_template_id), stateVersion: Number(row.state_version), deletionEpoch: Number(row.deletion_epoch),
  };
}
async function databaseEvidence(memory: MemoryStore, profileId: string, sourceByTurn: Map<string, string>): Promise<GrowthDatabaseEvidence> {
  // No LIMIT: context's presentation caps must not hide expired records from checks.
  const [recordRows, dependencies, followups, checkpoints, promises, jobs, diaries, counts] = await Promise.all([
    memory.db.query('SELECT * FROM memory_records WHERE profile_id=$1 ORDER BY created_at,id', [profileId]),
    memory.db.query('SELECT source_id,derived_id FROM memory_dependencies WHERE profile_id=$1 ORDER BY source_id,derived_id', [profileId]),
    memory.db.query('SELECT id,source_id,due_local_date,status,question_en,question_vi FROM followups WHERE profile_id=$1 ORDER BY due_local_date,id', [profileId]),
    memory.db.query('SELECT id,template_id,chapter,status FROM story_checkpoints WHERE profile_id=$1 ORDER BY id', [profileId]),
    memory.db.query('SELECT id,checkpoint_id,status FROM promises WHERE profile_id=$1 ORDER BY id', [profileId]),
    memory.db.query('SELECT local_date,completed_at FROM night_job_runs WHERE profile_id=$1 ORDER BY local_date', [profileId]),
    memory.db.query('SELECT id,local_date,template_id FROM diary_entries WHERE profile_id=$1 ORDER BY local_date', [profileId]),
    memory.db.query('SELECT (SELECT count(*) FROM daily_states WHERE profile_id=$1) daily_rows,(SELECT count(*) FROM turn_learning WHERE profile_id=$1) learning_receipts', [profileId]),
  ]);
  const records = recordRows.rows.map((row) => ({ id: String(row.id), kind: String(row.kind), sourceTurnId: String(row.source_turn_id), sourceMessageId: sourceByTurn.get(String(row.source_turn_id)) ?? null, evidenceKind: String(row.evidence_kind), scope: String(row.scope), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) }));
  const kindCounts: Record<string, number> = {};
  for (const record of records) kindCounts[record.kind] = (kindCounts[record.kind] ?? 0) + 1;
  return {
    records, kindCounts,
    dependencies: dependencies.rows.map((row) => ({ sourceId: String(row.source_id), derivedId: String(row.derived_id) })),
    followups: followups.rows.map((row) => ({ id: String(row.id), sourceId: String(row.source_id), dueDate: date(row.due_local_date), status: String(row.status), questionEn: String(row.question_en), questionVi: String(row.question_vi) })),
    checkpoints: checkpoints.rows.map((row) => ({ id: String(row.id), templateId: String(row.template_id), chapter: Number(row.chapter), status: String(row.status) })),
    promises: promises.rows.map((row) => ({ id: String(row.id), checkpointId: String(row.checkpoint_id), status: String(row.status) })),
    nightJobs: jobs.rows.map((row) => ({ date: date(row.local_date), completedAt: iso(row.completed_at) })),
    diaryEntries: diaries.rows.map((row) => ({ id: String(row.id), date: date(row.local_date), templateId: String(row.template_id) })),
    dailyStateRows: Number(counts.rows[0]!.daily_rows), learningReceiptCount: Number(counts.rows[0]!.learning_receipts),
  };
}

export async function runGrowthReplay(options: GrowthReplayOptions): Promise<GrowthReplayResult> {
  const sessions = structuredClone(options.sessions);
  validateSessions(sessions);
  const delegate = options.providerInstance;
  const runKind = options.runKind ?? 'character_memory_evaluation';
  if (runKind !== 'character_memory_evaluation' && runKind !== 'harness_self_test') throw new Error('growth_invalid_run_kind');
  const harnessSelfTest = runKind === 'harness_self_test';
  if (harnessSelfTest && (!process.env.NODE_TEST_CONTEXT || !delegate)) throw new Error('growth_harness_self_test_requires_unit_test_context_and_injected_double');
  if (!delegate || (!harnessSelfTest && (!(delegate instanceof OpenAIProvider) || delegate.mode !== 'real'))) throw new Error('growth_real_provider_required');
  if (!harnessSelfTest && delegate instanceof OpenAIProvider && !delegate.evaluationMode) throw new Error('growth_real_evaluation_mode_required');
  const configuredModels = options.models ?? (delegate as Provider & { readonly modelIds?: Readonly<GrowthModelIds> }).modelIds;
  const models = configuredModels ? Object.freeze({ ...configuredModels }) : undefined;
  const provider = new ObservedProvider(delegate, models);
  const metadataNow = options.now ?? (() => new Date());
  const outputDir = resolve(options.outputDir);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir, { recursive: false });
  const runId = `${metadataNow().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const handles: FileHandle[] = [];
  const days: GrowthDayLog[] = []; const turns: GrowthTurnLog[] = [];
  let wall = atLocalHour(sessions[0]!.local_date, sessions[0]!.timezone, 0).getTime() + 60_000;
  let memory: MemoryStore | undefined; let app: MiuApplication | undefined;
  let blocked: GrowthBlockedReason | null = null;
  const sourceByTurn = new Map<string, string>();
  const manifest = {
    schemaVersion: VERSION, runId, synthetic: true, provider: provider.mode, run_kind: runKind,
    character_memory_quality_evidence: false, models: models ?? null, evaluateRealModel: !harnessSelfTest,
    evidenceClassification: harnessSelfTest ? 'diagnostics_not_model_evaluation' : 'real_model_execution_pending',
    status: 'running', startedAt: metadataNow().toISOString(), completedAt: null as string | null,
    sourceSessions: sessions.length, sourceTurns: sessions.reduce((sum, session) => sum + session.messages.length / 2, 0),
    sourceSha256: createHash('sha256').update(JSON.stringify(sessions)).digest('hex'),
    database: 'one_continuous_isolated_in_memory_pglite', wallClock: 'source_calendar_and_user_timestamps', effectiveClock: 'demo_anchor_follows_same_elapsed_wall_time',
    sourceAssistantPolicy: 'inspection_only_never_used_as_engine_history_or_heard_output',
    delivery: 'simulated_started_then_completed_receipts_at_user_timestamp_no_audio',
    errorCode: null as string | null,
  };
  const saveManifest = () => writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  try {
    const [dayFile, turnFile, snapshotFile] = await Promise.all(['days.jsonl','turns.jsonl','snapshots.jsonl'].map(async (name) => { const handle = await open(join(outputDir, name), 'wx'); handles.push(handle); return handle; }));
    await saveManifest();
    memory = await createMemoryStore({ now: () => new Date(wall), clockMode: 'demo' });
    app = new MiuApplication(memory, provider, () => wall, { evaluateRealModel: !harnessSelfTest, turnTimeoutMs: options.turnTimeoutMs ?? 180_000 });
    await app.bootstrap();
    const profile = await memory.findProfile('an');
    if (!profile) throw new Error('growth_profile_missing');
    const profileId = profile.id;
    let previousSnapshot: GrowthSnapshot | null = null;
    let finalSnapshot: GrowthSnapshot | null = null;
    let sessionLanguage: Language = 'en';
    const initialConfig = (await app.getContext(profileId)).config;
    const snapshot = async (): Promise<GrowthSnapshot> => ({ at: new Date(wall).toISOString(), context: await app!.getContext(profileId), evidence: await databaseEvidence(memory!, profileId, sourceByTurn) });

    for (const [dayIndex, source] of sessions.entries()) {
      wall = atLocalHour(source.local_date, source.timezone, 0).getTime() + 60_000;
      const maintenanceAt = new Date(wall).toISOString();
      const maintenanceErrors: { stage: string; code: string }[] = [];
      const beforeMaintenance = await maintenanceEvidence(memory, profileId, source.local_date);
      try { await app.maintain(); } catch (error) { maintenanceErrors.push({ stage: 'maintain', code: errorCode(error) }); }
      // Observe scheduler effects before getContext/openSession can catch up.
      const afterMaintenance = await maintenanceEvidence(memory, profileId, source.local_date);
      let repeatedJobApplied: boolean | null = null;
      try {
        await app.maintain();
        repeatedJobApplied = (await memory.runNightJob(profileId)).applied;
      } catch (error) { maintenanceErrors.push({ stage: 'repeat_maintain', code: errorCode(error) }); }
      const repeatedMaintenance = await maintenanceEvidence(memory, profileId, source.local_date);
      const before = await snapshot();
      await snapshotFile!.write(JSON.stringify({ date: source.local_date, phase: 'before', ...before }) + '\n');
      wall = Date.parse(source.started_at);
      let sessionId: string | null = null;
      let sessionOpenError: string | null = null;
      try { sessionId = (await app.openSession('an')).session_id; sessionLanguage = 'en'; }
      catch (error) { sessionOpenError = errorCode(error); }
      const dayTurns: GrowthTurnLog[] = [];
      for (let index = 0; index < source.messages.length; index += 2) {
        const user = source.messages[index]!; const reference = source.messages[index + 1]!;
        wall = Date.parse(user.timestamp);
        provider.beginTurn();
        const turnId = randomUUID(); sourceByTurn.set(turnId, user.id);
        const pre = await snapshot();
        const log: GrowthTurnLog = {
          schemaVersion: VERSION, run_kind: runKind, character_memory_quality_evidence: false,
          dayIndex, date: source.local_date, sourceSessionId: source.session_id, sourceMessageId: user.id, referenceMessageId: reference.id,
          sourceUserTimestamp: user.timestamp, referenceTimestamp: reference.timestamp, referenceReply: reference.content,
          turnId, input: { kind: 'utterance', text: user.content }, at: new Date(wall).toISOString(), providerMode: provider.mode, elapsedMs: 0,
          providerCalls: [], apiCalls: [], replyOrigin: 'unavailable', classificationEvidence: null, modelReply: null,
          response: null, before: pre.context, after: pre.context, localObservation: classifyLocal(user.content, sessionLanguage), providerObservation: null,
          delivery: { status: 'failed', started: false, completed: false, receiptStatus: null, learningStatus: null },
          error: null, recoveryError: null, afterSnapshotError: null, createdRecordIds: [], removedRecordIds: [], recordCountBefore: pre.evidence.records.length, recordCountAfter: pre.evidence.records.length,
        };
        let stage = 'session_open'; const started = performance.now();
        try {
          if (!sessionId) throw new AppError(sessionOpenError ?? 'growth_session_unavailable', 503);
          stage = 'prepare';
          const response = await app.prepareTurn(profileId, sessionId, { request_id: turnId, kind: 'utterance', text: user.content });
          log.response = response; sessionLanguage = response.reply.language;
          stage = 'playback_started';
          await app.playback(profileId, sessionId, turnId, { request_id: randomUUID(), status: 'started', state_version: response.state_version });
          log.delivery.started = true;
          stage = 'playback_completed';
          const receipt = await app.playback(profileId, sessionId, turnId, { request_id: randomUUID(), status: 'completed', state_version: response.state_version }) as { status?: string; learning_status?: string };
          log.delivery = { status: 'completed', started: true, completed: true, receiptStatus: receipt.status ?? null, learningStatus: receipt.learning_status ?? null };
        } catch (error) {
          log.error = { stage, code: errorCode(error) };
          const fatal = provider.fatal ?? (fatalProviderError(error) ? { stage, code: fatalProviderError(error)! } : null);
          if (fatal) blocked = { date: source.local_date, sourceMessageId: user.id, stage: fatal.stage, code: fatal.code };
          if (sessionId) { try { await app.cancel(profileId, sessionId, turnId); } catch (cancelError) { log.recoveryError = errorCode(cancelError); } }
        }
        log.elapsedMs = performance.now() - started;
        log.providerObservation = provider.observation;
        log.providerCalls = structuredClone(provider.calls);
        log.apiCalls = provider.apiCalls;
        log.classificationEvidence = provider.observation === null ? null : provider.classificationEvidence;
        log.modelReply = provider.modelReply;
        const modelReply = log.modelReply !== null && log.modelReply.text.trim().length > 0
          && log.apiCalls.some((call) => call.api === 'responses' && call.stage === 'reply' && call.outcome === 'completed' && call.responseId !== null && call.responseId === log.modelReply!.responseId);
        log.replyOrigin = harnessSelfTest ? 'test_double' : modelReply ? 'model' : log.response ? (log.providerCalls.some((call) => call.stage === 'reply') ? 'unverified' : 'authored_bypass') : 'unavailable';
        if (!harnessSelfTest && log.providerCalls.some((call) => call.stage === 'reply' && call.authoredBypass)) log.replyOrigin = 'authored_bypass';
        log.character_memory_quality_evidence = !harnessSelfTest && log.replyOrigin === 'model';
        try {
          const post = await snapshot(); log.after = post.context; log.recordCountAfter = post.evidence.records.length;
          const priorIds = new Set(pre.evidence.records.map((record) => record.id)); const nextIds = new Set(post.evidence.records.map((record) => record.id));
          log.createdRecordIds = post.evidence.records.filter((record) => !priorIds.has(record.id) && record.sourceTurnId === turnId).map((record) => record.id);
          log.removedRecordIds = [...priorIds].filter((id) => !nextIds.has(id));
        } catch (error) { log.afterSnapshotError = errorCode(error); }
        turns.push(log); dayTurns.push(log);
        await turnFile!.write(JSON.stringify(log) + '\n');
        if (blocked) break;
      }
      if (sessionId) { try { await app.closeSession(profileId, sessionId); } catch (error) { maintenanceErrors.push({ stage: 'close_session', code: errorCode(error) }); } }
      if (!blocked) wall = Date.parse(source.ended_at);
      const after = await snapshot(); finalSnapshot = after;
      await snapshotFile!.write(JSON.stringify({ date: source.local_date, phase: 'after', ...after }) + '\n');
      const currentIds = new Set(before.evidence.records.map((record) => record.id));
      const expired = previousSnapshot?.evidence.records.filter((record) => Date.parse(record.expiresAt) <= Date.parse(before.at)).map((record) => record.id) ?? [];
      const removedSincePrevious = previousSnapshot?.evidence.records.filter((record) => !currentIds.has(record.id)).map((record) => record.id) ?? [];
      const expectedGrowth = dateDifference(sessions[0]!.local_date, source.local_date);
      const expectedNewJobs = dayIndex === 0 ? 0 : 1;
      const checks: GrowthCheck[] = [
        check('maintenance_completed', maintenanceErrors.length === 0, 'Actual maintenance and session cleanup errors are recorded.', [], maintenanceErrors),
        check('scheduler_applied_before_context', afterMaintenance.nightJobCount - beforeMaintenance.nightJobCount === expectedNewJobs && afterMaintenance.currentDateJobCount === 1 && afterMaintenance.dailyDate === source.local_date, 'Direct SQL before/after maintain; context catch-up has not run.', { newJobs: expectedNewJobs, dateReceipts: 1, dailyDate: source.local_date }, { newJobs: afterMaintenance.nightJobCount - beforeMaintenance.nightJobCount, dateReceipts: afterMaintenance.currentDateJobCount, dailyDate: afterMaintenance.dailyDate }),
        check('daily_update_is_idempotent', repeatedJobApplied === false && same(afterMaintenance, repeatedMaintenance), 'Repeating maintain and the night job preserves date, mood, diary, counters, and versions.', false, repeatedJobApplied),
        check('one_diary_and_current_daily_state', afterMaintenance.currentDateDiaryCount === 1 && afterMaintenance.currentDailyRows === 1 && after.evidence.dailyStateRows === 1, 'One current mood row and one diary for this date.', { diary: 1, daily: 1 }, { diary: afterMaintenance.currentDateDiaryCount, daily: after.evidence.dailyStateRows }),
        check('growth_matches_elapsed_calendar', before.context.daily.growthDays === expectedGrowth && after.context.daily.growthDays === expectedGrowth, 'Fictional growth follows elapsed calendar dates in one continuous profile.', expectedGrowth, after.context.daily.growthDays),
        check('effective_clock_tracks_source_date', before.context.clock.localDate === source.local_date && after.context.clock.localDate === source.local_date && Date.parse(after.context.clock.effectiveNow) === wall, 'Both privacy wall time and narrative effective time advance; no daily state reset.', source.local_date, after.context.clock.localDate),
        check('expired_sources_are_removed', expired.every((id) => !currentIds.has(id)), 'All records from the prior snapshot are considered; presentation limits cannot hide expired data.', 0, expired.filter((id) => currentIds.has(id)).length),
        check('active_records_obey_retention', after.evidence.records.every((record) => Date.parse(record.expiresAt) > wall && Date.parse(record.createdAt) <= wall), 'Full SQL record evidence uses simulated real time, independent of context limits.', 0, after.evidence.records.filter((record) => Date.parse(record.expiresAt) <= wall || Date.parse(record.createdAt) > wall).length),
        check('canon_and_configuration_stable', same(after.context.config, initialConfig), 'Daily growth cannot silently replace Miu canon or the family configuration.', initialConfig, after.context.config),
        check('all_source_turns_attempted', dayTurns.length === source.messages.length / 2, 'Every child message gets a logged application attempt, including failures.', source.messages.length / 2, dayTurns.length),
        check('completed_turns_have_playback_and_learning', dayTurns.filter((turn) => turn.delivery.completed).every((turn) => turn.delivery.started && turn.delivery.receiptStatus === 'completed' && turn.delivery.learningStatus === 'complete'), 'Only started+completed simulated delivery establishes learned turns.'),
      ];
      const dayLog: GrowthDayLog = {
        schemaVersion: VERSION, dayIndex, date: source.local_date, sourceSessionId: source.session_id,
        sourceAnnotation: { language: source.language, childMood: source.child_mood, miuMood: source.miu_daily_mood, tags: source.tags },
        maintenance: { at: maintenanceAt, before: beforeMaintenance, after: afterMaintenance, repeated: repeatedMaintenance, repeatedJobApplied, errors: maintenanceErrors },
        before: before.context, after: after.context, beforeRecordIds: before.evidence.records.map((record) => record.id), afterRecordIds: after.evidence.records.map((record) => record.id),
        expiredSincePreviousDay: expired, removedSincePreviousDay: removedSincePrevious,
        sourceTurns: source.messages.length / 2, completedTurns: dayTurns.filter((turn) => turn.delivery.completed).length, errors: dayTurns.filter((turn) => turn.error || turn.afterSnapshotError).length,
        createdRecordIds: [...new Set(dayTurns.flatMap((turn) => turn.createdRecordIds))], checks,
      };
      days.push(dayLog); await dayFile!.write(JSON.stringify(dayLog) + '\n'); previousSnapshot = after;
      options.progress?.({ day: dayIndex + 1, total: sessions.length, date: source.local_date, turns: turns.length, errors: turns.filter((turn) => turn.error || turn.afterSnapshotError).length });
      if (blocked) break;
    }
    if (!finalSnapshot) throw new Error('growth_final_snapshot_missing');
    const errorCodes: Record<string, number> = {}; const friendshipStages: Record<string, number> = {};
    for (const turn of turns) if (turn.error) errorCodes[turn.error.code] = (errorCodes[turn.error.code] ?? 0) + 1;
    for (const day of days) friendshipStages[day.after.friendship] = (friendshipStages[day.after.friendship] ?? 0) + 1;
    const failures = days.flatMap((day) => day.checks.filter((item) => item.status === 'fail').map((item) => ({ date: day.date, id: item.id, evidence: item.evidence })));
    const sourceTurns = sessions.reduce((sum, session) => sum + session.messages.length / 2, 0);
    const providerCallCounts = { classify: 0, reply: 0, check: 0 };
    const apiCallCounts = { classify: 0, reply: 0, check: 0, moderation_input: 0, moderation_output: 0 };
    for (const turn of turns) {
      for (const call of turn.providerCalls) providerCallCounts[call.stage]++;
      for (const call of turn.apiCalls) if (call.stage in apiCallCounts) apiCallCounts[call.stage]++;
    }
    const modelAuthoredTurns = turns.filter((turn) => turn.replyOrigin === 'model').length;
    const authoredReplyBypasses = turns.filter((turn) => turn.replyOrigin === 'authored_bypass').length;
    const unverifiedReplyTurns = turns.filter((turn) => turn.replyOrigin === 'unverified').length;
    const qualityEvidence = !harnessSelfTest && modelAuthoredTurns > 0
      && turns.filter((turn) => turn.response !== null).every((turn) => turn.replyOrigin === 'model');
    const summary: GrowthReplaySummary = {
      schemaVersion: VERSION, runId, synthetic: true, provider: provider.mode,
      run_kind: runKind, character_memory_quality_evidence: qualityEvidence,
      status: blocked ? 'blocked' : 'complete', blocked, processedSessions: days.length,
      models: models ?? null, providerCallCounts, apiCallCounts, modelAuthoredTurns, authoredReplyBypasses, unverifiedReplyTurns,
      outputDir, from: sessions[0]!.local_date, to: sessions.at(-1)!.local_date,
      sessions: sessions.length, sourceTurns, attemptedTurns: turns.length, completedTurns: turns.filter((turn) => turn.delivery.completed).length, turnErrors: turns.filter((turn) => turn.error || turn.afterSnapshotError).length,
      firstGrowthDay: days[0]!.before.daily.growthDays, finalGrowthDay: finalSnapshot.context.daily.growthDays, nightJobCount: finalSnapshot.evidence.nightJobs.length,
      distinctDiaryTemplates: new Set(days.map((day) => day.after.daily.diary.templateId)).size, distinctGrowthThemes: new Set(days.map((day) => day.after.daily.growthTheme)).size, friendshipStages,
      recordsCreatedDuringTurns: new Set(turns.flatMap((turn) => turn.createdRecordIds)).size, recordsRemovedDuringTurns: new Set(turns.flatMap((turn) => turn.removedRecordIds)).size, finalActiveRecords: finalSnapshot.evidence.records.length,
      dayChecks: { pass: days.flatMap((day) => day.checks).filter((item) => item.status === 'pass').length, fail: failures.length }, failures, errorCodes,
      checks: [
        check('complete_source_replay', turns.length === sourceTurns, 'Every source child turn is attempted exactly once.', sourceTurns, turns.length),
        check('all_source_turns_completed', turns.every((turn) => turn.delivery.completed && !turn.error && !turn.afterSnapshotError), 'Response and receipt failures remain visible; failures never become successful delivery.', sourceTurns, turns.filter((turn) => turn.delivery.completed).length),
        check('one_job_per_source_date', finalSnapshot.evidence.nightJobs.length === sessions.length && sessions.every((session) => finalSnapshot!.evidence.nightJobs.filter((job) => job.date === session.local_date).length === 1), 'One completed night-job receipt for each replayed source date.', sessions.length, finalSnapshot.evidence.nightJobs.length),
        check('actual_model_reply_requested_for_each_turn', turns.length === sourceTurns && turns.every((turn) => turn.apiCalls.some((call) => call.api === 'responses' && call.stage === 'reply')), 'Requires observable API request evidence, not only a provider method call.', sourceTurns, turns.filter((turn) => turn.apiCalls.some((call) => call.api === 'responses' && call.stage === 'reply')).length),
        check('published_replies_have_model_evidence', turns.some((turn) => turn.response !== null) && turns.filter((turn) => turn.response !== null).every((turn) => turn.replyOrigin === 'model'), 'Nonempty model reply text and its matching completed API response ID establish model authorship; authored bypasses, empty outputs, and unverified replies do not pass.', 0, authoredReplyBypasses + unverifiedReplyTurns),
      ],
      limitations: [
        harnessSelfTest
          ? 'Harness self-test with an explicitly injected double: no character quality, memory quality, or model performance evidence. Exclude all passes from behavioral acceptance and quality comparisons.'
          : 'Real model text application only; speech synthesis, audible playback, and voice latency are not measured.',
        'Provider method calls and underlying API requests are counted separately; only completed reply API responses with IDs establish model authorship.',
        'Playback is simulated with real application receipt semantics; no audio is generated or heard.',
        'Reference assistant text and authored mood labels are inspection data only, never runtime replies, memory evidence, or inferred child emotion.',
        'A growing day count and correct transactions do not prove nuanced character development or semantic answer quality.',
        'Friendship stages are reported without assuming every visit grants familiarity or nickname permission.',
        'Synthetic source text and bounded context are logged for analysis; the full SQL record list avoids masking retention defects.',
      ],
    };
    await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(outputDir, 'final-snapshot.json'), JSON.stringify(finalSnapshot, null, 2) + '\n');
    manifest.status = blocked ? 'blocked' : 'complete'; manifest.errorCode = blocked?.code ?? null;
    manifest.character_memory_quality_evidence = qualityEvidence;
    manifest.evidenceClassification = qualityEvidence ? 'real_model_replay' : 'diagnostics_not_model_evaluation';
    manifest.completedAt = metadataNow().toISOString(); await saveManifest();
    return { outputDir, summary, days, turns, finalSnapshot };
  } catch (error) {
    manifest.status = 'failed'; manifest.errorCode = errorCode(error); manifest.completedAt = metadataNow().toISOString(); await saveManifest(); throw error;
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    if (app) await app.close(); else if (memory) await memory.close();
  }
}
