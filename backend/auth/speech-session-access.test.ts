/** Cookie/ownership contracts only. No Miu application, speech transport,
 * response provider, or model behavior is constructed or evaluated here. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '../memory/index.js';
import { AuthStore } from './store.js';
import { accountSpeechSessionAuthorizer } from './session-access.js';
import { AUTH_COOKIE_NAME } from './http.js';

const cookie = (token?: string) => ({ headers: token ? { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } : {} });
const conversation = (key: string) => ({ profile: { key } });
const errorCode = (code: string, status: number) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code && 'status' in error && error.status === status;

test('offline auth contract: account speech requires the matching owner cookie; only guest profiles bypass it', async () => {
  const wall = new Date('2026-10-31T03:00:00.000Z');
  const memory = await createMemoryStore({ now: () => new Date(wall) });
  try {
    const auth = new AuthStore(memory, { now: () => new Date(wall) });
    const owner = await auth.register('speech_owner', 'offline-auth-contract-password');
    const other = await auth.register('speech_other', 'offline-auth-contract-password');
    const authorize = accountSpeechSessionAuthorizer(auth);
    const session = conversation(owner.user.profile_key);
    await assert.doesNotReject(authorize(cookie(owner.token), session));
    await assert.rejects(authorize(cookie(), session), errorCode('unauthorized', 401));
    await assert.rejects(authorize(cookie(other.token), session), errorCode('forbidden', 403));
    await assert.rejects(authorize(cookie(), conversation('an')), errorCode('unauthorized', 401));
    await assert.doesNotReject(authorize(cookie(), conversation('guest_' + randomUUID())));
  } finally { await memory.close(); }
});

test('offline auth contract: authorization rechecks the same handshake cookie after revocation', async () => {
  const wall = new Date('2026-10-31T03:00:00.000Z');
  const memory = await createMemoryStore({ now: () => new Date(wall) });
  try {
    const auth = new AuthStore(memory, { now: () => new Date(wall) });
    const owner = await auth.register('speech_revocation', 'offline-auth-contract-password');
    const authorize = accountSpeechSessionAuthorizer(auth);
    const request = cookie(owner.token); const session = conversation(owner.user.profile_key);
    await assert.doesNotReject(authorize(request, session));
    await auth.revoke(owner.token);
    await assert.rejects(authorize(request, session), errorCode('unauthorized', 401));
  } finally { await memory.close(); }
});
