import { type Language, type SessionResponse, type TurnResponse } from '@miu/voice-contracts';
import { VoiceApiClient, type VoiceApiOptions, type CharacterConfiguration } from './api.js';
import { BrowserVoiceCapture, type CaptureEvent, type CaptureOptions, type CapturedAudio } from './capture.js';
import { asClientError, canceledError, isCanceled, isSessionExpired, notify, VoiceClientError } from './errors.js';
import { VoicePlayback, type PlaybackEvent, type PlaybackOptions, type PlaybackResult, type ReceiptSender } from './playback.js';
import { RealtimeVoiceCapture } from './realtime/capture.js';

export type VoiceControllerState = 'idle' | 'initializing' | 'recording' | 'processing' | 'speaking' | 'playback_blocked' | 'error';
export type VoiceControllerEvent =
  | { type: 'state'; state: VoiceControllerState }
  | { type: 'capture'; event: CaptureEvent }
  | { type: 'playback'; event: PlaybackEvent }
  | { type: 'turn'; response: TurnResponse }
  | { type: 'error'; error: VoiceClientError };

export interface CapturePort {
  start(): Promise<CapturedAudio>;
  send(): boolean;
  cancel(): void;
  subscribe?(listener: (event: CaptureEvent) => void): () => void;
}
export interface PlaybackPort {
  play(turn: TurnResponse, sendReceipt: ReceiptSender, signal?: AbortSignal): Promise<PlaybackResult>;
  resume(): Promise<PlaybackResult>;
  stop(): void;
  flushReceipts(): Promise<void>;
  subscribe?(listener: (event: PlaybackEvent) => void): () => void;
}
export type VoiceApiPort = Pick<VoiceApiClient,
  'createRequestId' | 'createSession' | 'configure' | 'submitTurn' | 'cancelTurn' | 'playback' | 'endSession'> & Partial<Pick<VoiceApiClient, 'submitText' | 'speechCapabilities'>>;
export interface RealtimeCapturePort {
  start(session: SessionResponse, requestId: string, signal: AbortSignal, onProcessing: () => void, beforeConnect?: Promise<unknown>): Promise<TurnResponse>;
  send(): boolean; cancel(): void; subscribe?(listener: (event: CaptureEvent) => void): () => void;
}
export interface VoiceControllerOptions { api: VoiceApiPort; capture: CapturePort; playback: PlaybackPort; realtime?: RealtimeCapturePort }
interface ActiveTurn { id: string; session: SessionResponse; abort: AbortController; response?: TurnResponse }

/** Framework-independent coordinator. A frontend owns layout, captions and rendering. */
export class VoiceController {
  private readonly listeners = new Set<(event: VoiceControllerEvent) => void>();
  private readonly unsubscriptions: (() => void)[] = [];
  private active: ActiveTurn | null = null;
  private currentSession: SessionResponse | null = null;
  private currentState: VoiceControllerState = 'idle';
  private setupGeneration = 0;
  private setupAbort: AbortController | null = null;
  private pendingCancellation: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly ports: VoiceControllerOptions) {
    const captureUnsubscribe = ports.capture.subscribe?.(event => notify(this.listeners, { type: 'capture', event }));
    if (captureUnsubscribe) this.unsubscriptions.push(captureUnsubscribe);
    const realtimeUnsubscribe = ports.realtime?.subscribe?.(event => {
      if (event.type === 'transcript_final' && (this.active?.id !== event.requestId || this.active.abort.signal.aborted)) return;
      notify(this.listeners, { type: 'capture', event });
    });
    if (realtimeUnsubscribe) this.unsubscriptions.push(realtimeUnsubscribe);
    const playbackUnsubscribe = ports.playback.subscribe?.(event => {
      notify(this.listeners, { type: 'playback', event });
      if (event.type === 'error') this.setState('error');
      if (event.type === 'state' && this.active?.response) {
        if (event.state === 'speaking') this.setState('speaking');
        else if (event.state === 'blocked') this.setState('playback_blocked');
        else if (event.state === 'idle') { this.active = null; this.setState('idle'); }
      }
    });
    if (playbackUnsubscribe) this.unsubscriptions.push(playbackUnsubscribe);
  }

  get state(): VoiceControllerState { return this.currentState; }
  get session(): SessionResponse | null {
    return this.currentSession ? { ...this.currentSession, configuration: { ...this.currentSession.configuration } } : null;
  }
  subscribe(listener: (event: VoiceControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async openProfile(demoProfileKey: string, language: Language, voiceId?: string, character: CharacterConfiguration = {}): Promise<SessionResponse> {
    this.ensureAvailable();
    const stopped = this.stop();
    const previous = this.currentSession;
    this.currentSession = null;
    const generation = ++this.setupGeneration;
    const abort = new AbortController();
    this.setupAbort = abort;
    this.setState('initializing');
    let created: SessionResponse | null = null;
    try {
      await stopped.catch(error => { if (!isSessionExpired(error)) throw error; });
      await this.ports.playback.flushReceipts();
      if (abort.signal.aborted || generation !== this.setupGeneration) throw canceledError();
      if (previous) await this.ports.api.endSession(previous).catch(error => { if (!isSessionExpired(error)) throw error; });
      if (abort.signal.aborted || generation !== this.setupGeneration) throw canceledError();
      created = await this.ports.api.createSession(demoProfileKey, abort.signal);
      if (abort.signal.aborted || generation !== this.setupGeneration) throw canceledError();
      const configured = await this.ports.api.configure(created, language, voiceId, abort.signal, character);
      const capabilities = created.provider_mode === 'real' ? await this.ports.api.speechCapabilities?.(abort.signal) : undefined;
      if (abort.signal.aborted || generation !== this.setupGeneration) throw canceledError();
      this.currentSession = { ...created, ...configured,
        ...(capabilities?.input_mode === 'elevenlabs_realtime' ? { speech_input_mode: 'elevenlabs_realtime' as const } : {}),
      };
      this.setupAbort = null;
      this.setState('idle');
      return this.session!;
    } catch (error) {
      if (created) void this.ports.api.endSession(created).catch(() => {});
      if (generation === this.setupGeneration) {
        this.setupAbort = null;
        this.handleError(error);
      }
      throw asClientError(error);
    }
  }

  async changeLanguage(language: Language, voiceId?: string): Promise<SessionResponse> {
    this.ensureAvailable();
    if (!this.currentSession) throw new VoiceClientError('SESSION_REQUIRED', 'Select a profile and language first.');
    if (this.active || this.setupAbort) throw new VoiceClientError('TURN_IN_PROGRESS', 'Finish the current operation before changing language.');
    const session = this.currentSession;
    const generation = ++this.setupGeneration;
    const abort = new AbortController();
    this.setupAbort = abort;
    try {
      const configured = await this.ports.api.configure(session, language, voiceId, abort.signal);
      if (abort.signal.aborted || generation !== this.setupGeneration) throw canceledError();
      this.currentSession = { ...session, ...configured };
      return this.session!;
    } finally { if (generation === this.setupGeneration) this.setupAbort = null; }
  }

  /** Call directly from Talk. Capture starts before awaiting remote cancellation. */
  talk(options: { fixtureId?: string } = {}): Promise<TurnResponse> {
    this.ensureAvailable();
    if (!this.currentSession || this.setupAbort) return Promise.reject(new VoiceClientError('SESSION_REQUIRED', 'Select a profile and language first.'));
    const cancelPrevious = this.stop();
    const session = this.session!;
    const active: ActiveTurn = { id: this.ports.api.createRequestId(), session, abort: new AbortController() };
    this.active = active;
    this.setState('recording');
    if (this.active !== active) return Promise.reject(canceledError());
    if (session.speech_input_mode === 'elevenlabs_realtime') {
      return this.processRealtimeTurn(active, cancelPrevious);
    }
    const capture = this.ports.capture.start();
    return this.processTurn(active, capture, cancelPrevious, options.fixtureId);
  }

  send(): boolean { return this.currentSession?.speech_input_mode === 'elevenlabs_realtime' ? this.ports.realtime?.send() ?? false : this.ports.capture.send(); }

  text(text: string, options: { textOnly?: boolean } = {}): Promise<TurnResponse> {
    return this.processText('utterance', text, options.textOnly === true);
  }

  greet(options: { textOnly?: boolean } = {}): Promise<TurnResponse> {
    return this.processText('greeting', undefined, options.textOnly === true);
  }

  /** Call from an explicit "Done reading" action after displaying an approved text-only answer. */
  async acknowledgeText(): Promise<void> {
    const active = this.active;
    if (!active?.response || active.response.audio !== null) return;
    try {
      await this.ports.api.playback(active.session, active.id, {
        request_id: this.ports.api.createRequestId(), status: 'started', played_ms: 0, state_version: active.response.state_version,
      });
      this.assertCurrent(active);
      await this.ports.api.playback(active.session, active.id, {
        request_id: this.ports.api.createRequestId(), status: 'completed', played_ms: 0, state_version: active.response.state_version,
      });
      this.assertCurrent(active);
      this.active = null; this.setState('idle');
    } catch (error) {
      if (this.expireSession(active.session, error)) this.handleError(error);
      throw asClientError(error);
    }
  }

  private async processText(kind: 'utterance' | 'greeting', text: string | undefined, textOnly: boolean): Promise<TurnResponse> {
    this.ensureAvailable();
    if (!this.currentSession || this.setupAbort) throw new VoiceClientError('SESSION_REQUIRED', 'Select a profile and language first.');
    if (!this.ports.api.submitText) throw new VoiceClientError('TEXT_UNAVAILABLE', 'The configured client does not support text.');
    const canceledPrevious = this.stop();
    const active: ActiveTurn = { id: this.ports.api.createRequestId(), session: this.session!, abort: new AbortController() };
    this.active = active; this.setState('processing');
    try {
      await canceledPrevious;
      await this.ports.playback.flushReceipts();
      this.assertCurrent(active);
      const response = await this.ports.api.submitText(active.session, { requestId: active.id, kind, text, textOnly, signal: active.abort.signal });
      return await this.present(active, response);
    } catch (error) { this.failTurn(active, error); throw asClientError(error); }
  }

  async resumePlayback(): Promise<PlaybackResult> {
    const active = this.active;
    if (!active?.response) return 'canceled';
    const result = await this.ports.playback.resume();
    if (this.active === active) this.setState(result === 'blocked' ? 'playback_blocked' : result === 'playing' ? 'speaking' : 'idle');
    return result;
  }

  /** Local capture/playback stop synchronously; the returned promise tracks server cancellation. */
  stop(): Promise<void> {
    this.setupGeneration++;
    this.setupAbort?.abort();
    this.setupAbort = null;
    const active = this.active;
    this.active = null;
    active?.abort.abort();
    this.ports.capture.cancel();
    this.ports.realtime?.cancel();
    this.ports.playback.stop();
    this.setState('idle');
    if (active) {
      // Send immediately with an independent signal; a server tombstone also covers upload races.
      const cancellation = this.ports.api.cancelTurn(active.session, active.id);
      const previous = this.pendingCancellation;
      const result = Promise.all([previous, cancellation]).then(() => {});
      this.pendingCancellation = result.catch(() => {});
      // Observers can surface a cancellation failure, without an unhandled rejection on local Stop.
      void result.catch(error => {
        const failure = asClientError(error, 'CANCEL_FAILED');
        if (isSessionExpired(failure)) {
          if (this.expireSession(active.session, failure)) this.handleError(failure);
        } else notify(this.listeners, { type: 'error', error: failure });
      });
      return result;
    }
    return this.pendingCancellation;
  }

  async close(): Promise<void> {
    const session = this.currentSession;
    this.currentSession = null;
    await this.stop();
    await this.ports.playback.flushReceipts();
    if (session) await this.ports.api.endSession(session);
  }

  async dispose(): Promise<void> {
    try { await this.close(); }
    finally {
      this.disposed = true;
      for (const unsubscribe of this.unsubscriptions.splice(0)) unsubscribe();
      this.listeners.clear();
    }
  }

  private async processTurn(active: ActiveTurn, capture: Promise<CapturedAudio>, canceledPrevious: Promise<void>, fixtureId?: string): Promise<TurnResponse> {
    try {
      // Observe both promises at once, even when cancellation fails while recording continues.
      const [audio] = await Promise.all([capture, canceledPrevious, this.ports.playback.flushReceipts()]);
      this.assertCurrent(active);
      this.setState('processing');
      const response = await this.ports.api.submitTurn(active.session, {
        requestId: active.id, audio, fixtureId, signal: active.abort.signal,
      });
      this.assertCurrent(active);
      return await this.present(active, response);
    } catch (error) { this.failTurn(active, error); throw asClientError(error); }
  }

  private async processRealtimeTurn(active: ActiveTurn, canceledPrevious: Promise<void>): Promise<TurnResponse> {
    try {
      if (!this.ports.realtime) throw new VoiceClientError('UNSUPPORTED_AUDIO', 'Realtime capture unavailable.');
      const response = await this.ports.realtime.start(active.session, active.id, active.abort.signal,
        () => { if (this.active === active) this.setState('processing'); },
        Promise.all([canceledPrevious, this.ports.playback.flushReceipts()]));
      this.assertCurrent(active);
      return await this.present(active, response);
    } catch (error) { this.failTurn(active, error); throw asClientError(error); }
  }

  private async present(active: ActiveTurn, response: TurnResponse): Promise<TurnResponse> {
      this.assertCurrent(active);
      active.response = response;
      this.currentSession = { ...active.session, state_version: response.state_version, clock_version: response.clock_version };
      notify(this.listeners, { type: 'turn', response });
      this.assertCurrent(active);
      if (response.audio === null) { this.setState('playback_blocked'); return response; }
      const result = await this.ports.playback.play(response,
        receipt => this.ports.api.playback(active.session, active.id, receipt).catch(error => {
          if (this.expireSession(active.session, error)) this.handleError(error);
          throw error;
        }), active.abort.signal);
      // A very short clip can finish before play() settles. Natural completion is not cancellation.
      if (this.active === null && !active.abort.signal.aborted && result === 'playing') return response;
      this.assertCurrent(active);
      if (result === 'blocked') this.setState('playback_blocked');
      else if (result === 'playing') this.setState('speaking');
      return response;
  }

  private failTurn(active: ActiveTurn, error: unknown): void {
      if (this.active === active) {
        this.active = null;
        active.abort.abort();
        this.ports.capture.cancel();
        this.ports.realtime?.cancel();
        this.ports.playback.stop();
        if (!isSessionExpired(error)) {
          void this.ports.api.cancelTurn(active.session, active.id).catch(reason => {
            if (this.expireSession(active.session, reason)) this.handleError(reason);
          });
        } else this.expireSession(active.session, error);
        this.handleError(error);
      }
  }

  /** Never keep recording or reuse a token the server has rejected. Stale cleanup cannot clear a replacement session. */
  private expireSession(session: SessionResponse, error: unknown): boolean {
    if (!isSessionExpired(error) || this.currentSession?.session_id !== session.session_id) return false;
    this.currentSession = null;
    const active = this.active;
    if (active?.session.session_id === session.session_id) {
      this.active = null; active.abort.abort();
      this.ports.capture.cancel(); this.ports.realtime?.cancel(); this.ports.playback.stop();
    }
    return true;
  }

  private assertCurrent(active: ActiveTurn): void { if (this.active !== active || active.abort.signal.aborted) throw canceledError(); }
  private setState(state: VoiceControllerState): void {
    this.currentState = state;
    notify(this.listeners, { type: 'state', state });
  }
  private handleError(error: unknown): void {
    this.setState(isCanceled(error) ? 'idle' : 'error');
    if (!isCanceled(error)) notify(this.listeners, { type: 'error', error: asClientError(error) });
  }
  private ensureAvailable(): void { if (this.disposed) throw new VoiceClientError('DISPOSED', 'The voice controller has been disposed.'); }
}

export function createVoiceClient(options: { api?: VoiceApiOptions; capture?: CaptureOptions; playback?: PlaybackOptions } = {}): {
  api: VoiceApiClient; capture: BrowserVoiceCapture; playback: VoicePlayback; controller: VoiceController;
} {
  const api = new VoiceApiClient(options.api);
  const capture = new BrowserVoiceCapture(options.capture);
  const playback = new VoicePlayback(options.playback);
  const realtime = new RealtimeVoiceCapture(options.api?.baseUrl);
  return { api, capture, playback, controller: new VoiceController({ api, capture, playback, realtime }) };
}
