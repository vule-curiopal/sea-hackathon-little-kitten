import { useCallback, useEffect, useRef, useState } from 'react';
import { createVoiceClient, isCanceled, newRequestId, type CaptureState, type MeterSnapshot, type SessionResponse, type TurnResponse, type VoiceController, type VoiceControllerState } from '@miu/voice-client';
import type { Language, TranslationKey } from './i18n';
import { createPlaybackMeter } from './playback-meter';
import { engineRequest, type DemoPanelData, type Role } from './engine-api';
import { readAffectSnapshot, type AffectSnapshot } from './affect';

export function voiceErrorKey(error: unknown): TranslationKey | null {
  if (isCanceled(error)) return null;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'INSECURE_CONTEXT') return 'voiceSecure';
  if (code === 'MIC_PERMISSION_DENIED') return 'voiceDenied';
  if (code === 'NO_SIGNAL') return 'voiceNoSignal';
  if (['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(code)) return 'voiceOffline';
  if (['session_closed', 'session_not_found', 'unauthorized'].includes(code)) return 'voiceSessionExpired';
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
  const controller = useRef<VoiceController | null>(null);
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
  const [affect, setAffect] = useState<AffectSnapshot | undefined>();
  const meterRef = useRef<ReturnType<typeof createPlaybackMeter> | null>(null);
  const dayAbort = useRef<AbortController | null>(null);
  const showError = useCallback((reason: unknown) => {
    if (typeof reason === 'object' && reason !== null && 'memoryInvalidated' in reason && reason.memoryInvalidated) {
      setLastTurn(null); setAffect(undefined); callbacks.current.onInvalidate(); setRevision(value => value + 1);
    }
    const key = voiceErrorKey(reason);
    if (key) setError(key);
    if (key === 'voiceSessionExpired') { setSession(null); setAffect(undefined); }
  }, []);

  useEffect(() => {
    let active = true;
    let affectRead: AbortController | undefined;
    let affectReadVersion = 0;
    const refreshAffect = async (selected: SessionResponse) => {
      affectRead?.abort();
      const abort = new AbortController(); affectRead = abort;
      const version = ++affectReadVersion;
      try {
        const value = await engineRequest<DemoPanelData>(selected, '/api/demo/panel', {}, abort.signal);
        if (active && !abort.signal.aborted && version === affectReadVersion
          && controller.current?.session?.session_id === selected.session_id && controller.current.state !== 'error') {
          setAffect(readAffectSnapshot(value.context?.affect));
        }
      } catch { /* Affect is optional; older services and failed reads keep existing rendering. */ }
    };
    const output = createPlaybackMeter(level => { if (active) setMouthLevel(level); });
    meterRef.current = output;
    const client = createVoiceClient({
      api: { baseUrl: import.meta.env.VITE_VOICE_API_URL || '', requestTimeoutMs: 120000,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (active && response.ok) {
            const path = String(input).split('?')[0];
            let status: unknown;
            try { status = typeof init?.body === 'string' ? JSON.parse(init.body).status : undefined; } catch { /* Non-JSON request. */ }
            const receipt = path.endsWith('/playback');
            if (receipt) setRevision(value => value + 1);
            const canceled = init?.method === 'DELETE' && /\/turns\/[^/]+$/u.test(path);
            const selected = controller.current?.session;
            if (selected && (canceled || (receipt && (status === 'completed' || status === 'interrupted')))) void refreshAffect(selected);
          }
          return response;
        },
      }, playback: { environment: output.environment },
    });
    controller.current = client.controller;
    setSession(null); setAffect(undefined); setState('initializing'); setError(null); setMeter(null); setManualOnly(false); setLastTurn(null); setMouthLevel(0); setAdvancing(false);
    const unsubscribe = client.controller.subscribe(event => {
      if (!active) return;
      if (event.type === 'state') {
        const selected = client.controller.session;
        // openProfile stops its predecessor before creating the new session. That internal
        // idle notification must not expose an enabled, disconnected Talk button.
        const nextState = event.state === 'idle' && (!selected || dayAbort.current !== null) ? 'initializing' : event.state;
        setState(nextState);
        if (selected) setSession(selected);
        callbacks.current.onState(nextState);
        if (event.state !== 'recording') { setCapture('idle'); setMeter(null); }
      } else if (event.type === 'turn') {
        const memory = event.response.memory as { invalidate_replay?: boolean } | null;
        if (memory?.invalidate_replay) {
          setAffect(undefined); callbacks.current.onInvalidate();
          const selected = client.controller.session;
          if (selected) void refreshAffect(selected);
        }
        setLastTurn(event.response); callbacks.current.onTurn(event.response); setRevision(value => value + 1);
      }
      else if (event.type === 'error') showError(event.error);
      else if (event.type === 'playback' && (event.event.type === 'error' || event.event.type === 'receipt_error')) showError(event.event.error);
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
      if (active) { setSession(value); void refreshAffect(value); }
    }).catch(reason => { if (active) { setState('error'); showError(reason); } });
    const hide = () => { if (document.hidden && client.controller.state !== 'initializing') void client.controller.stop().catch(showError); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      active = false; affectRead?.abort(); unsubscribe(); document.removeEventListener('visibilitychange', hide);
      dayAbort.current?.abort(); dayAbort.current = null;
      output.dispose(); if (meterRef.current === output) meterRef.current = null;
      if (controller.current === client.controller) controller.current = null;
      // Stop synchronously before awaiting server cleanup.
      const stopped = client.controller.stop().catch(() => {});
      teardown.current = Promise.all([opened, stopped]).then(() => client.controller.dispose()).catch(() => {});
    };
  }, [options.language, options.profile, options.voiceId, options.personality, options.role, attempt, showError]);

  const stop = useCallback(() => {
    setMeter(null);
    const current = controller.current;
    // Opening settings/rest is allowed while connecting. Effect cleanup still aborts
    // setup when the profile or actual configuration changes.
    if (!current || current.state === 'initializing' || dayAbort.current !== null) return Promise.resolve();
    return current.stop().catch(showError);
  }, [showError]);
  const talk = useCallback(() => {
    const current = controller.current;
    if (!current?.session) return;
    meterRef.current?.unlock();
    setError(null); setManualOnly(false);
    // Keep capture.start() in the original click/tap stack.
    void current.talk(current.session.provider_mode === 'fake'
      ? { fixtureId: `voice_sample_${current.session.configuration.language_mode}` } : {}).catch(showError);
  }, [showError]);
  const send = useCallback(() => { controller.current?.send(); }, []);
  const play = useCallback(() => {
    meterRef.current?.unlock();
    const current = controller.current;
    if (lastTurn?.audio === null) void current?.acknowledgeText().catch(showError);
    else void current?.resumePlayback().catch(showError);
  }, [showError, lastTurn]);
  const text = useCallback((value: string, textOnly = false) => {
    const current = controller.current;
    if (!current?.session || !value.trim()) return;
    meterRef.current?.unlock(); setError(null);
    void current.text(value, { textOnly }).catch(showError);
  }, [showError]);
  const greet = useCallback((textOnly = false) => {
    const current = controller.current;
    if (!current?.session) return;
    meterRef.current?.unlock(); setError(null);
    void current.greet({ textOnly }).catch(showError);
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
      callbacks.current.onInvalidate(); setLastTurn(null); setAffect(undefined); setSession(null); setRevision(value => value + 1); setAttempt(value => value + 1);
    } catch (reason) { if (!abort.signal.aborted) { setState('error'); showError(reason); } }
    finally { if (dayAbort.current === abort) { dayAbort.current = null; setAdvancing(false); } }
  }, [showError, advancing]);
  const reconnect = useCallback(() => { setAttempt(value => value + 1); }, []);
  return { session, state, capture, meter, mouthLevel, manualOnly, error, stop, talk, text, greet, send, play, reconnect, nextDay, advancing, revision, lastTurn, affect, clearError: () => setError(null) };
}
