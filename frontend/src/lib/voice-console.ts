import type { SessionResponse, VoiceControllerEvent } from '@miu/voice-client';

type ConsoleSink = Pick<Console, 'log' | 'warn' | 'error'>;
type ActionDetails = { state?: string; capture?: string; accepted?: boolean; reason?: string };
export const VOICE_CONSOLE_PREFIX = '[Miu voice]';

/** Browser-local diagnostics: project only technical metadata, never entire API objects. */
export function createVoiceConsole(sink: ConsoleSink = console, now: () => number = () => performance.now()) {
  const started = now();
  let lastMeter = -Infinity;
  const reported = new WeakSet<object>();
  function write(level: keyof ConsoleSink, event: string, details: Record<string, unknown> = {}) {
    try { sink[level](VOICE_CONSOLE_PREFIX, event, { elapsedMs: Math.round(now() - started), ...details }); } catch { /* Console tooling must not interrupt audio. */ }
  }
  function error(reason: unknown, stage = 'error') {
    if (reason && typeof reason === 'object') {
      if (reported.has(reason)) return;
      reported.add(reason);
    }
    const value = reason && typeof reason === 'object' ? reason as Record<string, unknown> : {};
    const code = typeof value.code === 'string' ? value.code : value.name === 'AbortError' ? 'CANCELED' : 'UNKNOWN_ERROR';
    write(code === 'CANCELED' ? 'log' : 'error', stage, {
      code, ...(typeof value.status === 'number' ? { status: value.status } : {}),
      ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
    });
  }
  function event(event: VoiceControllerEvent) {
    if (event.type === 'state') write('log', 'state', { state: event.state });
    else if (event.type === 'error') error(event.error);
    else if (event.type === 'capture') {
      const capture = event.event;
      if (capture.type === 'state') {
        if (capture.state === 'requesting_permission') lastMeter = -Infinity;
        write('log', 'capture.state', { state: capture.state });
      } else if (capture.type === 'meter') {
        if (now() - lastMeter < 1000) return;
        lastMeter = now();
        write('log', 'capture.level', { recordingMs: Math.round(capture.snapshot.elapsedMs), levelDbfs: Math.round(capture.snapshot.levelDbfs), hasSignal: capture.snapshot.hasSignal });
      } else if (capture.type === 'complete') {
        write('log', 'capture.complete', { mimeType: capture.mimeType, bytes: capture.bytes, recordingMs: Math.round(capture.durationMs), reason: capture.reason,
          peakLevelDbfs: capture.peakLevelDbfs === null ? null : Math.round(capture.peakLevelDbfs), sampleRate: capture.sampleRate, channelCount: capture.channelCount });
      } else if (capture.type === 'manual_only') write('warn', 'capture.meter_unavailable', { code: capture.code });
      else if (capture.type === 'error') error(capture.error, 'capture.error');
    } else if (event.type === 'playback') {
      if (event.event.type === 'state') write('log', 'playback.state', { state: event.event.state });
      else error(event.event.error, `playback.${event.event.type}`);
    } else if (event.type === 'turn') {
      const turn = event.response;
      write('log', 'turn.received', {
        turnId: turn.turn_id, input: turn.input_mode ?? 'audio', provider: turn.provider_mode, engine: turn.engine_mode,
        transcriptAvailable: !!turn.transcript?.text?.trim(), transcriptChars: turn.transcript?.text?.length ?? 0,
        uncertainSpans: turn.transcript?.uncertain_spans?.length ?? 0, replyChars: turn.reply.text.length,
        audioAvailable: turn.audio !== null, audioMime: turn.audio?.mime_type ?? null, audioDurationMs: turn.audio?.duration_ms ?? 0,
        timingsMs: { stt: turn.timings_ms.stt, reply: turn.timings_ms.reply, validation: turn.timings_ms.validation, tts: turn.timings_ms.tts, serverTotal: turn.timings_ms.server_total },
      });
    }
  }
  return {
    event, error,
    action(name: string, details: ActionDetails = {}) { write('log', name, { ...(details.state !== undefined ? { state: details.state } : {}), ...(details.capture !== undefined ? { capture: details.capture } : {}), ...(details.accepted !== undefined ? { accepted: details.accepted } : {}), ...(details.reason !== undefined ? { reason: details.reason } : {}) }); },
    request(method: string, path: string, status: number | 'network_error' | 'canceled', durationMs: number) { write(status === 'canceled' || (typeof status === 'number' && status < 400) ? 'log' : 'warn', 'request', { method, path: path.split('?')[0], status, durationMs: Math.round(durationMs) }); },
    session(session: SessionResponse) { write('log', 'session.ready', { provider: session.provider_mode, engine: session.engine_mode, language: session.configuration.language_mode }); },
  };
}
