import WebSocket from 'ws';
import type { Language } from '@miu/voice-contracts';
import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';
import { logEvent } from '../../logger.js';

export type RealtimeSttEvent = { type: 'partial' | 'committed'; text: string } | { type: 'error'; code: string };
export interface RealtimeSttConnection {
  ready: Promise<void>;
  send(pcm: Buffer): void;
  commit(): void;
  close(): void;
}
export type RealtimeSttFactory = (language: Language, emit: (event: RealtimeSttEvent) => void,
  context?: { session_id: string; turn_id: string }) => RealtimeSttConnection;

/** Server-side credentials; provider commits never invoke the response engine. */
export function createRealtimeSttFactory(config: VoiceConfig): RealtimeSttFactory {
  return (language, emit, context) => {
    const url = new URL('/v1/speech-to-text/realtime', config.elevenBaseUrl);
    url.protocol = 'wss:';
    for (const [key, value] of Object.entries({
      model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', language_code: language,
      commit_strategy: 'vad', vad_silence_threshold_secs: String(config.realtimeSilenceMs / 1000),
      filter_background_audio: 'true', include_timestamps: 'false', include_language_detection: 'false',
      no_verbatim: 'false', keepalive_interval_ms: '1000',
    })) url.searchParams.set(key, value);
    // Keep the provider's filtering-specific sensitivity/default durations.
    if (!config.enableLogging) url.searchParams.set('enable_logging', 'false');
    const socket = new WebSocket(url, {
      headers: { 'xi-api-key': config.elevenApiKey }, handshakeTimeout: 10_000,
      maxPayload: 256 * 1024, perMessageDeflate: false,
    });
    let closed = false;
    let failed = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const fail = (code = 'provider_unavailable', providerEvent?: string, status?: number) => {
      if (closed || failed) return;
      failed = true;
      logEvent('stt.provider_failed', { ...context, code, provider_event: providerEvent, status });
      reject(new PipelineError(code, 503));
      emit({ type: 'error', code });
    };
    socket.on('message', raw => {
      if (closed) return;
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.message_type === 'session_started') {
          const actual = data.config as Record<string, unknown> | undefined;
          if (!actual || actual.model_id !== 'scribe_v2_realtime' || actual.filter_background_audio !== true
            || actual.vad_commit_strategy !== true || actual.vad_silence_threshold_secs !== config.realtimeSilenceMs / 1000) {
            fail('provider_configuration'); return;
          }
          if (!config.enableLogging && actual.disable_logging !== true) { fail('retention_not_applied'); return; }
          resolve(); return;
        }
        if (data.message_type === 'warning') {
          // Realtime may otherwise silently log a request that asked for ZRM.
          if (!config.enableLogging) fail('retention_not_applied');
          return;
        }
        if (data.message_type === 'partial_transcript' || data.message_type === 'committed_transcript') {
          if (typeof data.text !== 'string' || [...data.text].length > 2000) { fail('invalid_transcript'); return; }
          emit({ type: data.message_type === 'partial_transcript' ? 'partial' : 'committed', text: data.text.trim() });
        } else {
          // Unknown metadata is ignored; known errors are never mistaken for a final result.
          const errors = ['error', 'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error', 'invalid_request',
            'rate_limited', 'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded',
            'chunk_size_exceeded', 'insufficient_audio_activity', 'unaccepted_terms', 'commit_throttled'];
          if (errors.includes(String(data.message_type))) fail('provider_unavailable', String(data.message_type));
        }
      } catch { fail('invalid_transcript'); }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      fail('provider_unavailable', 'http_upgrade_failed', response.statusCode);
      socket.terminate();
    });
    socket.on('error', () => fail());
    socket.on('close', () => { if (!closed) fail('speech_stream_closed'); });
    function send(pcm: Buffer, commit = false): void {
      if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 128 * 1024) {
        throw new PipelineError('speech_backpressure', 503);
      }
      socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'),
        sample_rate: 16000, ...(commit ? { commit: true } : {}) }));
    }
    return { ready, send, commit: () => send(Buffer.alloc(0), true), close: () => {
      closed = true; reject(new PipelineError('turn_canceled', 409)); socket.terminate();
    } };
  };
}
