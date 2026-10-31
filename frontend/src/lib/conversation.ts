import type { Emotion } from './miu-pose.ts';
export type Phase = 'answered' | 'listening' | 'thinking' | 'speaking' | 'resting';
export type Answer = { id: number; text: string; emotion: Emotion; intensity?: number; source?: 'sample' | 'reference' | 'voice' };
export type UserMessage = { id: number; role: 'user'; text: string; source: 'typed' | 'voice'; unavailable?: boolean; uncertain?: boolean };
export type MiuMessage = Answer & { role: 'miu' };
export type ConversationMessage = UserMessage | MiuMessage;
export type Conversation = { phase: Phase; emotion: Emotion; messages: ConversationMessage[]; pendingRequestId?: number };
export type ConversationEvent =
  | { type: 'listen'; requestId: number } | { type: 'think'; requestId?: number; user?: UserMessage } | { type: 'speak' } | { type: 'finish'; requestId?: number } | { type: 'pause' } | { type: 'wake' } | { type: 'reset' }
  | { type: 'reply'; answer: Answer; speaking: boolean; user?: UserMessage };
export const MAX_MESSAGES = 200;
export const initialConversation: Conversation = { phase: 'answered', emotion: 'happy', messages: [] };
export function lastMiuAnswer(state: Conversation): MiuMessage | undefined {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.role === 'miu') return message;
  }
  return undefined;
}
export function lastUserMessage(state: Conversation): UserMessage | undefined {
  const latestTurnId = state.messages.at(-1)?.id;
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.id !== latestTurnId) break;
    if (message.role === 'user') return message;
  }
  return undefined;
}
function withUser(messages: ConversationMessage[], user?: UserMessage): ConversationMessage[] {
  if (!user) return messages;
  const index = messages.findIndex(message => message.role === 'user' && message.id === user.id);
  return index === -1 ? [...messages, user] : messages.map((message, position) => position === index ? user : message);
}
export function conversationReducer(state: Conversation, event: ConversationEvent): Conversation {
  switch (event.type) {
    case 'listen': return state.phase === 'answered' ? { ...state, phase: 'listening', emotion: 'listening', pendingRequestId: event.requestId } : state;
    case 'think': return state.phase !== 'resting' ? { ...state, phase: 'thinking', emotion: 'thinking', messages: withUser(state.messages, event.user).slice(-MAX_MESSAGES), ...(event.requestId !== undefined ? { pendingRequestId: event.requestId } : {}) } : state;
    case 'speak': return state.phase !== 'resting' ? { ...state, phase: 'speaking' } : state;
    case 'reply': {
      const matches = state.pendingRequestId !== undefined ? state.pendingRequestId === event.answer.id : state.phase === 'thinking';
      return state.phase !== 'resting' && matches ? { phase: event.speaking || state.phase === 'speaking' ? 'speaking' : 'answered', emotion: event.answer.emotion, messages: [...withUser(state.messages, event.user), { ...event.answer, role: 'miu' as const }].slice(-MAX_MESSAGES) } : state;
    }
    case 'finish': {
      if (state.phase === 'resting') return state;
      if (event.requestId !== undefined && event.requestId !== (state.pendingRequestId ?? lastMiuAnswer(state)?.id)) return state;
      const { pendingRequestId: _pending, ...finished } = state;
      return { ...finished, phase: 'answered', emotion: lastMiuAnswer(state)?.emotion ?? 'happy' };
    }
    case 'pause': {
      const { pendingRequestId: _pending, ...paused } = state;
      return { ...paused, phase: 'resting', emotion: 'sleepy' };
    }
    case 'wake': return { ...state, phase: 'answered', emotion: lastMiuAnswer(state)?.emotion ?? 'happy' };
    case 'reset': return { ...initialConversation, phase: state.phase === 'resting' ? 'resting' : 'answered', emotion: state.phase === 'resting' ? 'sleepy' : 'happy' };
  }
}
