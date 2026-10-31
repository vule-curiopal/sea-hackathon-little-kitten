import type { UserMessage } from './conversation.ts';
import type { TranslationKey } from './i18n.tsx';

/** Recognition in progress and reference playback are not transcription failures. */
export function userMessageText(message: UserMessage, t: (key: TranslationKey) => string, context: { pending?: boolean; reference?: boolean } = {}): string {
  if (message.source !== 'voice' || message.text.trim()) return message.text;
  if (context.pending) return t('voiceMessageProcessing');
  if (context.reference) return t('voiceReferenceTranscript');
  return t('voiceTranscriptUnavailable');
}
