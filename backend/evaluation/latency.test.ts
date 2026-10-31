import test from 'node:test';
import assert from 'node:assert/strict';
import type { TurnResponse } from '../application.js';
import type { OpenAIRequestTelemetry } from '../pipeline/providers.js';
import type { MemoryContext } from '../shared/types.js';
import type { ProviderEvent, TurnLog } from './types.js';
import { summarizeLatency } from './latency.js';

// Pure arithmetic fixtures only. No provider, application, database, or model
// executes. Labels and artificial responses are not model-performance evidence.
const context: MemoryContext = {
  profile: { id: 'unit-profile', demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'en', timezone: 'Asia/Ho_Chi_Minh', stateVersion: 1, deletionEpoch: 0 },
  config: { personality: 'ENFP', role: 'friend', voiceId: 'miu-default', canonVersion: 'miu-v1' },
  clock: { mode: 'demo', effectiveNow: '2026-11-01T02:00:00.000Z', localDate: '2026-11-01', timezone: 'Asia/Ho_Chi_Minh', version: 1 },
  daily: { localDate: '2026-11-01', mood: 'content', growthDays: 0, growthTheme: 'unit fixture', diary: { templateId: 'unit', en: 'Unit fixture.', vi: 'Dữ liệu kiểm thử.' }, storyEpisode: { templateId: 'unit', chapter: 0, en: 'Unit fixture.', vi: 'Dữ liệu kiểm thử.' } },
  entities: [], preferences: [], socialCircle: [], events: [], stories: [], storyProgress: null, friendship: 'getting_acquainted',
};
const response: TurnResponse = {
  session_id: 'unit-session', turn_id: 'unit-turn', input_mode: 'text', provider_mode: 'real', state_version: 1, clock_version: 1,
  reply: { text: 'Artificial latency unit fixture.', sentences: ['Artificial latency unit fixture.'], language: 'en' },
  presentation: {
    purpose: 'chat', language: 'en', ageBand: '6-8', personality: 'ENFP', role: 'friend', emotion: 'neutral', dailyMood: 'content', rhythm: 'morning', delivery: 'normal',
    allowGiggle: false, allowPurr: false, face: { expression: 'neutral', gesture: 'none' }, memoryReferenceId: null, allowedFacts: [], allowedQuestion: null, exactText: null,
    maxSentences: 3, maxQuestions: 1, ruleTrace: [], comfortActive: false,
  },
  memory: { reference_id: null, learning_status: 'awaiting_playback', invalidate_replay: false },
};

function log(overrides: Partial<TurnLog> = {}): TurnLog {
  return {
    schema_version: 'miu-engine-evaluation-v1', run_kind: 'harness_self_test', run_id: 'unit-latency-no-model-run', phase: 'scenario', scenario_id: 'SC-UNIT', conversation_id: 'unit-conversation', turn_spec_id: 'unit-step',
    profile_key: 'an', input: { kind: 'utterance', text: 'Artificial arithmetic fixture, not evaluation dialogue.' }, at: '2026-11-01T02:00:00.000Z', elapsed_ms: 100, provider_mode: 'real', response,
    before: context, after: context, delivery: { status: 'completed', learning_status: 'complete' }, retry: null, error: null, provider_events: [], api_calls: [], reply_origin: 'test_double', assertions: [], rubric: [],
    ...overrides,
  };
}

const event = (stage: ProviderEvent['stage'], elapsed_ms: number, outcome: ProviderEvent['outcome'] = 'ok'): ProviderEvent => ({ stage, elapsed_ms, outcome });
const epoch = Date.parse('2026-11-01T00:00:00.000Z');
function api(stage: OpenAIRequestTelemetry['stage'], start: number, elapsedMs: number, outcome: OpenAIRequestTelemetry['outcome'] = 'completed'): OpenAIRequestTelemetry {
  return { sequence: start, stage, api: stage.startsWith('moderation_') && stage !== 'moderation_context' ? 'moderations' : 'responses', requestedModel: 'unit-model', returnedModel: 'unit-model', responseId: 'unit-response', requestId: 'unit-request', startedAt: new Date(epoch + start).toISOString(), elapsedMs, outcome, inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null, errorCode: outcome === 'failed' ? 'unit_error' : null, httpStatus: outcome === 'failed' ? 500 : 200 };
}

test('latency statistics use independent arithmetic, even-sample median, nearest-rank p95, and command wall time', () => {
  const summary = summarizeLatency([100, 200, 300, 400].map(elapsed_ms => log({ elapsed_ms })), 1800);
  assert.deepEqual(summary.elapsed_ms, { samples: 4, total_ms: 1000, min_ms: 100, max_ms: 400, mean_ms: 250, median_ms: 250, p95_ms: 400, p95_small_sample: true });
  assert.deepEqual(summary.completed_elapsed_ms, summary.elapsed_ms);
  assert.equal(summary.command_wall_ms, 1800);
  assert.equal(summary.turns.attempted, 4);
  assert.equal(summary.turns.completed, 4);
  assert.equal(summary.provider_calls.total, 0);
  assert.equal(summary.local_and_db_residual_ms.mean_ms, 250);
});

test('generated, failed, canceled, interrupted, and incomplete turns remain distinct instead of hiding failures', () => {
  const summary = summarizeLatency([
    log({ elapsed_ms: 50 }),
    log({ elapsed_ms: 40, response: null, delivery: null, error: { code: 'provider_quota_exceeded', stage: 'prepare' } }),
    log({ elapsed_ms: 60, error: { code: 'stale_state', stage: 'playback_final' } }),
    log({ elapsed_ms: 30, delivery: { status: 'canceled' } }),
    log({ elapsed_ms: 20, delivery: { status: 'interrupted' } }),
    log({ elapsed_ms: 10, response: null, delivery: null }),
    log({ elapsed_ms: 70, error: { code: 'snapshot_failed', stage: 'after_snapshot' }, after_snapshot_error: 'snapshot_failed' }),
  ]);
  assert.deepEqual(summary.turns, { attempted: 7, generated: 5, completed: 1, failed: 3, canceled: 1, interrupted: 1, missing_response: 2, incomplete: 1, snapshot_errors: 1 });
  assert.deepEqual(summary.failures_by_code, { provider_quota_exceeded: 1, stale_state: 1, snapshot_failed: 1 });
  assert.deepEqual(summary.failures_by_stage, { prepare: 1, playback_final: 1, after_snapshot: 1 });
  assert.equal(summary.elapsed_ms.samples, 7);
  assert.equal(summary.completed_elapsed_ms.mean_ms, 50);
  assert.equal('quality_passed' in summary, false);
});

test('repair calls contribute separately while per-turn stage means sum all repairs', () => {
  const summary = summarizeLatency([
    log({ elapsed_ms: 60, provider_events: [event('classify', 10), event('reply', 20), event('check', 5), event('reply', 8), event('check', 3)] }),
    log({ elapsed_ms: 30, provider_mode: 'fake', provider_events: [event('classify', 4), event('reply', 6), event('check', 2)] }),
  ]);
  assert.equal(summary.provider_calls.total, 8);
  assert.equal(summary.provider_calls.real, 5);
  assert.equal(summary.provider_calls.fake, 3);
  assert.equal(summary.provider_calls.by_stage.reply.calls, 3);
  assert.equal(summary.provider_calls.by_stage.reply.call_elapsed_ms.total_ms, 34);
  assert.equal(summary.provider_calls.by_stage.reply.call_elapsed_ms.mean_ms, 34 / 3);
  assert.equal(summary.provider_calls.by_stage.reply.per_turn_elapsed_ms.mean_ms, 17);
  assert.equal(summary.provider_calls.by_stage.check.calls, 3);
  assert.equal(summary.provider_calls.per_turn_elapsed_ms.total_ms, 58);
  assert.equal(summary.provider_calls.per_turn_elapsed_ms.mean_ms, 29);
  assert.equal(summary.local_and_db_residual_ms.total_ms, 32);
  assert.equal(summary.local_and_db_residual_ms.mean_ms, 16);
});

test('parallel input and output moderation are merged as API intervals rather than added to method envelopes', () => {
  const summary = summarizeLatency([log({
    elapsed_ms: 100,
    provider_events: [event('classify', 32), event('reply', 42), event('check', 16)],
    api_calls: [api('classify', 0, 30), api('moderation_input', 0, 20), api('reply', 30, 40), api('check', 70, 10), api('moderation_output', 70, 15)],
  })]);
  assert.equal(summary.api_calls.total, 5);
  assert.equal(summary.api_calls.real, 5);
  assert.equal(summary.api_calls.per_turn_union_elapsed_ms.total_ms, 85);
  assert.equal(Object.values(summary.api_calls.by_stage).reduce((total, stage) => total + stage.call_elapsed_ms.total_ms, 0), 115);
  assert.equal(summary.provider_calls.per_turn_elapsed_ms.total_ms, 90);
  assert.equal(summary.local_and_db_residual_ms.total_ms, 10);
  assert.equal(summary.api_calls.by_stage.moderation_input.call_elapsed_ms.mean_ms, 20);
  assert.equal(summary.api_calls.by_stage.moderation_output.call_elapsed_ms.mean_ms, 15);
});

test('failed API attempts, repeated repair stages, and zero-call turns retain accurate stage totals and means', () => {
  const summary = summarizeLatency([
    log({ elapsed_ms: 120, api_calls: [api('reply', 0, 20, 'failed'), api('reply', 25, 40), api('check', 65, 10)], provider_events: [event('reply', 21, 'error'), event('reply', 42), event('check', 11)] }),
    log({ elapsed_ms: 10 }),
  ]);
  assert.equal(summary.api_calls.total, 3);
  assert.equal(summary.api_calls.completed, 2);
  assert.equal(summary.api_calls.failed, 1);
  assert.equal(summary.api_calls.by_stage.reply.calls, 2);
  assert.equal(summary.api_calls.by_stage.reply.call_elapsed_ms.mean_ms, 30);
  assert.equal(summary.api_calls.by_stage.reply.per_turn_elapsed_ms.mean_ms, 30);
  assert.equal(summary.api_calls.per_turn_union_elapsed_ms.total_ms, 70);
  assert.equal(summary.api_calls.per_turn_union_elapsed_ms.mean_ms, 35);
  assert.equal(summary.provider_calls.failed, 1);
  assert.equal(summary.provider_calls.by_stage.reply.failed, 1);
  assert.equal(summary.turns.failed, 0, 'A failed repaired request need not fail the completed turn.');
});

test('stale replay probes are included once, with their separate provider and API evidence', () => {
  const summary = summarizeLatency([log({
    elapsed_ms: 100,
    provider_events: [event('classify', 20), event('reply', 30), event('check', 10)],
    api_calls: [api('classify', 0, 20), api('reply', 20, 30), api('check', 50, 10)],
    operational: {
      request: { request_id: 'unit-main', session_id: 'unit-session' },
      stale_replay: { source_turn_spec_id: 'unit-earlier', request_id: 'unit-old', session_id: 'unit-session', error_code: 'unit_error', response: null, api_call_count: 1, api_calls: [api('classify', 70, 5, 'failed')], provider_events: [event('classify', 6, 'error')] },
    },
  })]);
  assert.equal(summary.provider_calls.total, 4);
  assert.equal(summary.provider_calls.probe_calls, 1);
  assert.equal(summary.provider_calls.by_stage.classify.calls, 2);
  assert.equal(summary.api_calls.total, 4);
  assert.equal(summary.api_calls.probe_calls, 1);
  assert.equal(summary.api_calls.failed, 1);
  assert.equal(summary.api_calls.per_turn_union_elapsed_ms.total_ms, 65);
  assert.equal(summary.local_and_db_residual_ms.total_ms, 34);
});

test('missing telemetry and invalid durations are visible exclusions rather than invented zero API latency or negative residual', () => {
  const summary = summarizeLatency([
    log({ api_calls: undefined, elapsed_ms: 50, provider_events: [event('classify', 20)] }),
    log({ elapsed_ms: Number.NaN, provider_events: [event('reply', 4)] }),
    log({ elapsed_ms: 20, provider_events: [event('reply', 30)] }),
    log({ elapsed_ms: 10, provider_events: [event('check', -1)], api_calls: [{ ...api('check', 0, 2), startedAt: 'invalid' }, api('reply', 5, -3)] }),
  ], -1);
  assert.equal(summary.elapsed_ms.samples, 3);
  assert.equal(summary.api_calls.turns_with_telemetry, 3);
  assert.equal(summary.api_calls.turns_missing_telemetry, 1);
  assert.equal(summary.api_calls.per_turn_union_elapsed_ms.samples, 2);
  assert.equal(summary.local_and_db_residual_ms.samples, 1);
  assert.equal(summary.local_and_db_residual_ms.mean_ms, 30);
  assert.equal(summary.timing_coverage.invalid_turn_elapsed, 1);
  assert.equal(summary.timing_coverage.invalid_provider_call_elapsed, 1);
  assert.equal(summary.timing_coverage.invalid_api_call_elapsed, 1);
  assert.equal(summary.timing_coverage.invalid_api_call_started_at, 1);
  assert.equal(summary.timing_coverage.residual_excluded_turns, 3);
  assert.equal(summary.command_wall_ms, null);
});

test('a probe announcing missing API details cannot establish measured zero API latency', () => {
  const summary = summarizeLatency([log({ operational: { request: { request_id: 'unit', session_id: 'unit' }, stale_replay: { source_turn_spec_id: 'prior', request_id: 'prior', session_id: 'unit', error_code: null, response: null, api_call_count: 1 } } })]);
  assert.equal(summary.api_calls.total, 0);
  assert.equal(summary.api_calls.per_turn_union_elapsed_ms.samples, 0);
  assert.equal(summary.api_calls.by_stage.reply.per_turn_elapsed_ms.samples, 0);
  assert.equal(summary.timing_coverage.incomplete_probe_api_telemetry_turns, 1);
});

test('single-turn p95 is explicitly a small sample, empty summaries have null estimates, and 20 observations clear the flag', () => {
  const single = summarizeLatency([log({ elapsed_ms: 12.5 })]);
  assert.equal(single.elapsed_ms.p95_ms, 12.5);
  assert.equal(single.elapsed_ms.p95_small_sample, true);
  const empty = summarizeLatency([]);
  assert.deepEqual(empty.elapsed_ms, { samples: 0, total_ms: 0, min_ms: null, max_ms: null, mean_ms: null, median_ms: null, p95_ms: null, p95_small_sample: false });
  assert.equal(empty.turns.attempted, 0);
  assert.equal(empty.command_wall_ms, null);
  const twenty = summarizeLatency(Array.from({ length: 20 }, (_, index) => log({ elapsed_ms: index + 1 })));
  assert.equal(twenty.elapsed_ms.p95_ms, 19);
  assert.equal(twenty.elapsed_ms.p95_small_sample, false);
});

test('supplied phases remain explicit and callers can restrict summaries to scenario turns', () => {
  const logs = [log({ phase: 'history', elapsed_ms: 900 }), log({ phase: 'scenario_history', elapsed_ms: 300 }), log({ phase: 'scenario', elapsed_ms: 30 })];
  const all = summarizeLatency(logs);
  assert.deepEqual(all.scope.phases, { history: 1, scenario: 1, scenario_history: 1 });
  assert.equal(all.elapsed_ms.total_ms, 1230);
  const scenario = summarizeLatency(logs.filter(turn => turn.phase === 'scenario'));
  assert.equal(scenario.turns.attempted, 1);
  assert.equal(scenario.elapsed_ms.mean_ms, 30);
  assert.deepEqual(scenario.scope.run_kinds, { harness_self_test: 1 });
});

test('summarization is pure and does not mutate records or timing order', () => {
  const logs = [log({ elapsed_ms: 20, api_calls: [api('reply', 5, 4), api('classify', 0, 3)] }), log({ elapsed_ms: 10 })];
  const original = structuredClone(logs);
  summarizeLatency(logs, 40);
  assert.deepEqual(logs, original);
});
