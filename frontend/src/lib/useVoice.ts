import { useEffect, useRef } from 'react';
import type { Language, TranslationKey } from './i18n';

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; abort(): void;
};
type VoiceWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
export function voiceAvailable() { const w = window as VoiceWindow; return !!(w.SpeechRecognition || w.webkitSpeechRecognition); }

export function useVoice({ enabled, canListen, language, onSpeech, onTurn, onError }: {
  enabled: boolean; canListen: boolean; language: Language;
  onSpeech: () => void; onTurn: (text: string) => void; onError: (key: TranslationKey) => void;
}) {
  const callbacks = useRef({ onSpeech, onTurn, onError });
  callbacks.current = { onSpeech, onTurn, onError };
  const sendRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled || !canListen) return;
    const w = window as VoiceWindow;
    const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!window.isSecureContext) { callbacks.current.onError('voiceSecure'); return; }
    if (!Constructor) { callbacks.current.onError('voiceMissing'); return; }
    const recognition = new Constructor();
    recognition.lang = language === 'vi' ? 'vi-VN' : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    let transcript = '';
    let disposed = false;
    let finished = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (disposed || finished) return;
      finished = true;
      clearTimeout(quietTimer);
      recognition.abort();
      const value = transcript.trim();
      transcript = '';
      if (value) callbacks.current.onTurn(value);
      else callbacks.current.onError('voiceFailed');
    };
    sendRef.current = finish;
    recognition.onresult = (event) => {
      if (disposed || finished) return;
      transcript = Array.from(event.results).map(result => result[0].transcript).join(' ').trim();
      if (transcript) {
        callbacks.current.onSpeech();
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 2000);
      }
    };
    recognition.onerror = (event) => {
      if (disposed || finished || event.error === 'aborted' || event.error === 'no-speech') return;
      finished = true;
      callbacks.current.onError(event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture' ? 'voiceDenied' : 'voiceFailed');
    };
    recognition.onend = () => {
      if (disposed || finished) return;
      if (transcript) finish();
      else restartTimer = setTimeout(() => { if (!disposed && !finished) { try { recognition.start(); } catch { callbacks.current.onError('voiceFailed'); } } }, 600);
    };
    // A short gap prevents the previous synthesized answer from starting a new turn.
    restartTimer = setTimeout(() => { if (!disposed) { try { recognition.start(); } catch { callbacks.current.onError('voiceFailed'); } } }, 650);
    return () => {
      disposed = true;
      transcript = '';
      sendRef.current = null;
      clearTimeout(quietTimer); clearTimeout(restartTimer);
      recognition.onend = null; recognition.onresult = null; recognition.onerror = null;
      recognition.abort();
    };
  }, [enabled, canListen, language]);
  return () => sendRef.current?.();
}
