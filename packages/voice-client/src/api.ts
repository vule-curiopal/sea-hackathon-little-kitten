import { DEFAULT_VOICE, LIMITS, VOICES, type ApiError, type FamilyConfig, type Language,
  type PlaybackReceipt, type SessionResponse, type TurnResponse, type Versions } from '@miu/voice-contracts';
import { audioFileExtension, type CapturedAudio } from './capture.js';
import { VoiceClientError, canceledError } from './errors.js';

export interface ConfigurationResponse extends Versions { configuration: FamilyConfig }
export interface VoiceApiOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  createRequestId?: () => string;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
}
export interface SubmitTurnOptions {
  requestId: string;
  audio: CapturedAudio | Blob;
  fixtureId?: string;
  signal?: AbortSignal;
}

export function voicesForLanguage(language: Language): (typeof VOICES)[number][] {
  return VOICES.filter(voice => voice.language === language);
}

export function newRequestId(): string {
  if (!globalThis.crypto?.randomUUID) throw new VoiceClientError('INSECURE_CONTEXT', 'Secure UUID generation is unavailable.');
  return globalThis.crypto.randomUUID();
}

function validLanguage(language: unknown): language is Language { return language === 'vi' || language === 'en'; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(canceledError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(canceledError());
      else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function validateSession(value: unknown): SessionResponse {
  if (!record(value) || typeof value.session_id !== 'string' || typeof value.demo_token !== 'string'
    || !record(value.configuration) || !validLanguage(value.configuration.language_mode)
    || typeof value.configuration.voice_id !== 'string' || typeof value.clock_version !== 'number'
    || typeof value.state_version !== 'number' || !['fake', 'real'].includes(String(value.provider_mode))) {
    throw new VoiceClientError('INVALID_RESPONSE', 'The session response does not match the voice contract.');
  }
  return value as unknown as SessionResponse;
}

function validateTurn(value: unknown, session: SessionResponse, requestId: string): TurnResponse {
  if (!record(value) || value.session_id !== session.session_id || value.turn_id !== requestId
    || !record(value.reply) || typeof value.reply.text !== 'string' || !value.reply.text.trim()
    || [...value.reply.text].length > LIMITS.replyChars || value.reply.language !== session.configuration.language_mode
    || !record(value.audio) || typeof value.audio.mime_type !== 'string' || typeof value.audio.data_base64 !== 'string'
    || !value.audio.data_base64 || value.audio.data_base64.length > Math.ceil(LIMITS.audioBytes / 3) * 4
    || typeof value.audio.duration_ms !== 'number' || !Number.isFinite(value.audio.duration_ms) || value.audio.duration_ms < 0
    || typeof value.clock_version !== 'number' || typeof value.state_version !== 'number'
    || value.clock_version < session.clock_version || value.state_version < session.state_version) {
    throw new VoiceClientError('INVALID_RESPONSE', 'The turn response does not match the current voice contract.');
  }
  return value as unknown as TurnResponse;
}

/** Canonical application API only. Provider API keys never belong in this client. */
export class VoiceApiClient {
  private readonly transport: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly makeId: () => string;

  constructor(private readonly options: VoiceApiOptions = {}) {
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.makeId = options.createRequestId ?? newRequestId;
    if (![options.requestTimeoutMs ?? 30000, options.cancelTimeoutMs ?? 5000].every(value => Number.isFinite(value) && value > 0)) {
      throw new RangeError('Request deadlines must be positive and finite.');
    }
  }

  createRequestId(): string { return this.makeId(); }

  async createSession(demoProfileKey: string, signal?: AbortSignal): Promise<SessionResponse> {
    const response = await this.request('/api/sessions', {
      method: 'POST', body: JSON.stringify({ demo_profile_key: demoProfileKey, request_id: this.makeId() }),
      headers: { 'Content-Type': 'application/json' },
    }, signal);
    return validateSession(response);
  }

  async configure(session: SessionResponse, language: Language, voiceId = DEFAULT_VOICE[language], signal?: AbortSignal): Promise<ConfigurationResponse> {
    if (!validLanguage(language) || !VOICES.some(voice => voice.language === language && voice.id === voiceId)) {
      throw new VoiceClientError('INVALID_CONFIGURATION', 'Select an approved voice for the chosen language.');
    }
    const value = await this.request('/api/profiles/current/config', {
      method: 'PATCH', headers: this.headers(session, true),
      body: JSON.stringify({ request_id: this.makeId(), language_mode: language, voice_id: voiceId }),
    }, signal);
    if (!record(value) || !record(value.configuration) || value.configuration.language_mode !== language
      || value.configuration.voice_id !== voiceId || typeof value.clock_version !== 'number' || typeof value.state_version !== 'number') {
      throw new VoiceClientError('INVALID_RESPONSE', 'The configuration response does not match the voice contract.');
    }
    return value as unknown as ConfigurationResponse;
  }

  async submitTurn(session: SessionResponse, options: SubmitTurnOptions): Promise<TurnResponse> {
    const audio = options.audio instanceof Blob ? options.audio : options.audio.blob;
    if (!audio.size || audio.size > LIMITS.audioBytes) throw new VoiceClientError('AUDIO_TOO_LARGE', 'Recording is empty or exceeds the size limit.');
    const extension = audioFileExtension(audio.type);
    if (session.provider_mode === 'fake' && !options.fixtureId) {
      throw new VoiceClientError('MISSING_FIXTURE', 'Fake mode needs a declared voice fixture.');
    }
    if (session.provider_mode === 'real' && options.fixtureId) {
      throw new VoiceClientError('INVALID_FIXTURE', 'Fixtures cannot be sent in real mode.');
    }
    const form = new FormData();
    form.set('request_id', options.requestId);
    form.set('kind', 'utterance');
    form.set('audio', audio, `recording.${extension}`);
    form.set('language_hint', session.configuration.language_mode);
    if (options.fixtureId) form.set('fixture_id', options.fixtureId);
    const value = await this.request(`/api/sessions/${encodeURIComponent(session.session_id)}/turns`, {
      method: 'POST', headers: this.headers(session), body: form,
    }, options.signal);
    return validateTurn(value, session, options.requestId);
  }

  /** Uses its own deadline/signal: aborting the upload must not abort the cancellation. */
  async cancelTurn(session: SessionResponse, turnId: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(session.session_id)}/turns/${encodeURIComponent(turnId)}`, {
      method: 'DELETE', headers: this.headers(session),
    }, undefined, this.options.cancelTimeoutMs ?? 5000);
  }

  async playback(session: SessionResponse, turnId: string, receipt: PlaybackReceipt): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(session.session_id)}/turns/${encodeURIComponent(turnId)}/playback`, {
      method: 'POST', headers: this.headers(session, true), body: JSON.stringify(receipt),
    });
  }

  async endSession(session: SessionResponse): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(session.session_id)}`, {
      method: 'DELETE', headers: this.headers(session),
    });
  }

  private headers(session: SessionResponse, json = false): Record<string, string> {
    return { Authorization: `Bearer ${session.demo_token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  private async request(path: string, init: RequestInit, parentSignal?: AbortSignal, timeoutMs = this.options.requestTimeoutMs ?? 30000): Promise<unknown> {
    if (parentSignal?.aborted) throw canceledError();
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await abortable(this.transport(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' }), controller.signal);
      // A transport may ignore abort; never accept its late result.
      if (parentSignal?.aborted) throw canceledError();
      if (timedOut) throw new VoiceClientError('TIMEOUT', 'The voice request timed out.', true);
      if (response.status === 204) return undefined;
      let value: unknown;
      try { value = await abortable(response.json(), controller.signal); }
      catch { throw new VoiceClientError('INVALID_RESPONSE', 'The server returned an invalid response.', true, response.status); }
      if (parentSignal?.aborted) throw canceledError();
      if (timedOut) throw new VoiceClientError('TIMEOUT', 'The voice request timed out.', true);
      if (!response.ok) {
        const apiError = value as Partial<ApiError> | null;
        const code = record(apiError?.error) && typeof apiError.error.code === 'string' ? apiError.error.code : 'API_FAILED';
        throw new VoiceClientError(code, 'The server could not complete the voice request.',
          record(apiError?.error) && apiError.error.retryable === true, response.status);
      }
      return value;
    } catch (error) {
      if (parentSignal?.aborted) throw canceledError();
      if (timedOut) throw new VoiceClientError('TIMEOUT', 'The voice request timed out.', true);
      if (error instanceof VoiceClientError) throw error;
      throw new VoiceClientError('NETWORK_ERROR', 'The voice service could not be reached.', true);
    } finally {
      globalThis.clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    }
  }
}
