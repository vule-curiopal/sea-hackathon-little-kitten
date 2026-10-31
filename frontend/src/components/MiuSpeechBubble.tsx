import type { Answer, Phase, UserMessage } from '../lib/conversation';
import type { TranslationKey } from '../lib/i18n';
import type { Ref } from 'react';
import { userMessageText } from '../lib/message-text';

export default function MiuSpeechBubble({ phase, answer, user, pendingRequestId, greeting, listeningLabel = 'isListening', bubbleRef, t }: {
  phase: Phase; answer?: Answer; user?: UserMessage; pendingRequestId?: number; greeting: string; listeningLabel?: TranslationKey; bubbleRef?: Ref<HTMLDivElement>; t: (key: TranslationKey) => string;
}) {
  const quiet = phase === 'thinking' || phase === 'listening';
  const currentAnswer = !user || answer?.id === user.id ? answer : undefined;
  const text = phase === 'thinking' ? t('isThinking') : phase === 'listening' ? t(listeningLabel) : currentAnswer?.text ?? (user ? t('mutedStatus') : greeting);
  return <div className={`talk-bubble ${quiet ? 'is-quiet' : ''}`} ref={bubbleRef} aria-live="polite">
    {user && <div className="sent-message">
      <span className="speech-byline">{t('you')} <span className="tiny-dot" />{t(user.source === 'typed' ? 'typedMessage' : 'spokenMessage')}</span>
      <p>{userMessageText(user, t, { pending: user.id === pendingRequestId, reference: currentAnswer?.source === 'reference' })}</p>
      {user.uncertain && <small>{t('voiceTranscriptUncertain')}</small>}
    </div>}
    <div className="buddy-message">
      <span className="speech-byline">Miu <span className="tiny-dot" />{t(currentAnswer?.source === 'voice' ? 'voiceLive' : currentAnswer?.source === 'reference' ? 'voiceReference' : 'demo')}</span>
      <p>{text}</p>
    </div><span className="speech-tail" />
  </div>;
}
