import Miu from './Miu';
import type { ConversationMessage } from '../lib/conversation';
import type { TranslationKey } from '../lib/i18n';
import { userMessageText } from '../lib/message-text';

export default function ConversationMessages({ messages, pendingRequestId, t }: { messages: ConversationMessage[]; pendingRequestId?: number; t: (key: TranslationKey) => string }) {
  const turns: { id: number; messages: ConversationMessage[] }[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous?.id === message.id) previous.messages.push(message);
    else turns.push({ id: message.id, messages: [message] });
  }
  return turns.map(turn => <section className="conversation-turn" data-turn-id={turn.id} key={turn.id}>
    {turn.messages.map(item => <article className={`answer ${item.role === 'user' ? 'user-message' : 'miu-message'}`} key={`${item.role}-${item.id}`}>
      {item.role === 'miu' && <span className="answer-avatar"><Miu emotion={item.emotion} intensity={item.intensity} /></span>}
      <div>
        <span>{item.role === 'user' ? t('you') : 'Miu'} · {t(item.source === 'typed' ? 'typedMessage' : item.source === 'voice' && item.role === 'user' ? 'spokenMessage' : item.source === 'voice' ? 'voiceLive' : item.source === 'reference' ? 'voiceReference' : 'demo')}</span>
        <p>{item.role === 'user' ? userMessageText(item, t, { pending: item.id === pendingRequestId, reference: turn.messages.some(message => message.role === 'miu' && message.source === 'reference') }) : item.text}</p>
        {item.role === 'user' && item.uncertain && <small>{t('voiceTranscriptUncertain')}</small>}
      </div>
    </article>)}
  </section>);
}
