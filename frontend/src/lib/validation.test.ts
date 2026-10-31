import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuth } from './validation.ts';

test('usernames accept the defined ASCII alphabet and trimmed 3–32 character boundaries', () => {
  for (const username of ['sam', '_ab', 'A-b.c_7', 'a'.repeat(32), '  sam  ']) {
    assert.deepEqual(validateAuth({ username, password: '1' }, true), {});
  }
  for (const username of ['', 'ab', 'a'.repeat(33), '.sam', '-sam', 's am', 'sam@example.com', 'Bình', 'a/b']) {
    assert.equal(validateAuth({ username, password: '1' }, true).username, 'usernameError');
  }
});

test('registration accepts any nonempty password, including one character', () => {
  for (const password of ['1', 'a', ' ', '🐱', 'a'.repeat(129), '🐱'.repeat(129)]) {
    assert.deepEqual(validateAuth({ username: 'sam', password }, false), {});
  }
  assert.deepEqual(validateAuth({ username: 'sam', password: '' }, false), { password: 'passwordRequired' });
});

test('login requires a nonempty password without length or strength rules', () => {
  assert.deepEqual(validateAuth({ username: 'sam', password: '1' }, true), {});
  assert.deepEqual(validateAuth({ username: 'sam', password: ' 1 ' }, true), {});
  assert.deepEqual(validateAuth({ username: 'sam', password: '' }, true), { password: 'passwordRequired' });
});

test('validation does not alter password whitespace, Unicode normalization or input fields', () => {
  const values = { username: ' sam ', password: '  e\u0301password12  ' };
  const original = { ...values };
  validateAuth(values, false);
  assert.deepEqual(values, original);
});
