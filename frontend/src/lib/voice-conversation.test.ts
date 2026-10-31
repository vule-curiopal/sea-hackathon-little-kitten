import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationReducer as reduce, initialConversation, lastUserMessage } from './conversation.ts';
import { voiceConversationEvent, voiceUserMessage } from './voice-conversation.ts';

test('realtime final words survive a processing placeholder and a subsequent engine failure', () => {
  const id = 99;
  const user = { id, role: 'user' as const, source: 'voice' as const, text: 'Tell me a story' };
  let state = reduce(initialConversation, { type: 'listen', requestId: id });
  state = reduce(state, { type: 'transcript', user });
  state = reduce(state, { type: 'think', requestId: id, user: voiceUserMessage(id) });
  assert.equal(lastUserMessage(state)?.text, user.text);
  state = reduce(state, { type: 'finish', requestId: id });
  assert.equal(lastUserMessage(state)?.text, user.text);
  assert.notEqual(lastUserMessage(state)?.unavailable, true);
  const reset = reduce(state, { type: 'reset' });
  assert.equal(reduce(reset, { type: 'transcript', user }), reset);
  const newer = reduce(reset, { type: 'listen', requestId: id + 1 });
  assert.equal(reduce(newer, { type: 'transcript', user }), newer);
});

test('voice connection success or failure cannot discard a pending typed reply', () => {
  for (const phase of ['idle', 'error'] as const) {
    const waiting = reduce(initialConversation, { type: 'think', requestId: 11 });
    const event = voiceConversationEvent('initializing', phase);
    assert.equal(event, null);
    const afterSetup = event ? reduce(waiting, event) : waiting;
    const answered = reduce(afterSetup, { type: 'reply', answer: { id: 11, text: 'The typed reply is visible.', emotion: 'happy', source: 'sample' }, speaking: false });
    assert.equal(answered.messages[0]?.text, 'The typed reply is visible.');
    assert.equal(answered.phase, 'answered');
  }
});

test('a valid caption arriving after playback begins is kept without stopping speech', () => {
  const waiting = reduce(initialConversation, { type: 'think', requestId: 12 });
  const speaking = reduce(waiting, { type: 'speak' });
  const caption = reduce(speaking, { type: 'reply', answer: { id: 12, text: 'Voice reply caption.', emotion: 'curious', source: 'voice' }, speaking: false });
  assert.equal(caption.messages[0]?.text, 'Voice reply caption.');
  assert.equal(caption.phase, 'speaking');
  const ended = reduce(caption, { type: 'finish', requestId: 12 });
  assert.equal(ended.messages[0]?.text, 'Voice reply caption.');
  assert.equal(ended.phase, 'answered');
});

test('only the pending request can supply a caption and repeated delivery is ignored', () => {
  const waiting = reduce(initialConversation, { type: 'think', requestId: 14 });
  const old = { id: 13, text: 'Old reply', emotion: 'happy' as const };
  assert.equal(reduce(waiting, { type: 'reply', answer: old, speaking: false }), waiting);
  const latest = { ...old, id: 14, text: 'Current reply' };
  const answered = reduce(waiting, { type: 'reply', answer: latest, speaking: false });
  assert.equal(answered.messages.length, 1);
  assert.equal(reduce(answered, { type: 'reply', answer: latest, speaking: false }), answered);
});

test('stopping, pausing, and resetting invalidate pending captions', () => {
  const waiting = reduce(initialConversation, { type: 'think', requestId: 15 });
  const answer = { id: 15, text: 'Canceled reply', emotion: 'happy' as const };
  for (const type of ['finish', 'pause', 'reset'] as const) {
    const canceled = reduce(waiting, { type });
    const after = reduce(canceled, { type: 'reply', answer, speaking: false });
    assert.equal(after.messages.length, 0, type);
    assert.equal(after.pendingRequestId, undefined, type);
  }
});

test('a stale voice completion cannot finish a newer typed request', () => {
  const waiting = reduce(initialConversation, { type: 'think', requestId: 17 });
  assert.equal(reduce(waiting, { type: 'finish', requestId: 16 }), waiting);
  const answered = reduce(waiting, { type: 'reply', answer: { id: 17, text: 'Still delivered.', emotion: 'happy' }, speaking: false });
  assert.equal(answered.messages[0]?.text, 'Still delivered.');
});

test('a real voice transcript replaces its placeholder once and precedes the buddy reply', () => {
  const id = 21;
  let state = reduce(initialConversation, { type: 'listen', requestId: id });
  state = reduce(state, { type: 'think', requestId: id, user: voiceUserMessage(id) });
  assert.equal(state.messages[0].role, 'user');
  const user = voiceUserMessage(id, { provider_mode: 'real', transcript: { text: 'Tell me a story', language: 'en', uncertain_spans: [] } });
  const event = { type: 'reply' as const, user, answer: { id, text: 'Once there was a little cat.', emotion: 'curious' as const, source: 'voice' as const }, speaking: false };
  state = reduce(state, event);
  assert.deepEqual(state.messages.map(message => [message.role, message.text]), [['user', 'Tell me a story'], ['miu', 'Once there was a little cat.']]);
  assert.equal(reduce(state, event), state);
});

test('reference, missing, and uncertain transcripts are represented honestly', () => {
  const fixed = voiceUserMessage(22, { provider_mode: 'fake', transcript: { text: 'Fixed fixture words', language: 'en', uncertain_spans: [] } });
  assert.equal(fixed.text, '');
  assert.equal(fixed.unavailable, true);
  assert.equal(voiceUserMessage(23, { provider_mode: 'real', transcript: null }).unavailable, true);
  const uncertain = voiceUserMessage(24, { provider_mode: 'real', transcript: { text: 'Maybe these words', language: 'en', uncertain_spans: [{}] } });
  assert.equal(uncertain.text, 'Maybe these words');
  assert.equal(uncertain.uncertain, true);
});

test('voice lifecycle starts and ends only its own active turn', () => {
  assert.deepEqual(voiceConversationEvent('idle', 'recording', 18), { type: 'listen', requestId: 18 });
  assert.deepEqual(voiceConversationEvent('recording', 'processing', 18), { type: 'think', requestId: 18, user: voiceUserMessage(18) });
  assert.deepEqual(voiceConversationEvent('processing', 'speaking', 18), { type: 'speak' });
  assert.deepEqual(voiceConversationEvent('speaking', 'idle', 18), { type: 'finish', requestId: 18 });
  assert.deepEqual(voiceConversationEvent('playback_blocked', 'error', 18), { type: 'finish', requestId: 18 });
  assert.equal(voiceConversationEvent('idle', 'idle'), null);
  const listening = reduce(initialConversation, { type: 'listen', requestId: 18 });
  assert.equal(reduce(listening, { type: 'finish', requestId: 18 }).phase, 'answered');
});

test('voice events require a new Talk press before each turn', () => {
  for (const [previous, next] of [['idle', 'recording'], ['recording', 'processing'], ['processing', 'speaking'], ['speaking', 'idle']] as const) {
    assert.equal(voiceConversationEvent(previous, next), null);
  }
  let state = reduce(initialConversation, voiceConversationEvent('idle', 'recording', 30)!);
  state = reduce(state, voiceConversationEvent('recording', 'processing', 30)!);
  state = reduce(state, { type: 'reply', answer: { id: 30, text: 'Hello again', emotion: 'happy' }, speaking: false });
  state = reduce(state, voiceConversationEvent('speaking', 'idle', 30)!);
  assert.equal(state.phase, 'answered');
  assert.equal(voiceConversationEvent('idle', 'recording'), null);
  assert.equal(voiceConversationEvent('idle', 'recording', 31)?.type, 'listen');
});

test('server text processing preserves the typed sentence without inserting a voice placeholder', () => {
  const user = { id: 40, role: 'user' as const, text: 'My typed question', source: 'typed' as const };
  let state = reduce(initialConversation, { type: 'think', requestId: user.id, user });
  assert.equal(voiceConversationEvent('idle', 'idle', user.id, 'text'), null);
  const processing = voiceConversationEvent('idle', 'processing', user.id, 'text');
  assert.deepEqual(processing, { type: 'think', requestId: user.id });
  state = reduce(state, processing!);
  state = reduce(state, { type: 'reply', answer: { id: user.id, text: 'A server reply', emotion: 'happy', source: 'voice' }, speaking: false });
  assert.deepEqual(state.messages.map(message => [message.role, message.text]), [['user', user.text], ['miu', 'A server reply']]);
  assert.equal(state.messages[0].source, 'typed');
});

test('explicit greetings create no user voice message and do not reuse an earlier typed sentence', () => {
  const user = { id: 41, role: 'user' as const, text: 'An earlier question', source: 'typed' as const };
  let state = reduce(initialConversation, { type: 'think', requestId: user.id, user });
  state = reduce(state, { type: 'reply', answer: { id: user.id, text: 'An earlier reply', emotion: 'happy' }, speaking: false });
  state = reduce(state, voiceConversationEvent('idle', 'processing', 42, 'greeting')!);
  state = reduce(state, { type: 'reply', answer: { id: 42, text: 'A new greeting', emotion: 'love' }, speaking: false });
  assert.equal(state.messages.length, 3);
  assert.equal(lastUserMessage(state), undefined);
});

test('server replay invalidation clears saved words while retaining the approved current reply', () => {
  const old = reduce(initialConversation, { type: 'think', requestId: 43, user: { id: 43, role: 'user', text: 'Forget this detail', source: 'typed' } });
  let state = reduce(old, { type: 'reset' });
  state = reduce(state, { type: 'think', requestId: 43 });
  state = reduce(state, { type: 'reply', answer: { id: 43, text: 'I have forgotten it.', emotion: 'neutral' }, speaking: false });
  assert.deepEqual(state.messages.map(message => message.text), ['I have forgotten it.']);
});
