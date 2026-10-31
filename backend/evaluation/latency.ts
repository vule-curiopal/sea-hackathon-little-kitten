import type { OpenAIRequestTelemetry } from '../pipeline/providers.js';
import type { ProviderEvent, TurnLog } from './types.js';

export interface LatencyStats {
  samples: number;
  total_ms: number;
  min_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
  median_ms: number | null;
  /** Nearest-rank percentile, including for a single observation. */
  p95_ms: number | null;
  p95_small_sample: boolean;
}

interface ProviderStageSummary {
  calls: number;
  ok: number;
  failed: number;
  call_elapsed_ms: LatencyStats;
  /** Sum of calls at this stage per supplied turn, including zero-call turns. */
  per_turn_elapsed_ms: LatencyStats;
}

interface ApiStageSummary {
  calls: number;
  completed: number;
  failed: number;
  call_elapsed_ms: LatencyStats;
  /** Sum is work, not a critical path: concurrent API requests may overlap. */
  per_turn_elapsed_ms: LatencyStats;
}

export interface LatencySummary {
  schema_version: 'miu-latency-summary-v1';
  scope: {
    turn_count: number;
    phases: Record<TurnLog['phase'], number>;
    run_kinds: Record<string, number>;
  };
  turns: {
    attempted: number;
    generated: number;
    completed: number;
    failed: number;
    canceled: number;
    interrupted: number;
    missing_response: number;
    incomplete: number;
    snapshot_errors: number;
  };
  failures_by_code: Record<string, number>;
  failures_by_stage: Record<string, number>;
  elapsed_ms: LatencyStats;
  completed_elapsed_ms: LatencyStats;
  provider_calls: {
    total: number;
    real: number;
    fake: number;
    ok: number;
    failed: number;
    probe_calls: number;
    by_stage: Record<ProviderEvent['stage'], ProviderStageSummary>;
    per_turn_elapsed_ms: LatencyStats;
  };
  api_calls: {
    total: number;
    real: number;
    fake: number;
    completed: number;
    failed: number;
    probe_calls: number;
    turns_with_telemetry: number;
    turns_missing_telemetry: number;
    by_stage: Record<OpenAIRequestTelemetry['stage'], ApiStageSummary>;
    /** Union of request intervals within each turn, rather than their sum. */
    per_turn_union_elapsed_ms: LatencyStats;
  };
  /** Elapsed turn time minus provider method envelopes, not isolated SQL time. */
  local_and_db_residual_ms: LatencyStats;
  timing_coverage: {
    invalid_turn_elapsed: number;
    invalid_provider_call_elapsed: number;
    invalid_api_call_elapsed: number;
    invalid_api_call_started_at: number;
    incomplete_probe_api_telemetry_turns: number;
    residual_excluded_turns: number;
  };
  /** Caller-measured whole command duration, which also includes setup/reporting. */
  command_wall_ms: number | null;
  notes: string[];
}

const providerStages: ProviderEvent['stage'][] = ['classify', 'reply', 'check'];
const apiStages: OpenAIRequestTelemetry['stage'][] = ['classify', 'reply', 'check', 'moderation_input', 'moderation_output', 'moderation_context'];
const validDuration = (value: number): boolean => Number.isFinite(value) && value >= 0;
function completeProbeTelemetry(log: TurnLog): boolean {
  const probe = log.operational?.stale_replay;
  return !probe || probe.api_call_count === (probe.api_calls?.length ?? 0);
}

function stats(values: readonly number[]): LatencyStats {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  const total = ordered.reduce((sum, value) => sum + value, 0);
  return {
    samples: n,
    total_ms: total,
    min_ms: n ? ordered[0]! : null,
    max_ms: n ? ordered[n - 1]! : null,
    mean_ms: n ? total / n : null,
    median_ms: n ? n % 2 ? ordered[Math.floor(n / 2)]! : (ordered[n / 2 - 1]! + ordered[n / 2]!) / 2 : null,
    p95_ms: n ? ordered[Math.ceil(n * .95) - 1]! : null,
    p95_small_sample: n > 0 && n < 20,
  };
}

function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }

function unionDuration(calls: readonly OpenAIRequestTelemetry[]): number {
  const intervals = calls.map(call => {
    const start = Date.parse(call.startedAt);
    return [start, start + call.elapsedMs] as const;
  }).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = 0;
  let end = 0;
  for (const [nextStart, nextEnd] of intervals) {
    if (end <= start) { start = nextStart; end = nextEnd; }
    else if (nextStart <= end) end = Math.max(end, nextEnd);
    else { total += end - start; start = nextStart; end = nextEnd; }
  }
  return total + Math.max(0, end - start);
}

function increment(counts: Record<string, number>, key: string) { counts[key] = (counts[key] ?? 0) + 1; }

/**
 * Summarize only the supplied attempted-turn records. Callers can filter to
 * `phase === 'scenario'` first. This neither runs providers nor grades behavior;
 * retain the evaluation manifest/report for blocked state and quality results.
 */
export function summarizeLatency(logs: readonly TurnLog[], commandWallMs?: number): LatencySummary {
  const providerByTurn = logs.map(log => [...log.provider_events, ...(log.operational?.stale_replay?.provider_events ?? [])]);
  const apiByTurn = logs.map(log => [...(log.api_calls ?? []), ...(log.operational?.stale_replay?.api_calls ?? [])]);
  const phases: LatencySummary['scope']['phases'] = { history: 0, scenario: 0, scenario_history: 0 };
  const runKinds: Record<string, number> = {};
  const failuresByCode: Record<string, number> = {};
  const failuresByStage: Record<string, number> = {};
  const elapsed: number[] = [];
  const completedElapsed: number[] = [];
  const residuals: number[] = [];
  const providerPerTurn: number[] = [];
  const apiUnionPerTurn: number[] = [];
  const turns: LatencySummary['turns'] = { attempted: logs.length, generated: 0, completed: 0, failed: 0, canceled: 0, interrupted: 0, missing_response: 0, incomplete: 0, snapshot_errors: 0 };
  const coverage: LatencySummary['timing_coverage'] = { invalid_turn_elapsed: 0, invalid_provider_call_elapsed: 0, invalid_api_call_elapsed: 0, invalid_api_call_started_at: 0, incomplete_probe_api_telemetry_turns: 0, residual_excluded_turns: 0 };
  let telemetryTurns = 0;
  for (const [index, log] of logs.entries()) {
    phases[log.phase]++;
    increment(runKinds, log.run_kind ?? 'unspecified');
    if (log.response) turns.generated++;
    else turns.missing_response++;
    const completed = !!log.response && log.delivery?.status === 'completed' && !log.error;
    if (completed) turns.completed++;
    if (log.error) {
      turns.failed++;
      increment(failuresByCode, log.error.code);
      increment(failuresByStage, log.error.stage);
    }
    if (log.delivery?.status === 'canceled') turns.canceled++;
    if (log.delivery?.status === 'interrupted') turns.interrupted++;
    if (!log.error && (!log.response || !['completed', 'canceled', 'interrupted'].includes(log.delivery?.status ?? ''))) turns.incomplete++;
    if (log.after_snapshot_error) turns.snapshot_errors++;
    if (validDuration(log.elapsed_ms)) {
      elapsed.push(log.elapsed_ms);
      if (completed) completedElapsed.push(log.elapsed_ms);
    } else coverage.invalid_turn_elapsed++;

    const providerCalls = providerByTurn[index]!;
    const validProviderTimes = providerCalls.every(event => validDuration(event.elapsed_ms));
    coverage.invalid_provider_call_elapsed += providerCalls.filter(event => !validDuration(event.elapsed_ms)).length;
    if (validProviderTimes) {
      const providerTime = sum(providerCalls.map(event => event.elapsed_ms));
      providerPerTurn.push(providerTime);
      if (validDuration(log.elapsed_ms) && providerTime <= log.elapsed_ms) residuals.push(log.elapsed_ms - providerTime);
      else coverage.residual_excluded_turns++;
    } else coverage.residual_excluded_turns++;

    const apiCalls = apiByTurn[index]!;
    const invalidApiDurations = apiCalls.filter(call => !validDuration(call.elapsedMs)).length;
    const invalidApiStarts = apiCalls.filter(call => !Number.isFinite(Date.parse(call.startedAt))).length;
    coverage.invalid_api_call_elapsed += invalidApiDurations;
    coverage.invalid_api_call_started_at += invalidApiStarts;
    const incompleteProbe = !completeProbeTelemetry(log);
    if (incompleteProbe) coverage.incomplete_probe_api_telemetry_turns++;
    if (log.api_calls !== undefined) {
      telemetryTurns++;
      if (!invalidApiDurations && !invalidApiStarts && !incompleteProbe) apiUnionPerTurn.push(unionDuration(apiCalls));
    }
  }

  const providerByStage = Object.fromEntries(providerStages.map(stage => {
    const perTurnCalls = providerByTurn.map(calls => calls.filter(event => event.stage === stage));
    const calls = perTurnCalls.flat();
    return [stage, {
      calls: calls.length,
      ok: calls.filter(event => event.outcome === 'ok').length,
      failed: calls.filter(event => event.outcome === 'error').length,
      call_elapsed_ms: stats(calls.map(event => event.elapsed_ms).filter(validDuration)),
      per_turn_elapsed_ms: stats(perTurnCalls.filter(events => events.every(event => validDuration(event.elapsed_ms))).map(events => sum(events.map(event => event.elapsed_ms)))),
    } satisfies ProviderStageSummary];
  })) as Record<ProviderEvent['stage'], ProviderStageSummary>;
  const apiByStage = Object.fromEntries(apiStages.map(stage => {
    const perTurnCalls = apiByTurn.map(calls => calls.filter(call => call.stage === stage));
    const calls = perTurnCalls.flat();
    return [stage, {
      calls: calls.length,
      completed: calls.filter(call => call.outcome === 'completed').length,
      failed: calls.filter(call => call.outcome === 'failed').length,
      call_elapsed_ms: stats(calls.map(call => call.elapsedMs).filter(validDuration)),
      per_turn_elapsed_ms: stats(perTurnCalls.flatMap((stageCalls, index) => logs[index]!.api_calls === undefined || !completeProbeTelemetry(logs[index]!) || !stageCalls.every(call => validDuration(call.elapsedMs)) ? [] : [sum(stageCalls.map(call => call.elapsedMs))])),
    } satisfies ApiStageSummary];
  })) as Record<OpenAIRequestTelemetry['stage'], ApiStageSummary>;
  const providerCalls = providerByTurn.flat();
  const apiCalls = apiByTurn.flat();
  return {
    schema_version: 'miu-latency-summary-v1',
    scope: { turn_count: logs.length, phases, run_kinds: runKinds },
    turns,
    failures_by_code: failuresByCode,
    failures_by_stage: failuresByStage,
    elapsed_ms: stats(elapsed),
    completed_elapsed_ms: stats(completedElapsed),
    provider_calls: {
      total: providerCalls.length,
      real: sum(providerByTurn.map((calls, index) => logs[index]!.provider_mode === 'real' ? calls.length : 0)),
      fake: sum(providerByTurn.map((calls, index) => logs[index]!.provider_mode === 'fake' ? calls.length : 0)),
      ok: providerCalls.filter(event => event.outcome === 'ok').length,
      failed: providerCalls.filter(event => event.outcome === 'error').length,
      probe_calls: sum(logs.map(log => log.operational?.stale_replay?.provider_events?.length ?? 0)),
      by_stage: providerByStage,
      per_turn_elapsed_ms: stats(providerPerTurn),
    },
    api_calls: {
      total: apiCalls.length,
      real: sum(apiByTurn.map((calls, index) => logs[index]!.provider_mode === 'real' ? calls.length : 0)),
      fake: sum(apiByTurn.map((calls, index) => logs[index]!.provider_mode === 'fake' ? calls.length : 0)),
      completed: apiCalls.filter(call => call.outcome === 'completed').length,
      failed: apiCalls.filter(call => call.outcome === 'failed').length,
      probe_calls: sum(logs.map(log => log.operational?.stale_replay?.api_calls?.length ?? 0)),
      turns_with_telemetry: telemetryTurns,
      turns_missing_telemetry: logs.length - telemetryTurns,
      by_stage: apiByStage,
      per_turn_union_elapsed_ms: stats(apiUnionPerTurn),
    },
    local_and_db_residual_ms: stats(residuals),
    timing_coverage: coverage,
    command_wall_ms: commandWallMs !== undefined && validDuration(commandWallMs) ? commandWallMs : null,
    notes: [
      'Timing only: these statistics do not establish character quality, memory quality, assertion passes, or successful coverage of unattempted cases. Preserve the run manifest and behavioral report, including blocked status.',
      'All supplied phases are included. Filter logs to phase === "scenario" before calling this function to omit historical replay and scenario preparation turns.',
      'Attempted is the number of supplied records. Generated means an approved response object exists. Completed additionally requires completed delivery and no execution error; generated, failed, canceled, and interrupted counts can overlap.',
      'The runner measures elapsed_ms around preparation, simulated delivery receipts, and operational probes; before/after snapshots and whole-command setup/reporting are outside this timer. This is not audible response latency.',
      'Provider calls are classify/reply/check method envelopes, grouped by the logged provider mode. They include nested API work and repair calls. Do not add provider-envelope time to API-call time.',
      'API-stage sums measure recorded request work, not elapsed critical-path time. Per-turn API unions merge overlapping startedAt/elapsedMs intervals, so parallel classification/moderation and check/moderation are not double counted.',
      'Local-and-DB residual is elapsed_ms minus the sum of recorded provider method envelopes, including probe envelopes. It includes local logic, memory/database work, delivery orchestration, and harness overhead; it does not isolate SQL time. Invalid timings or envelope sums above elapsed time are excluded and counted.',
      'Operational stale-replay probe calls are included separately from main-turn evidence and identified by probe_calls. Missing API telemetry is not treated as measured zero latency.',
      'Median is the middle value or mean of the two middle values. P95 uses nearest rank and is flagged as a small sample below 20 observations; a single observation is not a stable tail-latency estimate.',
      'Mode labels and timing records are preserved as provenance metadata; this helper neither verifies API authenticity nor relabels test-double data as model evidence.',
    ],
  };
}
