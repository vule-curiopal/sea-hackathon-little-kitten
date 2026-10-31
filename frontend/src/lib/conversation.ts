import type { Emotion } from './miu-pose.ts';
export type Phase = 'answered' | 'listening' | 'thinking' | 'speaking' | 'resting';
export type Answer = { id: number; text: string; emotion: Emotion; source?: 'sample' | 'reference' | 'voice' };
export type Conversation = { phase: Phase; emotion: Emotion; answers: Answer[] };
export type ConversationEvent =
  | { type: 'listen' } | { type: 'think' } | { type: 'speak' } | { type: 'finish' } | { type: 'pause' } | { type: 'wake' } | { type: 'reset' }
  | { type: 'reply'; answer: Answer; speaking: boolean };
export const initialConversation: Conversation = { phase: 'answered', emotion: 'happy', answers: [] };
export function conversationReducer(state: Conversation, event: ConversationEvent): Conversation {
  switch (event.type) {
    case 'listen': return state.phase === 'answered' ? { ...state, phase: 'listening', emotion: 'listening' } : state;
    case 'think': return state.phase !== 'resting' ? { ...state, phase: 'thinking', emotion: 'thinking' } : state;
    case 'speak': return state.phase !== 'resting' ? { ...state, phase: 'speaking' } : state;
    case 'reply': return state.phase === 'thinking' ? { phase: event.speaking ? 'speaking' : 'answered', emotion: event.answer.emotion, answers: [...state.answers, event.answer].slice(-100) } : state;
    case 'finish': return state.phase !== 'resting' ? { ...state, phase: 'answered', emotion: state.answers.at(-1)?.emotion ?? 'happy' } : state;
    case 'pause': return { ...state, phase: 'resting', emotion: 'sleepy' };
    case 'wake': return { ...state, phase: 'answered', emotion: state.answers.at(-1)?.emotion ?? 'happy' };
    case 'reset': return { ...initialConversation, phase: state.phase === 'resting' ? 'resting' : 'answered', emotion: state.phase === 'resting' ? 'sleepy' : 'happy' };
  }
}
