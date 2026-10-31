import type { TurnResponse, VoiceControllerState } from '@miu/voice-client';
import type { ConversationEvent, UserMessage } from './conversation.ts';

/** Only a fresh Talk press owns a request ID; setup and unsolicited events cannot create a turn. */
export function voiceConversationEvent(previous: VoiceControllerState, next: VoiceControllerState, requestId?: number, input: 'audio' | 'text' | 'greeting' = 'audio'): ConversationEvent | null {
  if (requestId === undefined) return null;
  if (next === 'recording') return { type: 'listen', requestId };
  if (next === 'processing') return { type: 'think', requestId, ...(input === 'audio' ? { user: voiceUserMessage(requestId) } : {}) };
  if (next === 'speaking') return { type: 'speak' };
  if ((next === 'idle' || next === 'error') && ['recording', 'processing', 'speaking', 'playback_blocked'].includes(previous)) return { type: 'finish', requestId };
  return null;
}

/** Fixed fixtures never stand in for the user's speech. Audio itself is not saved. */
export function voiceUserMessage(id: number, response?: Pick<TurnResponse, 'provider_mode' | 'transcript'>): UserMessage {
  const transcript = response?.provider_mode === 'real' ? response.transcript : null;
  const text = transcript?.text.trim() ?? '';
  return { id, role: 'user', text, source: 'voice', ...(!text ? { unavailable: true } : {}), ...(transcript?.uncertain_spans.length ? { uncertain: true } : {}) };
}
