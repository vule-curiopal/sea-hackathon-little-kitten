import test from 'node:test';
import assert from 'node:assert/strict';
import { userMessageText } from './message-text.ts';
import { voiceUserMessage } from './voice-conversation.ts';

const t = (key: string) => key;
test('pending voice messages show progress rather than a missing-transcript failure', () => {
  assert.equal(userMessageText(voiceUserMessage(1), t, { pending: true }), 'voiceMessageProcessing');
  assert.equal(userMessageText(voiceUserMessage(1), t), 'voiceTranscriptUnavailable');
});
test('fixed reference speech is explained instead of passed off as a failed live transcript', () => {
  const user = voiceUserMessage(2, { provider_mode: 'fake', transcript: { text: 'Fixture sentence', language: 'en', uncertain_spans: [] } });
  assert.equal(userMessageText(user, t, { reference: true }), 'voiceReferenceTranscript');
  assert.equal(userMessageText(user, t, { reference: true, pending: true }), 'voiceMessageProcessing');
});
test('available sentences always win over stale fallback flags for typing and live voice', () => {
  assert.equal(userMessageText({ id: 3, role: 'user', source: 'typed', text: 'My typed sentence', unavailable: true }, t), 'My typed sentence');
  const user = voiceUserMessage(4, { provider_mode: 'real', transcript: { text: 'My spoken sentence', language: 'en', uncertain_spans: [] } });
  assert.equal(userMessageText({ ...user, unavailable: true }, t, { pending: true }), 'My spoken sentence');
});
