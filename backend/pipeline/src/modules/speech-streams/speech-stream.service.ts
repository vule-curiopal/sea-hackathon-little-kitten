import { randomUUID } from 'node:crypto';
import { LIMITS, type TurnResponse } from '@miu/voice-contracts';
import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';
import type { RealtimeSttConnection, RealtimeSttEvent, RealtimeSttFactory } from '../../providers/elevenlabs/realtime-stt.provider.js';
import type { SessionService } from '../sessions/session.service.js';
import type { Session } from '../sessions/session.types.js';
import type { TurnService } from '../turns/turn.service.js';
import { logEvent } from '../../logger.js';

export type StreamMessage = Record<string, unknown>;

/** Owns one utterance: segments are buffered, then a manual drain fences the engine call. */
export class SpeechStreamService {
  private readonly reservationId = randomUUID();
  private controller!: AbortController;
  private provider?: RealtimeSttConnection;
  private segments: string[] = [];
  private phase: 'connecting' | 'listening' | 'end_requested' | 'draining' | 'processing' | 'done' | 'canceled' = 'connecting';
  private sequence = 0;
  private bytes = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private noSpeechTimer?: ReturnType<typeof setTimeout>;
  private drainResolve?: () => void;
  private drainReject?: (error: Error) => void;
  private finished = false;
  private partials = 0;
  private readonly startedAt = performance.now();

  private log(event: string, fields: Record<string, unknown> = {}): void {
    logEvent(event, { session_id: this.options.session.id, turn_id: this.options.turnId,
      duration_ms: performance.now() - this.startedAt, ...fields });
  }

  constructor(private readonly options: {
    config: VoiceConfig; session: Session; turnId: string; sessions: SessionService; turns: TurnService;
    factory: RealtimeSttFactory; emit(message: StreamMessage): void; fail(error: unknown): void;
  }) {}

  async start(): Promise<void> {
    const { session, sessions, turnId, factory } = this.options;
    // Session/token/config are already held in RAM after session setup.
    // TurnService reconciles persistent state only after the final transcript is ready;
    // stale changes then abort this reservation before the engine can run.
    if (this.phase !== 'connecting') throw new PipelineError('turn_canceled', 409);
    this.controller = sessions.reserveInput(session, turnId, this.reservationId);
    this.controller.signal.addEventListener('abort', () => this.options.fail(new PipelineError('turn_canceled', 409)), { once: true });
    this.provider = factory(session.profile.configuration.language_mode, event => this.providerEvent(event), { session_id: session.id, turn_id: turnId });
    this.log('stt.connecting', { silence_ms: this.options.config.realtimeSilenceMs });
    await Promise.race([this.provider.ready, this.deadline(10_000, 'provider_timeout')]);
    if (this.phase !== 'connecting' || this.controller.signal.aborted) throw new PipelineError('turn_canceled', 409);
    this.phase = 'listening';
    this.log('stt.ready');
    this.timers.push(setTimeout(() => this.options.fail(new PipelineError('recording_limit', 422)), LIMITS.recordingMs));
    // Allow provider startup/partial latency before concluding that no speech was recognized.
    this.noSpeechTimer = setTimeout(() => this.options.fail(new PipelineError('unclear_audio', 422)), 8000);
    this.options.emit({ type: 'stream.ready', sample_rate: 16000, chunk_ms: 200, max_recording_ms: LIMITS.recordingMs,
      silence_ms: this.options.config.realtimeSilenceMs, filter_background_audio: true });
  }

  audio(sequence: number, pcm: Buffer): void {
    if (!['listening', 'end_requested'].includes(this.phase) || sequence !== this.sequence
      || pcm.length === 0 || pcm.length % 2 || pcm.length > 32_000) throw new PipelineError('invalid_audio_sequence', 400);
    this.bytes += pcm.length;
    if (this.bytes > 16000 * 2 * LIMITS.recordingMs / 1000) throw new PipelineError('recording_limit', 422);
    this.sequence++;
    if (this.sequence === 1) this.log('stt.audio_started');
    this.provider!.send(pcm);
  }

  async end(lastSequence: number): Promise<TurnResponse> {
    if (!['listening', 'end_requested'].includes(this.phase) || lastSequence !== this.sequence - 1 || !this.bytes) {
      throw new PipelineError('invalid_audio_sequence', 400);
    }
    this.phase = 'draining';
    this.log('stt.draining', { chunks: this.sequence, bytes: this.bytes, audio_ms: this.bytes / 32, partials: this.partials });
    const drainStarted = performance.now();
    this.clearTimers();
    const drained = new Promise<void>((resolve, reject) => { this.drainResolve = resolve; this.drainReject = reject; });
    // Attach rejection handlers before sending: an injected transport can acknowledge synchronously.
    const boundedDrain = Promise.race([drained, this.deadline(10_000, 'speech_drain_timeout')]);
    try { this.provider!.commit(); } catch (error) { void boundedDrain.catch(() => {}); throw error; }
    await boundedDrain;
    if (this.controller.signal.aborted || this.phase !== 'draining') throw new PipelineError('turn_canceled', 409);
    this.provider!.close();
    const transcript = this.segments.join(' ').trim();
    if (!transcript || [...transcript].length > LIMITS.transcriptChars) throw new PipelineError('unclear_audio', 422);
    this.phase = 'processing';
    this.log('stt.final', { characters: [...transcript].length, segments: this.segments.length, partials: this.partials });
    this.options.emit({ type: 'stream.drained' });
    this.options.emit({ type: 'transcript.final', text: transcript });
    this.options.emit({ type: 'stream.processing' });
    const response = await this.options.turns.execute(this.options.session, {
      requestId: this.options.turnId, kind: 'utterance', text: transcript,
      languageHint: this.options.session.profile.configuration.language_mode,
      reservationId: this.reservationId, inputSource: 'realtime_stt',
    }, this.controller.signal);
    response.timings_ms.stt = Math.max(0, Math.round(performance.now() - drainStarted - response.timings_ms.server_total));
    response.timings_ms.server_total += response.timings_ms.stt;
    this.phase = 'done'; this.finished = true; this.clearTimers();
    return response;
  }

  cancel(): void {
    if (this.finished || this.phase === 'canceled') return;
    this.log('stt.canceled', { stage: this.phase, chunks: this.sequence, bytes: this.bytes, partials: this.partials, segments: this.segments.length });
    this.phase = 'canceled';
    this.clearTimers(); this.provider?.close();
    this.drainReject?.(new PipelineError('turn_canceled', 409));
    this.options.sessions.releaseInput(this.options.session, this.reservationId);
    this.controller?.abort();
  }

  private providerEvent(event: RealtimeSttEvent): void {
    if (this.phase === 'canceled' || this.phase === 'done' || this.phase === 'processing') return;
    if (event.type === 'error') { this.options.fail(new PipelineError(event.code, 503)); return; }
    if (event.text) { clearTimeout(this.noSpeechTimer); this.noSpeechTimer = undefined; }
    if (event.type === 'partial') {
      if (++this.partials === 1) this.log('stt.first_partial', { characters: [...event.text].length });
      this.options.emit({ type: 'transcript.partial', text: event.text }); return;
    }
    if (event.text) {
      this.segments.push(event.text);
      this.log('stt.segment', { segments: this.segments.length, characters: [...event.text].length });
      if ([...this.segments.join(' ')].length > LIMITS.transcriptChars) {
        this.options.fail(new PipelineError('invalid_transcript', 422)); return;
      }
      this.options.emit({ type: 'transcript.segment', text: event.text });
    }
    if (this.phase === 'draining') {
      // An empty committed_transcript is a valid acknowledgement of a silence-only final commit.
      this.drainResolve?.();
    } else if (event.text && this.phase === 'listening') {
      this.phase = 'end_requested';
      this.options.emit({ type: 'turn.end_candidate' });
      this.timers.push(setTimeout(() => this.options.fail(new PipelineError('speech_drain_timeout', 504)), 3000));
    }
  }

  private deadline(ms: number, code: string): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.timers.push(setTimeout(() => reject(new PipelineError(code, 504)), ms));
    });
  }
  private clearTimers(): void {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    clearTimeout(this.noSpeechTimer);
  }
}
