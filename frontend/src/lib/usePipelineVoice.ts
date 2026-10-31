import { useCallback, useEffect, useRef, useState } from 'react';
import { createVoiceClient, isCanceled, isSessionExpired, newRequestId, type CaptureState, type MeterSnapshot, type SessionResponse, type TurnResponse, type VoiceController, type VoiceControllerState } from '@miu/voice-client';
import type { Language, TranslationKey } from './i18n';
import { createPlaybackMeter } from './playback-meter';
import { engineRequest, type Role } from './engine-api';
import { createVoiceConsole } from './voice-console';

export function voiceErrorKey(error: unknown): TranslationKey | null {
  if (isCanceled(error)) return null;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'INSECURE_CONTEXT') return 'voiceSecure';
  if (code === 'MIC_PERMISSION_DENIED') return 'voiceDenied';
  if (code === 'NO_SIGNAL' || code === 'NO_AUDIO') return 'voiceNoSignal';
  if (code === 'RECORDING_LIMIT') return 'voiceRecordingLimit';
  if (['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(code)) return 'voiceOffline';
  if (isSessionExpired(error)) return 'voiceSessionExpired';
  if (['UNSUPPORTED_AUDIO', 'MIC_UNAVAILABLE', 'MIC_NOT_FOUND'].includes(code)) return 'voiceMissing';
  if (['PLAYBACK_FAILED', 'INVALID_AUDIO'].includes(code)) return 'voicePlaybackFailed';
  if (['CAPTURE_INTERRUPTED', 'ANALYSIS_GAP', 'PAGE_HIDDEN'].includes(code)) return 'voiceInterrupted';
  return 'voiceFailed';
}

type Options = {
  language: Language;
  profile: string;
  voiceId: string;
  personality: string;
  role: Role;
  onState(state: VoiceControllerState): void;
  onTurn(response: TurnResponse): void;
  onInvalidate(): void;
};

/** The shared client owns recording, cancellation, MIME handling and playback receipts. */
export function usePipelineVoice(options: Options) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [voiceConsole] = useState(() => createVoiceConsole());
  const controller = useRef<VoiceController | null>(null);
  const reportError = useRef<(reason: unknown) => void>(() => {});
  const teardown = useRef<Promise<void>>(Promise.resolve());
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [state, setState] = useState<VoiceControllerState>('initializing');
  const [capture, setCapture] = useState<CaptureState>('idle');
  const [meter, setMeter] = useState<MeterSnapshot | null>(null);
  const [manualOnly, setManualOnly] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mouthLevel, setMouthLevel] = useState(0);
  const [revision, setRevision] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [lastTurn, setLastTurn] = useState<TurnResponse | null>(null);
  const meterRef = useRef<ReturnType<typeof createPlaybackMeter> | null>(null);
  const dayAbort = useRef<AbortController | null>(null);
  const showError = useCallback((reason: unknown) => {
    voiceConsole.error(reason);
    if (typeof reason === 'object' && reason !== null && 'memoryInvalidated' in reason && reason.memoryInvalidated) {
      setLastTurn(null); callbacks.current.onInvalidate(); setRevision(value => value + 1);
    }
    const key = voiceErrorKey(reason);
    if (key) setError(key);
    if (key === 'voiceSessionExpired') setSession(null);
  }, [voiceConsole]);

  useEffect(() => {
    let active = true;
    const output = createPlaybackMeter(level => { if (active) setMouthLevel(level); });
    meterRef.current = output;
    const client = createVoiceClient({
      api: { baseUrl: import.meta.env.VITE_VOICE_API_URL || '', requestTimeoutMs: 120000,
        fetch: async (input, init) => {
          const start = performance.now();
          const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
          let response: Response;
          try {
            response = await fetch(input, init);
            if (active) voiceConsole.request(init?.method ?? 'GET', path, response.status, performance.now() - start);
          } catch (reason) {
            if (active) voiceConsole.request(init?.method ?? 'GET', path, 'network_error', performance.now() - start);
            throw reason;
          }
          if (active && response.ok && String(input).includes('/playback')) {
            void response.clone().json().catch(() => null).then(() => { if (active) setRevision(value => value + 1); });
          }
          return response;
        },
      }, playback: { environment: output.environment }, capture: { endpointing: 'manual' },
    });
    controller.current = client.controller;
    let connected = false;
    let renewing = false;
    const report = (reason: unknown) => {
      // A rejected promise from a disposed client must not invalidate a newer session.
      if (!active || controller.current !== client.controller) return;
      showError(reason);
      if (isSessionExpired(reason)) {
        setSession(null);
        if (connected && !renewing) {
          renewing = true;
          voiceConsole.action('session.expired', { reason: 'reconnecting_without_recording' });
          setAttempt(value => value + 1);
        }
      }
    };
    reportError.current = report;
    setSession(null); setState('initializing'); setError(null); setMeter(null); setManualOnly(false); setLastTurn(null); setMouthLevel(0); setAdvancing(false);
    const unsubscribe = client.controller.subscribe(event => {
      if (!active) return;
      voiceConsole.event(event);
      if (event.type === 'state') {
        const selected = client.controller.session;
        // openProfile stops its predecessor before creating the new session. That internal
        // idle notification must not expose an enabled, disconnected Talk button.
        const nextState = event.state === 'idle' && (!selected || dayAbort.current !== null) ? 'initializing' : event.state;
        setState(nextState);
        setSession(selected);
        callbacks.current.onState(nextState);
        if (event.state !== 'recording') { setCapture('idle'); setMeter(null); }
      } else if (event.type === 'turn') {
        const memory = event.response.memory as { invalidate_replay?: boolean } | null;
        if (memory?.invalidate_replay) callbacks.current.onInvalidate();
        setLastTurn(event.response); callbacks.current.onTurn(event.response); setRevision(value => value + 1);
      }
      else if (event.type === 'error') report(event.error);
      else if (event.type === 'playback' && (event.event.type === 'error' || event.event.type === 'receipt_error')) report(event.event.error);
      else if (event.type === 'capture') {
        if (event.event.type === 'state') setCapture(event.event.state);
        if (event.event.type === 'meter') setMeter(event.event.snapshot);
        if (event.event.type === 'manual_only') setManualOnly(true);
      }
    });
    // Serialize StrictMode cleanup and profile/config changes so sessions never overlap.
    const opened = teardown.current.then(async () => {
      if (!active) return;
      const value = await client.controller.openProfile(options.profile, options.language, options.voiceId, { personality: options.personality, role: options.role });
      if (active) { connected = true; voiceConsole.session(value); setSession(value); }
    }).catch(reason => { if (active) { setState('error'); report(reason); } });
    const hide = () => {
      if (document.hidden && client.controller.state !== 'initializing') {
        voiceConsole.action('page.hidden', { state: client.controller.state });
        void client.controller.stop().catch(report);
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      active = false; unsubscribe(); document.removeEventListener('visibilitychange', hide);
      dayAbort.current?.abort(); dayAbort.current = null;
      output.dispose(); if (meterRef.current === output) meterRef.current = null;
      if (controller.current === client.controller) controller.current = null;
      // Stop synchronously before awaiting server cleanup.
      const stopped = client.controller.stop().catch(() => {});
      teardown.current = Promise.all([opened, stopped]).then(() => client.controller.dispose()).catch(() => {});
    };
  }, [options.language, options.profile, options.voiceId, options.personality, options.role, attempt, showError, voiceConsole]);

  const stop = useCallback(() => {
    setMeter(null);
    const current = controller.current;
    // Opening settings/rest is allowed while connecting. Effect cleanup still aborts
    // setup when the profile or actual configuration changes.
    if (!current || current.state === 'initializing' || dayAbort.current !== null) return Promise.resolve();
    voiceConsole.action('stop', { state: current.state });
    return current.stop().catch(reportError.current);
  }, [showError, voiceConsole]);
  const talk = useCallback(() => {
    const current = controller.current;
    if (!current?.session) { voiceConsole.action('hold.ignored', { reason: 'session_not_ready' }); return false; }
    voiceConsole.action('hold.start', { state: current.state });
    meterRef.current?.unlock();
    setError(null); setManualOnly(false);
    // Keep capture.start() in the original press stack for iPhone/iPad microphone access.
    void current.talk(current.session.provider_mode === 'fake'
      ? { fixtureId: `voice_sample_${current.session.configuration.language_mode}` } : {}).catch(reportError.current);
    return true;
  }, [showError, voiceConsole]);
  const send = useCallback(() => {
    const current = controller.current;
    voiceConsole.action('hold.release', { state: current?.state });
    const accepted = current?.send() ?? false;
    voiceConsole.action('capture.send', { state: current?.state, accepted });
  }, [voiceConsole]);
  const play = useCallback(() => {
    meterRef.current?.unlock();
    const current = controller.current;
    voiceConsole.action('play.requested', { state: current?.state });
    if (lastTurn?.audio === null) void current?.acknowledgeText().catch(reportError.current);
    else void current?.resumePlayback().catch(reportError.current);
  }, [showError, lastTurn, voiceConsole]);
  const text = useCallback((value: string, textOnly = false) => {
    const current = controller.current;
    if (!current?.session || !value.trim()) return false;
    meterRef.current?.unlock(); setError(null);
    void current.text(value, { textOnly }).catch(reportError.current);
    return true;
  }, [showError]);
  const greet = useCallback((textOnly = false) => {
    const current = controller.current;
    if (!current?.session) return false;
    meterRef.current?.unlock(); setError(null);
    void current.greet({ textOnly }).catch(reportError.current);
    return true;
  }, [showError]);
  const nextDay = useCallback(async (clockVersion: number) => {
    const current = controller.current;
    const selected = current?.session;
    if (!current || !selected || current.state !== 'idle' || advancing || dayAbort.current) return;
    const abort = new AbortController(); dayAbort.current = abort;
    setAdvancing(true); setError(null);
    try {
      await current.stop();
      // Keep the rollover and following reconnect one continuous busy phase.
      setState('initializing');
      await engineRequest(selected, '/api/demo/next-day', { method: 'POST', body: JSON.stringify({ request_id: newRequestId(), expected_clock_version: clockVersion }) }, abort.signal);
      if (abort.signal.aborted || controller.current !== current) return;
      callbacks.current.onInvalidate(); setLastTurn(null); setSession(null); setRevision(value => value + 1); setAttempt(value => value + 1);
    } catch (reason) { if (!abort.signal.aborted && controller.current === current) { setState('error'); reportError.current(reason); } }
    finally { if (dayAbort.current === abort) { dayAbort.current = null; setAdvancing(false); } }
  }, [showError, advancing]);
  const reconnect = useCallback(() => { setAttempt(value => value + 1); }, []);
  return { session, state, capture, meter, mouthLevel, manualOnly, error, stop, talk, text, greet, send, play, reconnect, nextDay, advancing, revision, lastTurn, clearError: () => setError(null) };
}
