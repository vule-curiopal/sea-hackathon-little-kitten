import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_KEY, historyReducer, latestHistoryRequestId, readConversationHistory, saveConversationHistory } from './conversation-history.ts';
import { initialConversation, MAX_MESSAGES, type Conversation, type ConversationMessage } from './conversation.ts';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
function exchange(id: number, voice = false): Conversation {
  return { ...initialConversation, phase: 'speaking', pendingRequestId: id, messages: [
    { id, role: 'user', text: voice ? 'Một câu chuyện nhé' : 'Hello Miu', source: voice ? 'voice' : 'typed' },
    { id, role: 'miu', text: voice ? 'Ngày xưa có một chú mèo…' : 'Hello, friend!', emotion: 'happy', source: voice ? 'voice' : 'sample', intensity: .6 },
  ] };
}

test('both sides of typed and voice conversations survive a reload as idle text', () => {
  const device = storage();
  const an = exchange(1);
  const binh = exchange(9, true);
  assert.equal(saveConversationHistory(device, { an, binh }), true);
  const restored = readConversationHistory(device);
  assert.deepEqual(restored.an.messages, an.messages);
  assert.deepEqual(restored.binh.messages, binh.messages);
  assert.equal(restored.an.phase, 'answered');
  assert.equal(restored.binh.phase, 'answered');
  assert.equal(restored.an.pendingRequestId, undefined);
  assert.equal(latestHistoryRequestId(restored), 9);
  assert.ok(!device.getItem(HISTORY_KEY)?.includes('pendingRequestId'));
});

test('new conversation deletes both sides for only the active profile and stays deleted on reload', () => {
  const device = storage();
  const history = { an: exchange(1), binh: exchange(2, true) };
  const cleared = historyReducer(history, { profile: 'an', event: { type: 'reset' } });
  assert.deepEqual(cleared.an.messages, []);
  assert.equal(cleared.binh, history.binh);
  saveConversationHistory(device, cleared);
  const restored = readConversationHistory(device);
  assert.deepEqual(restored.an.messages, []);
  assert.deepEqual(restored.binh.messages, history.binh.messages);
});

test('stopping or resting preserves submitted messages but prevents canceled buddy replies', () => {
  const user = exchange(1).messages[0];
  let history = historyReducer({}, { profile: 'an', event: { type: 'think', requestId: 1, user: { ...user, role: 'user', source: 'typed' } } });
  history = historyReducer(history, { profile: 'an', event: { type: 'pause' } });
  const after = historyReducer(history, { profile: 'an', event: { type: 'reply', answer: { id: 1, text: 'Canceled', emotion: 'happy' }, speaking: false } });
  assert.equal(after, history);
  assert.equal(after.an.messages.length, 1);
});

test('malformed history and unavailable storage do not crash the conversation', () => {
  assert.deepEqual(readConversationHistory({ getItem: () => '{invalid json' }), {});
  assert.deepEqual(readConversationHistory({ getItem: () => { throw new Error('blocked'); } }), {});
  assert.equal(saveConversationHistory({ setItem: () => { throw new Error('quota'); } }, {}), false);
  const device = storage();
  device.setItem(HISTORY_KEY, JSON.stringify({ version: 1, profiles: { an: [null, { role: 'user', id: 'bad', text: 'bad' }, ...exchange(3).messages, ...exchange(3).messages] } }));
  assert.deepEqual(readConversationHistory(device).an.messages, exchange(3).messages);
});

test('history keeps its documented message limit, including missing voice transcripts', () => {
  const device = storage();
  const messages: ConversationMessage[] = Array.from({ length: MAX_MESSAGES + 4 }, (_, id) => ({ id, role: 'user', source: 'voice', text: '', unavailable: true }));
  saveConversationHistory(device, { an: { ...initialConversation, messages } });
  const restored = readConversationHistory(device);
  assert.equal(restored.an.messages.length, MAX_MESSAGES);
  assert.equal(restored.an.messages[0].id, 4);
});
