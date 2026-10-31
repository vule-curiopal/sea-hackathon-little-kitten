interface AudioReport {
  status: string;
  error_code: string | null;
  checks: { name: string; status: string }[];
  evidence: Record<string, unknown>;
  api_calls: readonly { stage: string; outcome: string; responseId?: string | null }[];
  source_changed_during_verification: boolean;
}
export interface FailedAudioAttempt { directory: string; error_code: string | null }

/** Pure formatting; reading this module never starts a browser or provider. */
export function renderAudioInterruptionReport(report: AudioReport, earlierFailures: FailedAudioAttempt[] = []): string {
  const interruption = report.evidence.interruption as { pause_latency_ms: number | null; graph_silence_latency_ms: number | null; post_stop_observation_ms: number } | undefined;
  const supplemental = report.evidence.supplemental_lifecycle_trials as { trials: { pause_latency_ms: number | null; graph_silence_latency_ms: number | null; explicit_resume_result: string }[] } | undefined;
  const checkpoint = report.evidence.checkpoints as { before: unknown; after_interruption: unknown } | undefined;
  const continuation = report.evidence.completed_continuation as { checkpoint?: { chapter: number } } | undefined;
  const ui = report.evidence.ui_after_stop as { visible_error_notice: boolean; runtime_errors: string[]; send_enabled: boolean } | undefined;
  const trials = [...(interruption ? [interruption] : []), ...(supplemental?.trials ?? [])];
  const silences = trials.flatMap(trial => typeof trial.graph_silence_latency_ms === 'number' ? [trial.graph_silence_latency_ms] : []);
  const pauses = trials.flatMap(trial => typeof trial.pause_latency_ms === 'number' ? [trial.pause_latency_ms] : []);
  const replies = report.api_calls.filter(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId);
  const passed = (name: string) => report.checks.some(check => check.name === name && check.status === 'pass');
  const ms = (value: number | null | undefined) => typeof value === 'number' ? `${value.toFixed(1)} ms` : 'not established';
  const lines = [
    `# SC063 browser audio interruption: ${report.status}`,
    '',
    `${report.checks.filter(check => check.status === 'pass').length}/${report.checks.length} checks passed. ${report.error_code ? `Unresolved error: ${report.error_code}.` : 'No unresolved error.'} [Raw evidence](report.json).`,
    '',
    `Observed ${trials.length} browser stop trials: ${interruption ? 'one integrated engine/UI/checkpoint trial' : 'no completed integrated trial'} and ${supplemental?.trials.length ?? 0} player lifecycle trials reusing the same real TTS clip. Only the integrated trial covers server cancellation and checkpoints; replays use local receipts and make no provider calls.`,
    '',
    `Maximum measured rendered-audio silence latency: **${ms(silences.length ? Math.max(...silences) : null)}**, against the 300 ms target. Maximum native pause latency: ${ms(pauses.length ? Math.max(...pauses) : null)}. The integrated trial measured ${ms(interruption?.graph_silence_latency_ms)} to sustained silence and observed playback for ${interruption?.post_stop_observation_ms ?? 0} ms after Stop.`,
    '',
  ];
  if (checkpoint) lines.push(`Checkpoint before/after interruption: ${JSON.stringify(checkpoint.before)} → ${JSON.stringify(checkpoint.after_interruption)}. ${continuation?.checkpoint ? `Explicit continuation replayed the unheard opening; only natural audio completion established chapter ${continuation.checkpoint.chapter}.` : 'Completed continuation was not established.'}`, '');
  if (ui) lines.push(`After Stop: visible error notice=${ui.visible_error_notice}; runtime errors=${ui.runtime_errors.length}; send enabled with a nonempty draft=${ui.send_enabled}. Absence of automatic replay and interrupted-turn completion: ${passed('audio_no_resume_or_completion_after_stop') && passed('audio_interrupted_turn_never_completed') ? 'verified' : 'not established'}.`, '');
  if (supplemental?.trials.length) lines.push(`${supplemental.trials.filter(trial => trial.explicit_resume_result === 'canceled').length}/${supplemental.trials.length} explicit replay requests after Stop returned canceled.`, '');
  lines.push(
    'The client fix handles the cancellation/receipt race: an expected non-completed receipt conflict is ignored only after cancellation of that same turn succeeds. A canceled turn’s `stale_state` HTTP 409 remains visible in raw evidence; completed-receipt conflicts, unrelated errors and failed cancellations are not suppressed.',
    '',
    `Actual OpenAI calls: **${report.api_calls.length}**, including ${replies.length} completed reply responses. Real TTS came from the integrated ElevenLabs path; no fake provider was used.`,
    '',
    ...replies.map(call => `- Reply response ID: ${call.responseId}`),
    '',
    `Tracked source changed during verification: ${report.source_changed_during_verification}. Storage used isolated local PGlite; no production connection was used.`,
    '',
    'Desktop headless Chrome’s real HTML audio element and Web Audio graph were measured through a zero-gain analyser branch. Physical speaker audibility, mobile devices, microphone/STT input, full character quality and general voice latency remain unverified.',
    '',
  );
  if (earlierFailures.length) lines.push('Earlier failed attempts remain unchanged:', '', ...earlierFailures.map(attempt => `- [${attempt.directory}](../${attempt.directory}/report.json): ${attempt.error_code ?? 'unspecified failure'}.`), '');
  return lines.join('\n');
}
