import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MiuApplication, type TurnRequest, type TurnResponse } from '../application.js';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { FATAL_OPENAI_ERROR_CODES, OpenAIProvider, type OpenAIRequestTelemetry } from '../pipeline/providers.js';
import type { AffectSnapshot, AffectVector } from '../shared/affect.js';
import { AppError } from '../shared/types.js';

const CASES = ['happy_heard_and_idempotent', 'scared_interrupted', 'happy_canceled', 'no_save_frustrated_heard',
  'sad_heard', 'half_life_and_session_reopen', 'forget_request', 'forget_confirmation', 'next_day_reset', 'binh_isolation'] as const;
type CaseName = typeof CASES[number];
type CaseResult = { name: CaseName; status: 'not_attempted' | 'passed' | 'failed' | 'blocked'; elapsed_ms?: number; evidence?: unknown; error?: unknown };
type State = { affect: AffectSnapshot; receipts: number; profile_version: number; clock_version: number; local_date: string; growth_days: number };
class AssertionFailure extends Error { constructor(readonly code: string) { super(code); } }
const check = (condition: unknown, code: string): void => { if (!condition) throw new AssertionFailure(code); };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const close = (left: number, right: number) => Math.abs(left - right) <= 1e-9;
const bounded = (vector: AffectVector) => Number.isFinite(vector.valence) && vector.valence >= -1 && vector.valence <= 1
  && Number.isFinite(vector.energy) && vector.energy >= 0 && vector.energy <= 1;
const changed = (left: AffectVector, right: AffectVector) => !close(left.valence, right.valence) || !close(left.energy, right.energy);
function safeError(error: unknown) {
  return error instanceof AppError ? { code: error.code, status: error.status, invalidation: error.invalidation ?? null }
    : { code: error instanceof AssertionFailure ? error.code : 'affect_verification_failed' };
}
function unchanged(before: State, after: State, code: string) {
  check(same(before.affect, after.affect) && before.receipts === after.receipts, code);
}
function comfort(turn: TurnResponse) {
  const affect = turn.presentation.affect;
  check(turn.presentation.comfortActive === true && affect?.reason === 'comfort_override'
    && affect.delivery === 'gentle' && affect.emotion === 'gentle' && affect.energy <= .35
    && turn.presentation.allowPurr !== true && turn.presentation.allowGiggle !== true
    && turn.presentation.face.gesture !== 'small_bounce', 'comfort_policy_not_authoritative');
}

export async function verifyAffectReal(options: {
  output: string; environment?: Readonly<Record<string, string | undefined>>;
  planOnly?: boolean; blockedReason?: string;
}) {
  const env = options.environment ?? process.env;
  if (env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new Error('real_provider_required');
  const output = resolve(options.output);
  await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const started = performance.now();
  const cases: CaseResult[] = CASES.map(name => ({ name, status: 'not_attempted' }));
  const turns: Record<string, unknown>[] = [];
  const states: Record<string, State> = {};
  const sourceHashes: Record<string, string> = {};
  for (const path of ['backend/application.ts', 'backend/shared/affect.ts', 'backend/character/affect.ts',
    'backend/memory/index.ts', 'backend/memory/affect-store.ts', 'backend/pipeline/providers.ts',
    'backend/pipeline/observations.ts', 'backend/memory/migrations/008_character_affect.sql']) {
    sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  let provider: OpenAIProvider | undefined;
  let memory: MemoryStore | undefined;
  let app: MiuApplication | undefined;
  let blocker: unknown = options.blockedReason ? { code: options.blockedReason, source: 'operator_supplied_before_requests' } : null;
  let time = Date.parse('2026-11-01T03:00:00.000Z');
  let an = ''; let binh = ''; let session = '';
  let binhInitial: State | undefined;
  let afterSad: State | undefined;
  let beforeForget: State | undefined;
  let currentCase: CaseName | undefined;
  const pending = new Set<string>();

  async function save(status: string) {
    const calls = provider?.telemetry ?? [];
    const report = {
      run_kind: 'isolated_affect_real_provider_verification', status, provider_requested: 'real',
      database: 'fresh_in_memory_pglite', production_accessed: false, fake_provider_constructed: false,
      ordinary_turn_time_frozen: true, initial_controlled_time: '2026-11-01T03:00:00.000Z',
      final_controlled_time: new Date(time).toISOString(), elapsed_ms: Math.round(performance.now() - started),
      source_sha256: sourceHashes, planned_new_model_turns: 7,
      coverage: { passed: cases.filter(item => item.status === 'passed').length,
        failed: cases.filter(item => item.status === 'failed').length,
        blocked: cases.filter(item => item.status === 'blocked').length,
        not_attempted: cases.filter(item => item.status === 'not_attempted').length },
      actual_api_requests_this_run: calls.length,
      completed_model_reply_ids: calls.filter(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId).map(call => call.responseId),
      models: provider?.modelIds ?? null, blocker, cases, states,
      semantics: { status: 'needs_human_review', note: 'State assertions and approved affect/comfort metadata are checked. Recorded real model words require separate semantic review; arithmetic and checker approval alone do not establish dialogue quality.' },
      limitations: ['Typed synthetic inputs only. Delivery receipts are simulated; no physical microphone or playback is tested.',
        'No production session, PostgreSQL connection, authored reference answer, fake provider, or model fallback is used.',
        'Cached prepare and duplicate receipt are idempotency checks; they do not count as additional model-generated replies.',
        'A new-day mood may legitimately repeat its label. Cancellation/no-save cases require the earlier positive completed-delivery control.'],
    };
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'turns.jsonl'), turns.map(turn => JSON.stringify(turn)).join('\n') + (turns.length ? '\n' : ''));
    await writeFile(resolve(output, 'api-requests.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + (calls.length ? '\n' : ''));
    await writeFile(resolve(output, 'report.md'), `Real affect verification: ${status}\n\n| Check | Status |\n| --- | --- |\n${cases.map(item => `| ${item.name} | ${item.status} |`).join('\n')}\n\nActual API requests in this run: ${calls.length}. Semantic review: unperformed. No production accessed.\n`);
    return report;
  }
  if (options.planOnly || options.blockedReason) return save(options.blockedReason ? 'blocked_before_requests' : 'not_attempted_plan_only');

  async function state(label: string, profileId = an): Promise<State> {
    const context = await app!.getContext(profileId);
    check(context.affect && bounded(context.affect.baseline) && bounded(context.affect.conversation) && bounded(context.affect.current), 'missing_or_unbounded_affect');
    const receipts = await memory!.db.query<{ count: string }>('SELECT count(*)::text AS count FROM character_affect_receipts WHERE profile_id=$1', [profileId]);
    const value = { affect: context.affect!, receipts: Number(receipts.rows[0]!.count), profile_version: context.profile.stateVersion,
      clock_version: context.clock.version, local_date: context.clock.localDate, growth_days: context.daily.growthDays };
    states[label] = value; return value;
  }
  async function prepare(text: string) {
    const request: TurnRequest = { request_id: randomUUID(), kind: 'utterance', text };
    const before = provider!.telemetry.length;
    const row: Record<string, unknown> = { case: currentCase, request_id: request.request_id, input: text, controlled_time: new Date(time).toISOString() };
    const modelReply = (calls: readonly OpenAIRequestTelemetry[]) => {
      const reply = provider!.lastReply;
      return reply && calls.some(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId === reply.responseId) ? reply : null;
    };
    pending.add(request.request_id);
    try {
      const turn = await app!.prepareTurn(an, session, request);
      const calls = provider!.telemetry.slice(before);
      check(turn.provider_mode === 'real' && calls.some(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId), 'new_turn_missing_actual_reply_provenance');
      check(turn.presentation.affect && bounded(turn.presentation.affect), 'prepared_affect_missing_or_unbounded');
      check(Math.abs(turn.presentation.affect!.variation.valence) <= .05 && Math.abs(turn.presentation.affect!.variation.energy) <= .05, 'variation_out_of_bounds');
      Object.assign(row, { response: turn, classification: provider!.lastClassification, api_calls: calls,
        model_reply: modelReply(calls), semantic_status: 'needs_human_review' });
      return { turn, request };
    } catch (error) {
      const calls = provider!.telemetry.slice(before);
      Object.assign(row, { error: safeError(error), api_calls: calls, model_reply: modelReply(calls) });
      throw error;
    } finally { turns.push(row); }
  }
  async function receipt(turn: TurnResponse, status: 'started' | 'completed' | 'interrupted', requestId = randomUUID()) {
    const value = { request_id: requestId, status, state_version: turn.state_version };
    const result = await app!.playback(an, session, turn.turn_id, value);
    if (status !== 'started') pending.delete(turn.turn_id);
    return { value, result };
  }
  async function complete(turn: TurnResponse) { await receipt(turn, 'started'); return receipt(turn, 'completed'); }
  async function run(name: CaseName, work: () => Promise<unknown>, dependencies: CaseName[] = []) {
    const entry = cases.find(item => item.name === name)!;
    const dependency = dependencies.find(name => cases.find(item => item.name === name)?.status !== 'passed');
    if (blocker || dependency) { entry.status = 'blocked'; entry.error = blocker ?? { code: 'dependency_not_passed', dependency }; return; }
    currentCase = name; const start = performance.now();
    try { entry.evidence = await work(); entry.status = 'passed'; }
    catch (error) {
      entry.status = 'failed'; entry.error = safeError(error);
      if (error instanceof AppError && ((FATAL_OPENAI_ERROR_CODES as readonly string[]).includes(error.code) || error.code === 'provider_rate_limited')) blocker = { ...safeError(error), source: 'actual_request' };
      for (const id of pending) { try { await app!.cancel(an, session, id); } catch { /* Preserve original failure. */ } pending.delete(id); }
      try { await state(name + '_after_failure'); } catch { /* The failure already has captured request provenance. */ }
    }
    entry.elapsed_ms = Math.round(performance.now() - start); console.log(name + ': ' + entry.status); await save('running');
  }
  try {
    if (!env.OPENAI_API_KEY?.trim()) throw new AppError('missing_openai_key', 503);
    provider = new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, classifyModel: env.OPENAI_CLASSIFY_MODEL, replyModel: env.OPENAI_REPLY_MODEL,
      checkModel: env.OPENAI_CHECK_MODEL, moderationModel: env.OPENAI_MODERATION_MODEL, timeoutMs: 60000, evaluationMode: true });
    memory = await createMemoryStore({ now: () => new Date(time), clockMode: 'demo' });
    app = new MiuApplication(memory, provider, () => time, { evaluateRealModel: true, turnTimeoutMs: 180000 });
    for (const [demoKey, displayName] of [['an', 'An'], ['binh', 'Bình']] as const) {
      await memory.createProfile({ demoKey, displayName, ageBand: '6-8', languageMode: 'en', timezone: 'Asia/Ho_Chi_Minh' });
    }
    await app.bootstrap();
    an = (await memory.findProfile('an'))!.id; binh = (await memory.findProfile('binh'))!.id;
    session = (await app.openSession('an')).session_id;
    binhInitial = await state('binh_initial', binh);
    await save('running');
    await run('happy_heard_and_idempotent', async () => {
      const before = await state('happy_before'); const { turn, request } = await prepare("I'm happy today.");
      unchanged(before, await state('happy_after_prepare'), 'prepare_committed_affect');
      const calls = provider!.telemetry.length;
      check(same(turn.presentation.affect, (await app!.prepareTurn(an, session, request)).presentation.affect) && provider!.telemetry.length === calls, 'prepare_retry_not_identical');
      await receipt(turn, 'started'); unchanged(before, await state('happy_after_started'), 'started_committed_affect');
      const done = await receipt(turn, 'completed'); const after = await state('happy_after_completed');
      check(after.affect.conversation.energy > before.affect.conversation.energy && after.affect.conversation.valence > before.affect.conversation.valence, 'positive_control_not_applied');
      check(same(after.affect.baseline, before.affect.baseline) && after.affect.dailyMood === before.affect.dailyMood, 'positive_turn_changed_daily_baseline');
      check(after.affect.revision === before.affect.revision + 1 && after.receipts === before.receipts + 1, 'positive_control_not_once');
      check(Math.abs(after.affect.conversation.energy - before.affect.conversation.energy) <= .150000001 && Math.abs(after.affect.conversation.valence - before.affect.conversation.valence) <= .150000001, 'affect_change_exceeds_bound');
      await app!.playback(an, session, turn.turn_id, done.value);
      check(same(turn.presentation.affect, (await app!.prepareTurn(an, session, request)).presentation.affect) && provider!.telemetry.length === calls, 'completed_retry_regenerated');
      unchanged(after, await state('happy_after_duplicate'), 'duplicate_delivery_changed_affect');
      return { positive_control: true, preview_retry_identical: true, duplicate_receipt_applied_once: true };
    });
    await run('scared_interrupted', async () => {
      const before = await state('scared_before'); const { turn } = await prepare("I'm scared of the thunder."); comfort(turn);
      await receipt(turn, 'started'); await receipt(turn, 'interrupted'); unchanged(before, await state('scared_after'), 'interruption_changed_affect');
      return { comfort_policy: 'gentle', durable_change: false };
    }, ['happy_heard_and_idempotent']);
    await run('happy_canceled', async () => {
      const before = await state('canceled_before'); const { turn } = await prepare("I feel happy now.");
      await app!.cancel(an, session, turn.turn_id); pending.delete(turn.turn_id);
      unchanged(before, await state('canceled_after'), 'cancellation_changed_affect'); return { durable_change: false };
    }, ['happy_heard_and_idempotent']);
    await run('no_save_frustrated_heard', async () => {
      const before = await state('no_save_before'); const { turn } = await prepare("Don't remember this. I feel frustrated.");
      await complete(turn); unchanged(before, await state('no_save_after'), 'no_save_changed_affect'); return { durable_change: false };
    }, ['happy_heard_and_idempotent']);
    await run('sad_heard', async () => {
      const before = await state('sad_before'); const { turn } = await prepare('I feel sad.'); comfort(turn); await complete(turn);
      afterSad = await state('sad_after');
      check(afterSad.affect.conversation.energy < before.affect.conversation.energy, 'sadness_did_not_calm_energy');
      check(Math.abs(afterSad.affect.conversation.energy - before.affect.conversation.energy) <= .150000001 && Math.abs(afterSad.affect.conversation.valence - before.affect.conversation.valence) <= .150000001, 'calming_change_exceeds_bound');
      check(afterSad.affect.revision === before.affect.revision + 1 && afterSad.receipts === before.receipts + 1, 'calming_update_not_once');
      check(same(afterSad.affect.baseline, before.affect.baseline), 'conversation_changed_daily_baseline');
      return { energy_decreased: true, comfort_policy: 'gentle' };
    }, ['happy_heard_and_idempotent']);
    await run('half_life_and_session_reopen', async () => {
      const before = afterSad!; check(changed(before.affect.current, before.affect.baseline), 'decay_requires_nonzero_control');
      time += 30 * 60 * 1000; const half = await state('after_30_minutes');
      for (const axis of ['valence', 'energy'] as const) check(close(half.affect.current[axis] - half.affect.baseline[axis], (before.affect.current[axis] - before.affect.baseline[axis]) / 2), 'half_life_not_half');
      check(same(half.affect.conversation, before.affect.conversation) && half.affect.revision === before.affect.revision && half.affect.updatedAt === before.affect.updatedAt, 'decay_mutated_saved_state');
      app!.sweepSessions();
      let expired = false;
      try { await app!.cancel(an, session, randomUUID()); }
      catch (error) { if (error instanceof AppError && ['session_closed', 'session_not_found'].includes(error.code)) expired = true; else throw error; }
      check(expired, 'session_not_expired_at_idle_boundary');
      await app!.closeSession(an, session).catch(error => { if (!(error instanceof AppError) || error.code !== 'session_not_found') throw error; });
      session = (await app!.openSession('an')).session_id; const reopened = await state('after_reopen');
      unchanged(half, reopened, 'reopen_changed_affect'); beforeForget = reopened;
      return { half_life_minutes: 30, saved_revision_unchanged: true, reconnect_stable: true };
    }, ['sad_heard']);
    await run('forget_request', async () => {
      check(changed(beforeForget!.affect.conversation, beforeForget!.affect.baseline) && beforeForget!.receipts > 0, 'forget_requires_nonzero_control');
      const { turn } = await prepare('Forget everything you remember about me.'); await complete(turn);
      unchanged(beforeForget!, await state('after_forget_request'), 'confirmation_request_reset_early'); return { confirmation_requested: true };
    }, ['half_life_and_session_reopen']);
    await run('forget_confirmation', async () => {
      const { turn } = await prepare('Yes.'); await complete(turn); const after = await state('after_forget_confirmation');
      check(same(after.affect.baseline, beforeForget!.affect.baseline) && same(after.affect.conversation, after.affect.baseline)
        && same(after.affect.current, after.affect.baseline) && after.receipts === 0 && after.affect.lastInteractionAt === null, 'forget_did_not_clear_influence_and_receipts');
      return { conversation_reset: true, receipts: 0, daily_baseline_preserved: true };
    }, ['forget_request']);
    await run('next_day_reset', async () => {
      const before = await state('before_next_day'); await app!.nextDay(an, randomUUID(), before.clock_version);
      const after = await state('after_next_day');
      check(after.local_date > before.local_date && after.affect.localDate === after.local_date && after.growth_days === before.growth_days + 1, 'next_day_not_advanced');
      check(same(after.affect.conversation, after.affect.baseline) && same(after.affect.current, after.affect.baseline), 'next_day_influence_not_reset');
      const repeated = await state('next_day_second_read'); unchanged(after, repeated, 'daily_seed_unstable_on_read');
      return { date: after.local_date, daily_mood: after.affect.dailyMood, repeated_label_allowed: true };
    }, ['forget_confirmation']);
    await run('binh_isolation', async () => {
      const final = await state('binh_final', binh); unchanged(binhInitial!, final, 'an_updates_changed_binh_affect'); return { affect_unchanged: true };
    });
  } catch (error) { blocker = { ...safeError(error), source: 'startup_or_harness' }; }
  finally {
    for (const id of pending) { try { await app?.cancel(an, session, id); } catch { /* Only isolated test state. */ } }
    if (app) await app.close(); else await memory?.close();
  }
  return save(blocker || cases.some(item => item.status === 'failed' || item.status === 'blocked') ? 'completed_with_unresolved_failures' : 'completed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'env-file': { type: 'string', default: '.env' },
    'plan-only': { type: 'boolean', default: false }, 'blocked-reason': { type: 'string' }, help: { type: 'boolean', default: false } } });
  if (values.help) console.log('Usage: tsx backend/scripts/verify-affect-real.ts [--output NEW_DIRECTORY] [--env-file .env] [--plan-only --blocked-reason provider_quota_exceeded]');
  else {
    if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
    if (values['blocked-reason'] && !/^[a-z0-9_]{1,80}$/u.test(values['blocked-reason'])) throw new Error('invalid_blocked_reason');
    const report = await verifyAffectReal({ output: values.output ?? 'reports/affect-real-' + new Date().toISOString().replace(/[:.]/gu, '-'),
      planOnly: values['plan-only'], blockedReason: values['blocked-reason'] });
    console.log('Affect verification: ' + report.status + '; actual requests=' + report.actual_api_requests_this_run);
    if (report.status !== 'completed') process.exitCode = 1;
  }
}
