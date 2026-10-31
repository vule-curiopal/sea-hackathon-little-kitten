import { createHash } from 'node:crypto';
import { LIMITS } from '@miu/voice-contracts';
import type { PlaybackReceipt, TurnResponse } from '@miu/voice-contracts';
import { inspectAudio } from '../../audio.js';
import type { VoiceConfig } from '../../config.js';
import { abortError, PipelineError } from '../../errors.js';
import type { PipelineProviders } from '../../ports.js';
import type { SessionService } from '../sessions/session.service.js';
import type { Session, TurnRecord } from '../sessions/session.types.js';
import { fingerprint, uuid } from '../sessions/session.utils.js';
import { validateReplyText } from './reply-policy.js';
import type { TurnSubmission } from './turn.types.js';

/** Bound even an adapter that ignores AbortSignal; late results never publish. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PipelineError('turn_canceled', 409));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(new PipelineError('turn_canceled', 409));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

export interface TurnServiceDependencies {
  config: Pick<VoiceConfig, 'turnTimeoutMs' | 'ffprobePath'>;
  providers: PipelineProviders;
  sessions: SessionService;
}

/** Runs a batch turn independently of HTTP. No conversation memory is retained. */
export class TurnService {
  constructor(private readonly dependencies: TurnServiceDependencies) {}

  cancel(session: Session, turnId: string) {
    this.dependencies.sessions.cancel(session, turnId);
    return { turn_id: turnId, canceled: true };
  }

  receipt(session: Session, turnId: string, receipt: PlaybackReceipt): unknown {
    return this.dependencies.sessions.receipt(session, turnId, receipt);
  }

  async execute(session: Session, input: TurnSubmission, externalSignal: AbortSignal): Promise<TurnResponse> {
    const { config, providers, sessions } = this.dependencies;
    abortError(externalSignal);
    let record: TurnRecord | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const cancel = () => {
      if (!record) return;
      record.controller.abort();
      record.status = 'canceled';
      record.response = undefined;
    };
    externalSignal.addEventListener('abort', cancel, { once: true });

    try {
      const { requestId: id, kind, languageHint, fixtureId, audio } = input;
      if (!uuid(id) || (kind !== 'utterance' && kind !== 'greeting')
        || (kind === 'utterance' && !audio?.bytes.length) || (kind === 'greeting' && audio !== undefined)) {
        throw new PipelineError('invalid_request', 400);
      }
      const language = session.profile.configuration.language_mode;
      if (languageHint !== undefined && !['vi', 'en', 'auto'].includes(languageHint)) {
        throw new PipelineError('invalid_language', 400);
      }
      if (languageHint !== undefined && languageHint !== 'auto' && languageHint !== language) {
        throw new PipelineError('language_mismatch', 400);
      }
      if (providers.mode === 'real' && fixtureId) throw new PipelineError('invalid_request', 400);

      const bodyFingerprint = fingerprint({
        kind,
        hint: languageHint,
        fixture: fixtureId,
        mimeType: audio?.mimeType ?? '',
        audio: audio ? createHash('sha256').update(audio.bytes).digest('hex') : null,
      });
      const started = sessions.begin(session, id, bodyFingerprint);
      record = started.turn;
      if (started.cached) return started.cached;
      if (kind === 'greeting' && session.sequence > 0) throw new PipelineError('greeting_not_eligible', 409);

      const signal = record.controller.signal;
      timeout = setTimeout(() => {
        timedOut = true;
        record?.controller.abort();
      }, config.turnTimeoutMs);
      timeout.unref();
      const start = performance.now();
      const timings = { stt: 0, reply: 0, validation: 0, tts: 0, server_total: 0 };
      const check = () => {
        abortError(signal);
        if (session.closed || record!.status === 'canceled') throw new PipelineError('turn_canceled', 409);
        if (record!.configVersion !== session.profile.stateVersion) throw new PipelineError('stale_state', 409);
      };
      check();

      let transcript: TurnResponse['transcript'] = null;
      if (audio) {
        const inspected = await bounded(inspectAudio(
          audio.bytes, audio.mimeType, audio.filename, signal, config.ffprobePath,
        ), signal);
        check();
        const stage = performance.now();
        const result = await bounded(providers.transcribe(
          { ...audio, ...inspected }, language, signal, fixtureId,
        ), signal);
        check();
        timings.stt = Math.round(performance.now() - stage);
        if (result.language !== language || !result.text.trim() || [...result.text].length > LIMITS.transcriptChars) {
          throw new PipelineError('unclear_audio', 422);
        }
        transcript = { text: result.text, language, uncertain_spans: [] };
      }

      let stage = performance.now();
      const generated = await bounded(providers.response.generate({
        turnId: id, text: transcript?.text ?? '', language, kind, fixtureId,
      }, signal), signal);
      check();
      timings.reply = Math.round(performance.now() - stage);
      stage = performance.now();
      if (generated.turnId !== id || generated.language !== language) throw new PipelineError('invalid_reply', 503);
      const sentences = validateReplyText(generated.replyText);
      timings.validation = Math.round(performance.now() - stage);

      stage = performance.now();
      const speech = await bounded(providers.synthesize(
        generated.replyText, session.profile.configuration.voice_id, language, signal, fixtureId,
      ), signal);
      check();
      timings.tts = Math.round(performance.now() - stage);
      if (!speech.bytes.length || speech.bytes.length > LIMITS.audioBytes
        || !Number.isFinite(speech.durationMs) || speech.durationMs <= 0) {
        throw new PipelineError('invalid_audio', 503);
      }
      timings.server_total = Math.round(performance.now() - start);

      session.sequence++;
      session.profile.stateVersion++;
      const result: TurnResponse = {
        session_id: session.id, turn_id: id, sequence: session.sequence,
        clock_version: 1, state_version: session.profile.stateVersion,
        provider_mode: providers.mode, engine_mode: 'voice_stub',
        transcript, reply: { text: generated.replyText, sentences, language },
        audio: { mime_type: speech.mimeType, data_base64: speech.bytes.toString('base64'), duration_ms: speech.durationMs },
        presentation: null, face: null, memory: null, timings_ms: timings,
        ...(fixtureId ? { fixture_id: fixtureId } : {}),
      };
      record.status = 'completed';
      record.response = result;
      record.resultAt = Date.now();
      record.publishedVersion = result.state_version;
      record.durationMs = speech.durationMs;
      return result;
    } catch (error) {
      if (record && record.status !== 'canceled') record.status = 'failed';
      if (timedOut) throw new PipelineError('provider_timeout', 504, true);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (record && session.profile.active === record) session.profile.active = undefined;
      externalSignal.removeEventListener('abort', cancel);
    }
  }
}
