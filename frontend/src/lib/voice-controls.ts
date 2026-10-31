import type { CaptureState, VoiceControllerState } from '@miu/voice-client';
import type { TranslationKey } from './i18n';
import type { IconName } from '../components/Icon';

export function canStartVoice(state: VoiceControllerState, connected: boolean): boolean {
  return connected && (state === 'idle' || state === 'error');
}

/** Holding owns the gesture during permission; only the recorder's ready state invites speech. */
export function microphoneControl(state: VoiceControllerState, capture: CaptureState, connected: boolean, busy: boolean, silentReply = false) {
  const holding = state === 'recording';
  const ready = holding && capture === 'recording';
  const preparing = holding && !ready && capture !== 'finalizing_capture';
  const waiting = ['initializing', 'processing', 'speaking'].includes(state) || capture === 'finalizing_capture' || (busy && !holding && state !== 'playback_blocked');
  let label: TranslationKey = connected ? 'voiceTalk' : 'voiceConnect';
  let text: TranslationKey = 'talkButton';
  let icon: IconName = 'mic';
  if (state === 'initializing') { label = 'voiceConnecting'; text = 'voicePreparingShort'; icon = 'refresh'; }
  else if (preparing) { label = 'voicePreparing'; text = 'voicePreparingShort'; icon = 'refresh'; }
  else if (ready) { label = 'voiceRelease'; text = 'voiceSpeakShort'; }
  else if (state === 'speaking') { label = 'isSpeaking'; text = 'voiceSpeakingShort'; icon = 'sound'; }
  else if (waiting) { label = 'isThinking'; text = 'voiceThinkingShort'; icon = 'refresh'; }
  else if (state === 'playback_blocked') { label = silentReply ? 'doneReading' : 'voicePlay'; text = label; icon = silentReply ? 'heart' : 'play'; }
  return { holding, ready, preparing, disabled: waiting, label, text, icon, busy: waiting || preparing };
}
