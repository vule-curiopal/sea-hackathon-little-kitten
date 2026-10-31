import { LIMITS, type PlaybackReceipt, type TurnResponse } from '@miu/voice-contracts';
import { VoiceClientError, notify } from './errors.js';
import { newRequestId } from './api.js';

export type PlaybackState = 'idle' | 'starting' | 'speaking' | 'blocked';
export type PlaybackResult = 'playing' | 'blocked' | 'canceled';
export type PlaybackEvent =
  | { type: 'state'; state: PlaybackState }
  | { type: 'error'; error: VoiceClientError }
  | { type: 'receipt_error'; error: VoiceClientError };
export interface PlaybackEnvironment {
  createAudio(): HTMLAudioElement;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  decodeBase64(base64: string): string;
}
export interface PlaybackOptions { environment?: PlaybackEnvironment; createRequestId?: () => string }
export type ReceiptSender = (receipt: PlaybackReceipt) => Promise<void>;

interface ActivePlayback {
  audio: HTMLAudioElement;
  url: string;
  turn: TurnResponse;
  sendReceipt: ReceiptSender;
  started: boolean;
  completed: boolean;
  interrupted: boolean;
  receiptChain: Promise<void>;
  cleanups: (() => void)[];
  cancelAttempts: Set<() => void>;
}

export function browserPlaybackEnvironment(): PlaybackEnvironment {
  return {
    createAudio: () => new Audio(), createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url), decodeBase64: base64 => atob(base64),
  };
}

/** Playback receipts describe real media events, not successful provider requests. */
export class VoicePlayback {
  private readonly environment: PlaybackEnvironment;
  private readonly makeId: () => string;
  private readonly listeners = new Set<(event: PlaybackEvent) => void>();
  private readonly pendingReceipts = new Set<Promise<void>>();
  private active: ActivePlayback | null = null;
  private currentState: PlaybackState = 'idle';

  constructor(options: PlaybackOptions = {}) {
    this.environment = options.environment ?? browserPlaybackEnvironment();
    this.makeId = options.createRequestId ?? newRequestId;
  }
  get state(): PlaybackState { return this.currentState; }
  subscribe(listener: (event: PlaybackEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async play(turn: TurnResponse, sendReceipt: ReceiptSender, signal?: AbortSignal): Promise<PlaybackResult> {
    this.stop();
    if (signal?.aborted) return 'canceled';
    const mime = turn.audio.mime_type.split(';')[0]?.trim().toLowerCase();
    if (!mime || !['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/webm'].includes(mime)) {
      throw new VoiceClientError('UNSUPPORTED_AUDIO', 'The response audio container is unsupported.');
    }
    let binary: string;
    try { binary = this.environment.decodeBase64(turn.audio.data_base64); }
    catch { throw new VoiceClientError('INVALID_AUDIO', 'The response audio is not valid base64.'); }
    if (!binary.length || binary.length > LIMITS.audioBytes) throw new VoiceClientError('INVALID_AUDIO', 'The response audio has an invalid size.');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const audio = this.environment.createAudio();
    const url = this.environment.createObjectURL(new Blob([bytes], { type: turn.audio.mime_type }));
    const active: ActivePlayback = {
      audio, url, turn, sendReceipt, started: false, completed: false, interrupted: false,
      receiptChain: Promise.resolve(), cleanups: [], cancelAttempts: new Set(),
    };
    this.active = active;
    audio.preload = 'auto';
    audio.src = url;
    this.listen(active, 'playing', () => {
      if (!active.started) { active.started = true; this.receipt(active, 'started'); }
      this.setState('speaking');
    });
    this.listen(active, 'ended', () => {
      if (active.started && !active.completed) { active.completed = true; this.receipt(active, 'completed'); }
      this.active = null;
      this.dispose(active);
      this.setState('idle');
    });
    this.listen(active, 'pause', () => { if (!audio.ended && active.started) this.stop(); });
    this.listen(active, 'error', () => {
      this.stop();
      notify(this.listeners, { type: 'error', error: new VoiceClientError('PLAYBACK_FAILED', 'Audio playback failed.', true) });
    });
    if (signal) {
      const abort = () => { if (this.active === active) this.stop(); };
      signal.addEventListener('abort', abort, { once: true });
      active.cleanups.push(() => signal.removeEventListener('abort', abort));
    }
    return this.attempt(active);
  }

  /** Invoke from a fresh Play button gesture after a blocked autoplay attempt. */
  async resume(): Promise<PlaybackResult> {
    const active = this.active;
    return active ? this.attempt(active) : 'canceled';
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (active.started && !active.completed && !active.interrupted) {
      active.interrupted = true;
      this.receipt(active, 'interrupted');
    }
    this.dispose(active);
    this.setState('idle');
  }

  async flushReceipts(): Promise<void> { await Promise.all([...this.pendingReceipts]); }

  private async attempt(active: ActivePlayback): Promise<PlaybackResult> {
    if (this.active !== active) return 'canceled';
    if (active.audio.paused === false && active.started) return 'playing';
    this.setState('starting');
    if (this.active !== active) return 'canceled';
    let cancelAttempt!: () => void;
    const canceled = new Promise<'canceled'>(resolve => { cancelAttempt = () => resolve('canceled'); });
    active.cancelAttempts.add(cancelAttempt);
    try {
      const result = await Promise.race([active.audio.play().then(() => 'playing' as const), canceled]);
      if (result === 'canceled' || this.active !== active) return 'canceled';
      return 'playing';
    } catch (error) {
      if (this.active !== active) return 'canceled';
      if (error instanceof Error && error.name === 'NotAllowedError') {
        this.setState('blocked');
        return 'blocked';
      }
      this.stop();
      throw new VoiceClientError('PLAYBACK_FAILED', 'Audio playback could not start.', true);
    } finally {
      active.cancelAttempts.delete(cancelAttempt);
    }
  }

  private receipt(active: ActivePlayback, status: PlaybackReceipt['status']): void {
    const played = Number.isFinite(active.audio.currentTime) ? Math.max(0, active.audio.currentTime * 1000) : 0;
    const receipt: PlaybackReceipt = {
      request_id: this.makeId(), status,
      played_ms: Math.round(Math.min(played, active.turn.audio.duration_ms)), state_version: active.turn.state_version,
    };
    const pending = active.receiptChain.then(() => active.sendReceipt(receipt)).catch(() => {
      notify(this.listeners, { type: 'receipt_error', error: new VoiceClientError('RECEIPT_FAILED', 'Playback receipt was not accepted.', true) });
    });
    active.receiptChain = pending;
    this.pendingReceipts.add(pending);
    void pending.finally(() => this.pendingReceipts.delete(pending));
  }

  private dispose(active: ActivePlayback): void {
    for (const cancel of active.cancelAttempts) cancel();
    active.cancelAttempts.clear();
    for (const remove of active.cleanups.splice(0)) remove();
    try { active.audio.pause(); } catch { /* Audio may be interrupted already. */ }
    active.audio.removeAttribute('src');
    try { active.audio.load(); } catch { /* Release the source even on decoder failures. */ }
    this.environment.revokeObjectURL(active.url);
  }
  private listen(active: ActivePlayback, type: string, callback: () => void): void {
    const listener = () => { if (this.active === active) callback(); };
    active.audio.addEventListener(type, listener);
    active.cleanups.push(() => active.audio.removeEventListener(type, listener));
  }
  private setState(state: PlaybackState): void {
    this.currentState = state;
    notify(this.listeners, { type: 'state', state });
  }
}
