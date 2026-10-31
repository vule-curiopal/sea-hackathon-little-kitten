import { emotions } from './miu-pose.ts';
import { conversationReducer, initialConversation, lastMiuAnswer, MAX_MESSAGES, type Conversation, type ConversationEvent, type ConversationMessage } from './conversation.ts';

export const HISTORY_KEY = 'miu.conversations.v1';
export const HISTORY_PROFILES = ['an', 'binh'] as const;
export type ConversationHistory = Record<string, Conversation>;
type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

function validMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.id) || (message.id as number) < 0 || typeof message.text !== 'string' || message.text.length > 8000) return false;
  if (message.role === 'user') return ['typed', 'voice'].includes(String(message.source)) && (message.text.trim().length > 0 || (message.source === 'voice' && message.unavailable === true));
  return message.role === 'miu' && message.text.trim().length > 0 && emotions.includes(message.emotion as typeof emotions[number])
    && (message.source === undefined || ['sample', 'reference', 'voice'].includes(String(message.source)))
    && (message.intensity === undefined || (typeof message.intensity === 'number' && Number.isFinite(message.intensity) && message.intensity >= 0 && message.intensity <= 1));
}

export function readConversationHistory(storage: StorageReader): ConversationHistory {
  try {
    const saved = JSON.parse(storage.getItem(HISTORY_KEY) ?? 'null');
    if (saved?.version !== 1 || !saved.profiles || typeof saved.profiles !== 'object') return {};
    const history: ConversationHistory = {};
    for (const profile of HISTORY_PROFILES) {
      const stored = saved.profiles[profile];
      if (!Array.isArray(stored)) continue;
      const seen = new Set<string>();
      const messages = stored.filter(validMessage).filter(message => {
        const key = `${message.role}:${message.id}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(-MAX_MESSAGES);
      const conversation = { ...initialConversation, messages };
      history[profile] = { ...conversation, emotion: lastMiuAnswer(conversation)?.emotion ?? 'happy' };
    }
    return history;
  } catch { return {}; }
}

export function saveConversationHistory(storage: StorageWriter, history: ConversationHistory): boolean {
  try {
    const profiles = Object.fromEntries(HISTORY_PROFILES.map(profile => [profile, (history[profile]?.messages ?? []).slice(-MAX_MESSAGES)]));
    storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, profiles }));
    return true;
  } catch { return false; }
}

export function historyReducer(history: ConversationHistory, { profile, event }: { profile: string; event: ConversationEvent }): ConversationHistory {
  const previous = history[profile] ?? initialConversation;
  const next = conversationReducer(previous, event);
  return next === previous ? history : { ...history, [profile]: next };
}

export function latestHistoryRequestId(history: ConversationHistory): number {
  return Math.max(0, ...Object.values(history).flatMap(conversation => conversation.messages.map(message => message.id)));
}
