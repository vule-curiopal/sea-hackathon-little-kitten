import { isCanceled, isSessionExpired } from '@miu/voice-client';
import type { TranslationKey } from './i18n';

export function voiceErrorKey(error: unknown): TranslationKey | null {
  if (isCanceled(error)) return null;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'INSECURE_CONTEXT') return 'voiceSecure';
  if (code === 'MIC_PERMISSION_DENIED') return 'voiceDenied';
  if (code === 'NO_SIGNAL' || code === 'NO_AUDIO') return 'voiceNoSignal';
  if (code === 'unclear_audio') return 'voiceUnclear';
  if (code === 'RECORDING_LIMIT') return 'voiceRecordingLimit';
  if (code.startsWith('provider_')) return 'voiceServiceUnavailable';
  if (['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(code)) return 'voiceOffline';
  if (isSessionExpired(error)) return 'voiceSessionExpired';
  if (['UNSUPPORTED_AUDIO', 'MIC_UNAVAILABLE', 'MIC_NOT_FOUND'].includes(code)) return 'voiceMissing';
  if (['PLAYBACK_FAILED', 'INVALID_AUDIO'].includes(code)) return 'voicePlaybackFailed';
  if (['CAPTURE_INTERRUPTED', 'ANALYSIS_GAP', 'PAGE_HIDDEN'].includes(code)) return 'voiceInterrupted';
  return 'voiceFailed';
}
