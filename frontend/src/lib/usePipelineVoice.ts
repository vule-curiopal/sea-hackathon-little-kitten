import { useCallback, useEffect, useRef, useState } from 'react';
import { createVoiceClient, isCanceled, type CaptureState, type MeterSnapshot, type SessionResponse, type TurnResponse, type VoiceController, type VoiceControllerState } from '@miu/voice-client';
import type { Language, TranslationKey } from './i18n';

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
  onState(state: VoiceControllerState): void;
  onTurn(response: TurnResponse): void;
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
  const showError = useCallback((reason: unknown) => {
    const key = voiceErrorKey(reason);
    if (key) setError(key);
    if (key === 'voiceSessionExpired') setSession(null);
  }, []);

  useEffect(() => {
    let active = true;
    const client = createVoiceClient({ api: { baseUrl: import.meta.env.VITE_VOICE_API_URL || '' } });
    controller.current = client.controller;
    setSession(null); setState('initializing'); setError(null); setMeter(null); setManualOnly(false);
    const unsubscribe = client.controller.subscribe(event => {
      if (!active) return;
      if (event.type === 'state') {
        setState(event.state);
        callbacks.current.onState(event.state);
        if (event.state !== 'recording') { setCapture('idle'); setMeter(null); }
      } else if (event.type === 'turn') callbacks.current.onTurn(event.response);
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
      const value = await client.controller.openProfile(options.profile, options.language, options.voiceId);
      if (active) setSession(value);
    }).catch(reason => { if (active) { setState('error'); showError(reason); } });
    const hide = () => { if (document.hidden) void client.controller.stop().catch(showError); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      active = false; unsubscribe(); document.removeEventListener('visibilitychange', hide);
      if (controller.current === client.controller) controller.current = null;
      // Stop synchronously before awaiting server cleanup.
      const stopped = client.controller.stop().catch(() => {});
      teardown.current = Promise.all([opened, stopped]).then(() => client.controller.dispose()).catch(() => {});
    };
  }, [options.language, options.profile, options.voiceId, attempt, showError]);

  const stop = useCallback(() => {
    setMeter(null);
    return controller.current?.stop().catch(showError);
  }, [showError]);
  const talk = useCallback(() => {
    const current = controller.current;
    if (!current?.session) return;
    setError(null); setManualOnly(false);
    // Keep capture.start() in the original click/tap stack.
    void current.talk(current.session.provider_mode === 'fake'
      ? { fixtureId: `voice_sample_${current.session.configuration.language_mode}` } : {}).catch(showError);
  }, [showError]);
  const send = useCallback(() => { controller.current?.send(); }, []);
  const play = useCallback(() => { void controller.current?.resumePlayback().catch(showError); }, [showError]);
  const reconnect = useCallback(() => { setAttempt(value => value + 1); }, []);
  return { session, state, capture, meter, manualOnly, error, stop, talk, send, play, reconnect, clearError: () => setError(null) };
}
