import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_CHANGED_EVENT, AuthApiError, getCurrentUser, login, logout, register } from './auth-api.ts';

// Frontend request-contract fixtures only; no backend, database or provider runs.
const current = { user: { id: 'unit-user', username: 'sam', profile_key: 'unit-account' } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('registration sends only username/password with cookies and preserves the password exactly', async t => {
  let seen: { path: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { path: String(input), init };
    return json({ ...current, expires_at: '2027-01-01T00:00:00.000Z', token: 'unit-private-field', user: { ...current.user, password_hash: 'unit-private-field' } }, 201);
  });
  const password = '  🐱password-12  ';
  assert.deepEqual(await register(' sam ', password), { ...current, expires_at: '2027-01-01T00:00:00.000Z' });
  assert.equal(seen?.path, '/api/auth/register');
  assert.equal(seen?.init?.method, 'POST');
  assert.equal(seen?.init?.credentials, 'include');
  assert.equal(seen?.init?.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(seen?.init?.body)), { username: 'sam', password });
  assert.equal(new Headers(seen?.init?.headers).has('Authorization'), false);
});

test('login forwards an existing one-character password and accepts a session without expiry', async t => {
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), '/api/auth/login');
    assert.deepEqual(JSON.parse(String(init?.body)), { username: 'sam', password: '1' });
    assert.equal(init?.credentials, 'include');
    return json(current);
  });
  assert.deepEqual(await login('sam', '1'), current);
});

test('current-user lookup returns null on 401 even when the response has no JSON body', async t => {
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'include');
    return new Response('', { status: 401 });
  });
  assert.equal(await getCurrentUser(), null);
});

test('current-user lookup accepts the public username identity and rejects malformed success bodies', async t => {
  let result: unknown = current;
  t.mock.method(globalThis, 'fetch', async () => json(result));
  assert.deepEqual(await getCurrentUser(), current);
  for (const value of [{}, { user: { id: 'unit', username: 'sam' } }, { ...current, expires_at: 'invalid-date' }, { user: { id: 'unit', email: 'unit@example.invalid', profile_key: 'unit-account' } }]) {
    result = value;
    await assert.rejects(getCurrentUser(), error => error instanceof AuthApiError && error.code === 'invalid_response');
  }
});

test('account failures preserve known safe error codes and HTTP status', async t => {
  let code = 'invalid_credentials';
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => json({ error: { code, message: 'Untrusted server message' } }, status));
  for (const pair of [['invalid_credentials', 401], ['username_in_use', 409], ['invalid_username', 400], ['invalid_password', 400], ['rate_limit', 429], ['auth_busy', 503]] as const) {
    [code, status] = pair;
    await assert.rejects(login('sam', '1'), error => error instanceof AuthApiError && error.code === code && error.status === status && !error.message.includes('Untrusted'));
  }
});

test('non-JSON rate-limit responses remain actionable and unknown errors are generic', async t => {
  let response = new Response('Too many requests', { status: 429 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(login('sam', '1'), error => error instanceof AuthApiError && error.code === 'rate_limit');
  response = json({ error: { code: 'private_diagnostic_detail' } }, 500);
  await assert.rejects(login('sam', '1'), error => error instanceof AuthApiError && error.code === 'unavailable');
});

test('network errors have a generic code and explicit aborts remain cancellations', async t => {
  let failure: Error = new TypeError('Unit network detail that should not be shown');
  t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(login('sam', '1'), error => error instanceof AuthApiError && error.code === 'network' && !error.message.includes('Unit network'));
  failure = new DOMException('Unit cancellation', 'AbortError');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(login('sam', '1', controller.signal), error => error === failure);
});

test('logout uses the cookie-authenticated POST and accepts an empty 204 response', async t => {
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), '/api/auth/logout');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.body, undefined);
    return new Response(null, { status: 204 });
  });
  await logout();
});

test('account gates are notified after successful mutations, without identity or credential data in the event', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const windowFixture = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowFixture });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const seen: Event[] = [];
  windowFixture.addEventListener(AUTH_CHANGED_EVENT, event => seen.push(event));
  let valid = true;
  t.mock.method(globalThis, 'fetch', async () => valid ? json(current) : json({ error: { code: 'invalid_credentials' } }, 401));
  await login('sam', '1'); await register('sam', 'unit-password-12'); await getCurrentUser(); await logout();
  assert.equal(seen.length, 3);
  assert.ok(seen.every(event => !('detail' in event)));
  valid = false;
  await assert.rejects(login('sam', 'bad'));
  assert.equal(seen.length, 3);
});
