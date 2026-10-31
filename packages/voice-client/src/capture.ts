import { LIMITS } from '@miu/voice-contracts';
import { AdaptiveSilenceDetector, rmsDbfs, type AdaptiveSilenceConfig, type MeterSnapshot } from './detector.js';
import { VoiceClientError, canceledError, notify } from './errors.js';

export const RECORDING_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm',
] as const;

export type CaptureState = 'idle' | 'requesting_permission' | 'calibrating' | 'recording' | 'finalizing_capture';
export type CaptureEvent =
  | { type: 'state'; state: CaptureState }
  | { type: 'meter'; snapshot: MeterSnapshot }
  | { type: 'manual_only'; code: 'METER_UNAVAILABLE' }
  | { type: 'error'; error: VoiceClientError };
export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  reason: 'manual' | 'silence' | 'max_duration';
  settings: MediaTrackSettings;
}

/** All side effects are injectable; importing the package does not access the microphone. */
export interface CaptureEnvironment {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(mimeType: string): boolean;
  now(): number;
  interval(callback: () => void, ms: number): () => void;
  timeout(callback: () => void, ms: number): () => void;
  isVisible(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  isSecureContext(): boolean;
}

export function browserCaptureEnvironment(): CaptureEnvironment {
  return {
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    createAudioContext: () => new AudioContext(),
    createRecorder: (stream, options) => new MediaRecorder(stream, options),
    isTypeSupported: mime => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
    now: () => performance.now(),
    interval: (callback, ms) => { const id = globalThis.setInterval(callback, ms); return () => globalThis.clearInterval(id); },
    timeout: (callback, ms) => { const id = globalThis.setTimeout(callback, ms); return () => globalThis.clearTimeout(id); },
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    onVisibilityChange: callback => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    isSecureContext: () => globalThis.isSecureContext === true,
  };
}

export interface CaptureOptions {
  /** Manual endpointing records until send/cancel; silence never submits a turn. */
  endpointing?: 'automatic' | 'manual';
  environment?: CaptureEnvironment;
  detector?: Partial<AdaptiveSilenceConfig>;
  microphone?: MediaTrackConstraints;
  mimeCandidates?: readonly string[];
  audioBitsPerSecond?: number;
  analysisIntervalMs?: number;
  analyserFftSize?: number;
  minimumUploadMs?: number;
  maxAudioBytes?: number;
  flushTimeoutMs?: number;
}

interface ActiveCapture {
  id: number;
  phase: 'permission' | 'recording' | 'finalizing';
  resolve(audio: CapturedAudio): void;
  reject(error: VoiceClientError): void;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  detector?: AdaptiveSilenceDetector;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  endedAt: number;
  settings: MediaTrackSettings;
  reason: CapturedAudio['reason'];
  cleanups: (() => void)[];
  stopMeter?: () => void;
  stopDeadline?: () => void;
  stopFlushDeadline?: () => void;
}

export function audioFileExtension(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/x-m4a') return 'm4a';
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav';
  throw new VoiceClientError('UNSUPPORTED_AUDIO', 'The audio container is not supported.');
}

/** One recording per instance. Call start directly in the Talk click/tap handler. */
export class BrowserVoiceCapture {
  private readonly environment: CaptureEnvironment;
  private readonly listeners = new Set<(event: CaptureEvent) => void>();
  private active: ActiveCapture | null = null;
  private generation = 0;
  private currentState: CaptureState = 'idle';
  private readonly detectorConfig: Readonly<AdaptiveSilenceConfig>;

  constructor(private readonly options: CaptureOptions = {}) {
    this.environment = options.environment ?? browserCaptureEnvironment();
    this.detectorConfig = new AdaptiveSilenceDetector(options.detector).config;
    if ((options.analysisIntervalMs ?? 20) <= 0 || (options.minimumUploadMs ?? 100) < 0
      || (options.maxAudioBytes ?? LIMITS.audioBytes) <= 0 || (options.flushTimeoutMs ?? 2000) <= 0) {
      throw new RangeError('Capture limits must be positive.');
    }
  }

  get state(): CaptureState { return this.currentState; }
  subscribe(listener: (event: CaptureEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<CapturedAudio> {
    this.cancel();
    const id = ++this.generation;
    return new Promise<CapturedAudio>((resolve, reject) => {
      const active: ActiveCapture = {
        id, phase: 'permission', resolve, reject, chunks: [], bytes: 0, startedAt: 0, endedAt: 0,
        settings: {}, reason: 'manual', cleanups: [],
      };
      this.active = active;
      this.setState('requesting_permission');
      // setup creates/resumes AudioContext synchronously before its first await.
      if (this.isCurrent(active)) void this.setup(active).catch(error => this.fail(active, this.captureError(error)));
    });
  }

  /** Releasing before permission resolves cancels instead of recording after the gesture ended. */
  send(): boolean {
    if (this.options.endpointing === 'manual' && this.active?.phase === 'permission') {
      this.cancel(); return false;
    }
    return this.finalize('manual');
  }

  cancel(code = 'CANCELED'): void {
    const active = this.active;
    if (!active) return;
    const error = code === 'CANCELED' ? canceledError() : new VoiceClientError(code, 'Recording was interrupted.', true);
    this.fail(active, error);
  }

  private isCurrent(active: ActiveCapture): boolean { return this.active === active && active.id === this.generation; }
  private setState(state: CaptureState): void {
    this.currentState = state;
    notify(this.listeners, { type: 'state', state });
  }

  private async setup(active: ActiveCapture): Promise<void> {
    const env = this.environment;
    if (!env.isSecureContext()) throw new VoiceClientError('INSECURE_CONTEXT', 'Microphone access requires HTTPS.');
    if (!env.isVisible()) throw canceledError();
    const mimeType = (this.options.mimeCandidates ?? RECORDING_MIME_CANDIDATES).find(mime => env.isTypeSupported(mime));
    if (!mimeType) throw new VoiceClientError('UNSUPPORTED_AUDIO', 'No supported recording container is available.');
    let resume: Promise<void> = Promise.resolve();
    let meterAvailable = true;
    try {
      active.context = env.createAudioContext();
      // Catch immediately: permission prompts may take longer than resume rejection.
      resume = active.context.resume().catch(() => { meterAvailable = false; });
    } catch { meterAvailable = false; }
    active.cleanups.push(env.onVisibilityChange(() => {
      if (!env.isVisible() && this.isCurrent(active)) this.cancel('CAPTURE_INTERRUPTED');
    }));
    const stream = await env.getUserMedia({
      audio: {
        echoCancellation: { ideal: true }, noiseSuppression: { ideal: true },
        autoGainControl: { ideal: false }, channelCount: { ideal: 1 }, ...this.options.microphone,
      },
      video: false,
    });
    if (!this.isCurrent(active)) { for (const track of stream.getTracks()) track.stop(); return; }
    active.stream = stream;
    active.settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
    for (const track of stream.getTracks()) this.listen(active, track, 'ended', () => this.cancel('MIC_DISCONNECTED'));
    await resume;
    if (!this.isCurrent(active)) return;
    if (!env.isVisible()) throw canceledError();
    const recorder = env.createRecorder(stream, { mimeType, audioBitsPerSecond: this.options.audioBitsPerSecond ?? 64000 });
    active.recorder = recorder;
    this.listen(active, recorder, 'dataavailable', event => {
      if (!this.isCurrent(active)) return;
      const blob = (event as BlobEvent).data;
      if (!blob.size) return;
      active.bytes += blob.size;
      if (active.bytes > (this.options.maxAudioBytes ?? LIMITS.audioBytes)) {
        this.fail(active, new VoiceClientError('AUDIO_TOO_LARGE', 'Recording exceeds the audio size limit.'));
        return;
      }
      active.chunks.push(blob);
    });
    this.listen(active, recorder, 'error', () => this.fail(active, new VoiceClientError('RECORDER_FAILED', 'Recording failed.', true)));
    this.listen(active, recorder, 'stop', () => {
      if (active.phase === 'finalizing') this.finish(active);
      else this.fail(active, new VoiceClientError('CAPTURE_INTERRUPTED', 'Recording stopped unexpectedly.', true));
    });
    if (meterAvailable && active.context?.state === 'running') {
      try {
        active.analyser = active.context.createAnalyser();
        active.analyser.fftSize = this.options.analyserFftSize ?? 1024;
        active.source = active.context.createMediaStreamSource(stream);
        active.source.connect(active.analyser);
      } catch { meterAvailable = false; }
    } else { meterAvailable = false; }
    if (!this.isCurrent(active)) return;
    recorder.start(250); // Local chunking only; no upload until final data + stop.
    active.startedAt = env.now();
    active.phase = 'recording';
    active.detector = new AdaptiveSilenceDetector(this.detectorConfig, active.startedAt);
    this.setState(meterAvailable && this.options.endpointing !== 'manual' ? 'calibrating' : 'recording');
    active.stopDeadline = env.timeout(() => {
      if (!this.isCurrent(active)) return;
      if (this.options.endpointing === 'manual') { this.cancel('RECORDING_LIMIT'); return; }
      if (active.detector?.snapshot.hasSignal) this.finalize('max_duration');
      else this.fail(active, new VoiceClientError('NO_SIGNAL', 'No signal was detected before the recording limit.', true));
    }, this.detectorConfig.maxRecordingMs);
    if (active.context) this.listen(active, active.context, 'statechange', () => {
      if (this.isCurrent(active) && active.phase === 'recording' && String(active.context?.state) !== 'running') {
        this.cancel('CAPTURE_INTERRUPTED');
      }
    });
    if (meterAvailable && active.analyser) {
      const samples = new Float32Array(active.analyser.fftSize);
      active.stopMeter = env.interval(() => {
        if (!this.isCurrent(active) || active.phase !== 'recording') return;
        try {
          active.analyser!.getFloatTimeDomainData(samples);
          const now = env.now();
          const levelDbfs = rmsDbfs(samples);
          const detected = active.detector!.update(levelDbfs, now);
          // The automatic detector may have reached a decision; a held recording's meter must keep updating.
          const snapshot: MeterSnapshot = this.options.endpointing === 'manual'
            ? { ...detected, phase: detected.hasSignal ? 'signal' : 'waiting', decision: null, elapsedMs: now - active.startedAt, timeMs: now, levelDbfs }
            : detected;
          notify(this.listeners, { type: 'meter', snapshot });
          if (!this.isCurrent(active)) return;
          if (snapshot.phase === 'waiting' && this.state === 'calibrating') this.setState('recording');
          if (this.options.endpointing !== 'manual' && snapshot.decision?.action === 'submit') this.finalize(snapshot.decision.reason);
          else if (this.options.endpointing !== 'manual' && snapshot.decision?.action === 'cancel') {
            this.fail(active, new VoiceClientError(snapshot.decision.reason === 'no_signal' ? 'NO_SIGNAL' : 'CAPTURE_INTERRUPTED',
              'The recording could not be finalized automatically.', true));
          }
        } catch {
          active.stopMeter?.();
          active.stopMeter = undefined;
          this.setState('recording');
          notify(this.listeners, { type: 'manual_only', code: 'METER_UNAVAILABLE' });
        }
      }, this.options.analysisIntervalMs ?? 20);
    } else { notify(this.listeners, { type: 'manual_only', code: 'METER_UNAVAILABLE' }); }
  }

  private finalize(reason: CapturedAudio['reason']): boolean {
    const active = this.active;
    if (!active || active.phase !== 'recording' || !active.recorder) return false;
    active.phase = 'finalizing';
    active.reason = reason;
    active.endedAt = this.environment.now();
    active.stopMeter?.();
    active.stopDeadline?.();
    this.setState('finalizing_capture');
    if (!this.isCurrent(active)) return true;
    active.stopFlushDeadline = this.environment.timeout(() => {
      this.fail(active, new VoiceClientError('RECORDER_TIMEOUT', 'The final recording data was not delivered.', true));
    }, this.options.flushTimeoutMs ?? 2000);
    try { active.recorder.stop(); }
    catch { this.fail(active, new VoiceClientError('RECORDER_FAILED', 'Recording could not be finalized.', true)); }
    return true;
  }

  private finish(active: ActiveCapture): void {
    if (!this.isCurrent(active)) return;
    const mimeType = active.recorder?.mimeType || active.chunks.find(chunk => chunk.type)?.type || '';
    try { audioFileExtension(mimeType); }
    catch (error) { this.fail(active, this.captureError(error)); return; }
    const durationMs = active.endedAt - active.startedAt;
    const blob = new Blob(active.chunks, { type: mimeType });
    if (!blob.size || durationMs < (this.options.minimumUploadMs ?? 100)) {
      this.fail(active, new VoiceClientError('NO_AUDIO', 'The recording is empty or too short.', true));
      return;
    }
    const result: CapturedAudio = { blob, mimeType, durationMs, reason: active.reason, settings: { ...active.settings } };
    this.active = null;
    this.cleanup(active);
    this.setState('idle');
    active.resolve(result);
  }

  private fail(active: ActiveCapture, error: VoiceClientError): void {
    if (!this.isCurrent(active)) return;
    this.active = null;
    this.generation++;
    this.cleanup(active);
    this.setState('idle');
    if (error.code !== 'CANCELED') notify(this.listeners, { type: 'error', error });
    active.reject(error);
  }

  private cleanup(active: ActiveCapture): void {
    active.stopMeter?.(); active.stopDeadline?.(); active.stopFlushDeadline?.();
    for (const remove of active.cleanups.splice(0)) remove();
    if (active.recorder && active.recorder.state !== 'inactive') {
      try { active.recorder.stop(); } catch { /* Already stopped by the browser. */ }
    }
    for (const track of active.stream?.getTracks() ?? []) track.stop();
    try { active.source?.disconnect(); } catch { /* Connection may not have completed. */ }
    try { void active.context?.close().catch(() => {}); } catch { /* Context may already be closed. */ }
    active.chunks.length = 0;
    active.bytes = 0;
  }

  private listen(active: ActiveCapture, target: EventTarget, type: string, callback: (event: Event) => void): void {
    const listener = (event: Event) => { if (this.isCurrent(active)) callback(event); };
    target.addEventListener(type, listener);
    active.cleanups.push(() => target.removeEventListener(type, listener));
  }

  private captureError(error: unknown): VoiceClientError {
    if (error instanceof VoiceClientError) return error;
    const name = error instanceof Error ? error.name : '';
    const code = name === 'NotAllowedError' ? 'MIC_PERMISSION_DENIED'
      : name === 'NotFoundError' ? 'MIC_NOT_FOUND' : 'CAPTURE_FAILED';
    return new VoiceClientError(code, 'Microphone recording could not start.', true);
  }
}
