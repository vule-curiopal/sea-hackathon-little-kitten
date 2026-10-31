import test from 'node:test';
import assert from 'node:assert/strict';
import { initialConversation, type Conversation } from './conversation.ts';
import { HISTORY_KEY, historyReducer, saveConversationHistory } from './conversation-history.ts';
import { accountHistoryStorage, readScopedHistory, saveScopedHistory } from './useConversationHistory.ts';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function conversation(text: string): Conversation {
  return { ...initialConversation, messages: [{ id: 1, role: 'user', text, source: 'typed' }] };
}

test('an account does not inherit legacy An/Bình browser conversations', () => {
  const device = storage();
  saveConversationHistory(device, { an: conversation('Legacy An message'), binh: conversation('Legacy Bình message') });
  const legacy = device.getItem(HISTORY_KEY);
  assert.deepEqual(readScopedHistory(device, 'user-one'), {});
  assert.equal(saveScopedHistory(device, { an: conversation('Private account message') }, 'user-one'), true);
  assert.equal(device.getItem(HISTORY_KEY), legacy);
  assert.equal(readScopedHistory(device, 'user-one').an.messages[0]?.text, 'Private account message');
});

test('two account IDs have separate local message histories even with the same internal profile slot', () => {
  const device = storage();
  saveScopedHistory(device, { an: conversation('First account') }, 'user-one');
  saveScopedHistory(device, { an: conversation('Second account') }, 'user-two');
  assert.equal(readScopedHistory(device, 'user-one').an.messages[0]?.text, 'First account');
  assert.equal(readScopedHistory(device, 'user-two').an.messages[0]?.text, 'Second account');
  assert.equal(device.getItem(HISTORY_KEY), null);
});

test('guest history performs no browser-storage reads or writes', () => {
  const forbidden = { getItem: () => { throw new Error('Guest must not read account messages'); }, setItem: () => { throw new Error('Guest must not persist messages'); } };
  assert.deepEqual(readScopedHistory(forbidden, undefined, false), {});
  assert.equal(saveScopedHistory(forbidden, { an: conversation('Guest RAM message') }, undefined, false), true);
});

test('resetting one account history leaves another account history intact', () => {
  const device = storage();
  const first = { an: conversation('First account') };
  saveScopedHistory(device, first, 'user-one');
  saveScopedHistory(device, { an: conversation('Second account') }, 'user-two');
  saveScopedHistory(device, historyReducer(first, { profile: 'an', event: { type: 'reset' } }), 'user-one');
  assert.deepEqual(readScopedHistory(device, 'user-one').an.messages, []);
  assert.equal(readScopedHistory(device, 'user-two').an.messages[0]?.text, 'Second account');
});

test('namespace encoding does not merge distinct account identifiers', () => {
  const device = storage();
  accountHistoryStorage(device, 'unit/one').setItem(HISTORY_KEY, 'slash');
  accountHistoryStorage(device, 'unit%2Fone').setItem(HISTORY_KEY, 'percent');
  assert.equal(accountHistoryStorage(device, 'unit/one').getItem(HISTORY_KEY), 'slash');
  assert.equal(accountHistoryStorage(device, 'unit%2Fone').getItem(HISTORY_KEY), 'percent');
});
