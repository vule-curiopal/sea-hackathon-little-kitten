import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import supertest from 'supertest';
import { DEFAULT_VOICE, LIMITS } from '@miu/voice-contracts';
import { registerErrorHandler } from '../pipeline/src/http/error-handler.js';
import { SessionService } from '../pipeline/src/modules/sessions/session.service.js';
import { AppError } from '../shared/types.js';
import { assertAuthRequestOrigin, authenticateRequest, registerAuthRoutes, requestAuthToken } from './http.js';
import type { AuthSession, AuthUser } from './store.js';

// Offline HTTP contracts only. The stub represents account-store responses;
// it does not evaluate Miu, call a model, or claim password-hashing quality.
class ContractStore {
  readonly user: AuthUser = { id: 'offline-user-id', username: 'sam', profile_key: 'offline-profile' };
  readonly sessions = new Map<string, AuthUser>();
  loginCalls = 0;
  registerCalls = 0;
  readonly revoked: string[] = [];
  async register(username: unknown, password: unknown): Promise<AuthSession> {
    this.registerCalls++;
    if (typeof password !== 'string' || password.length < 12) throw new AppError('invalid_password', 400);
    return this.issue({ ...this.user, username: String(username).trim().toLowerCase() });
  }
  async login(username: unknown, password: unknown): Promise<AuthSession> {
    this.loginCalls++;
    if (String(username).trim().toLowerCase() !== 'sam' || password !== '1') throw new AppError('invalid_credentials', 401, 'must-not-expose-internal-password-hash');
    return this.issue(this.user);
  }
  async authenticate(token: unknown): Promise<AuthUser | null> { return typeof token === 'string' ? this.sessions.get(token) ?? null : null; }
  async revoke(token: unknown): Promise<void> { if (typeof token === 'string') { this.revoked.push(token); this.sessions.delete(token); } }
  private issue(user: AuthUser): AuthSession {
    const token = `offline-token-${this.sessions.size + 1}-${this.loginCalls}-${this.registerCalls}`;
    // Whitelisting at the HTTP boundary must survive extra internal store fields.
    this.sessions.set(token, Object.assign({ ...user }, { password_hash: 'offline-private-hash' }));
    return { user: Object.assign({ ...user }, { password_hash: 'offline-private-hash' }), token, expiresAt: '2026-12-01T00:00:00.000Z' };
  }
}
function fixture(options: { allowedOrigins?: string[]; secureCookies?: boolean; onLogout?: (user: AuthUser) => Promise<void> } = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: LIMITS.requestBytes }));
  const store = new ContractStore();
  registerAuthRoutes(app, store, { allowedOrigins: options.allowedOrigins ?? [], ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }), ...(options.onLogout ? { onLogout: options.onLogout } : {}) });
  app.post('/api/owned-probe', (request, response) => {
    assertAuthRequestOrigin(request, options.allowedOrigins ?? []);
    response.status(204).end();
  });
  registerErrorHandler(app, new SessionService(DEFAULT_VOICE), new WeakMap());
  return { http: supertest(app), store };
}
const origin = 'http://miu.test';
const setCookieHeader = (response: { headers: Record<string, unknown> }): string => {
  const values = response.headers['set-cookie'];
  const first = Array.isArray(values) ? values[0] : undefined;
  assert.equal(typeof first, 'string');
  return String(first);
};
const cookie = (response: { headers: Record<string, unknown> }): string => setCookieHeader(response).split(';')[0]!;

test('offline auth HTTP: seed login accepts password 1, uses a seven-day protected cookie, and exposes only public user fields', async () => {
  const { http, store } = fixture();
  const loggedIn = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: 'sam', password: '1' });
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(loggedIn.body, { user: store.user });
  assert.equal(loggedIn.headers['cache-control'], 'no-store');
  const sessionCookie = setCookieHeader(loggedIn);
  for (const part of ['miu_auth=', 'Max-Age=604800', 'Path=/', 'HttpOnly', 'SameSite=Strict']) assert.ok(sessionCookie.includes(part), part);
  assert.doesNotMatch(sessionCookie, /; Secure/u);
  const me = await http.get('/api/auth/me').set('Host', 'miu.test').set('Cookie', cookie(loggedIn));
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { user: store.user });
  assert.equal(me.headers['cache-control'], 'no-store');
  assert.equal(Object.hasOwn(me.body, 'token'), false);
  assert.equal(Object.hasOwn(me.body.user, 'password_hash'), false);
});

test('offline auth HTTP: public registration delegates password policy and never returns session credentials', async () => {
  const { http, store } = fixture();
  const rejected = await http.post('/api/auth/register').set('Host', 'miu.test').set('Origin', origin).send({ username: 'new_family', password: '1' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'invalid_password');
  const registered = await http.post('/api/auth/register').set('Host', 'miu.test').set('Origin', origin).send({ username: 'New_Family', password: 'a-long-password' });
  assert.equal(registered.status, 201);
  assert.deepEqual(registered.body, { user: { ...store.user, username: 'new_family' } });
  assert.equal(registered.headers['cache-control'], 'no-store');
  assert.ok(registered.headers['set-cookie']);
  assert.equal(Object.hasOwn(registered.body, 'token'), false);
  assert.equal(Object.hasOwn(registered.body, 'expiresAt'), false);
});

test('offline auth HTTP: credentials require exactly a JSON username/password object and retain the transport size limit', async () => {
  const { http, store } = fixture();
  for (const body of [[], {}, { username: 'sam' }, { username: 'sam', password: 1 }, { username: 'sam', password: '1', profile_key: 'other' }]) {
    const response = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_request');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const plain = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).type('text/plain').send('{"username":"sam","password":"1"}');
  assert.equal(plain.status, 415);
  const oversize = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: 'sam', password: 'x'.repeat(LIMITS.requestBytes + 1_024) });
  assert.equal(oversize.status, 413);
  assert.equal(oversize.headers['cache-control'], 'no-store');
  assert.equal(store.loginCalls, 0);
});

test('offline auth HTTP: disallowed, opaque, malformed, and cross-site origins are rejected before account operations', async () => {
  const { http, store } = fixture();
  for (const suppliedOrigin of ['https://other.test', 'null', 'http://miu.test/untrusted-path', 'https://miu.test@other.test']) {
    const response = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', suppliedOrigin).send({ username: 'sam', password: '1' });
    assert.equal(response.status, 403, suppliedOrigin);
    assert.equal(response.body.error.code, 'auth_origin_forbidden');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const crossSite = await http.post('/api/auth/register').set('Host', 'miu.test').set('Sec-Fetch-Site', 'cross-site').send({ username: 'new_family', password: 'a-long-password' });
  assert.equal(crossSite.status, 403);
  const sameSiteWithoutOrigin = await http.post('/api/auth/logout').set('Host', 'miu.test').set('Sec-Fetch-Site', 'same-site');
  assert.equal(sameSiteWithoutOrigin.status, 403);
  const forgedSite = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').send({ username: 'sam', password: '1' });
  assert.equal(forgedSite.status, 403);
  assert.equal(store.loginCalls, 0);
  assert.equal(store.registerCalls, 0);
});

test('offline auth HTTP: only configured cross-origin callers receive credentialed CORS and preflight support', async () => {
  const allowed = 'https://app.example.test';
  const { http } = fixture({ allowedOrigins: [allowed] });
  const preflight = await http.options('/api/auth/login').set('Host', 'miu.test').set('Origin', allowed).set('Sec-Fetch-Site', 'cross-site').set('Access-Control-Request-Method', 'POST');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], allowed);
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
  const login = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', allowed).set('Sec-Fetch-Site', 'cross-site').send({ username: 'sam', password: '1' });
  assert.equal(login.status, 200);
  assert.equal(login.headers['access-control-allow-origin'], allowed);
  assert.equal(login.headers['access-control-allow-credentials'], 'true');
  assert.match(String(login.headers.vary), /Origin/u);
});

test('offline auth HTTP: the reusable origin gate protects account writes outside the auth route prefix', async () => {
  const { http } = fixture({ allowedOrigins: ['https://app.example.test'] });
  for (const path of ['/api/owned-probe', '/api/OWNED-PROBE/']) {
    const rejected = await http.post(path).set('Host', 'miu.test').set('Origin', 'https://other.test');
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, 'auth_origin_forbidden');
    assert.equal((await http.post(path).set('Host', 'miu.test').set('Origin', origin)).status, 204);
    assert.equal((await http.post(path).set('Host', 'miu.test').set('Origin', 'https://app.example.test').set('Sec-Fetch-Site', 'cross-site')).status, 204);
  }
});

test('offline auth HTTP: HTTPS and explicit secure-cookie configuration set Secure', async () => {
  const secureRequest = fixture({ secureCookies: false });
  const https = await secureRequest.http.post('/api/auth/login').set('Host', 'miu.test').set('X-Forwarded-Proto', 'https').set('Origin', 'https://miu.test').send({ username: 'sam', password: '1' });
  assert.equal(https.status, 200);
  assert.match(setCookieHeader(https), /; Secure/u);
  const forced = fixture({ secureCookies: true });
  const response = await forced.http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: 'sam', password: '1' });
  assert.match(setCookieHeader(response), /; Secure/u);
});

test('offline auth HTTP: logout revokes the cookie session, clears it, and remains idempotent', async () => {
  const { http, store } = fixture();
  const login = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: 'sam', password: '1' });
  const sessionCookie = cookie(login);
  const denied = await http.post('/api/auth/logout').set('Host', 'miu.test').set('Origin', 'https://other.test').set('Cookie', sessionCookie);
  assert.equal(denied.status, 403);
  assert.equal(store.revoked.length, 0);
  const logout = await http.post('/api/auth/logout').set('Host', 'miu.test').set('Origin', origin).set('Cookie', sessionCookie);
  assert.equal(logout.status, 204);
  assert.equal(logout.text, '');
  assert.match(setCookieHeader(logout), /^miu_auth=;/u);
  assert.match(setCookieHeader(logout), /Expires=Thu, 01 Jan 1970/u);
  assert.equal(store.revoked.length, 1);
  const me = await http.get('/api/auth/me').set('Host', 'miu.test').set('Cookie', sessionCookie);
  assert.equal(me.status, 401);
  assert.equal(me.body.error.code, 'unauthorized');
  assert.equal(me.headers['cache-control'], 'no-store');
  assert.equal((await http.post('/api/auth/logout').set('Host', 'miu.test').set('Origin', origin)).status, 204);
});

test('offline auth HTTP: logout revocation and cookie clearing survive a failing conversation-cleanup callback', async () => {
  const observed: AuthUser[] = [];
  const { http, store } = fixture({ onLogout: async user => {
    assert.equal(store.sessions.size, 0);
    observed.push(user);
    throw new Error('offline-cleanup-failure');
  } });
  const login = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: 'sam', password: '1' });
  const logout = await http.post('/api/auth/logout').set('Host', 'miu.test').set('Origin', origin).set('Cookie', cookie(login));
  assert.equal(logout.status, 204);
  assert.equal(logout.text, '');
  assert.match(setCookieHeader(logout), /^miu_auth=;/u);
  assert.deepEqual(observed, [store.user]);
  assert.equal(store.revoked.length, 1);
  const afterLogout = await http.get('/api/auth/me').set('Host', 'miu.test').set('Cookie', cookie(login));
  assert.equal(afterLogout.status, 401);
  assert.equal((await http.post('/api/auth/logout').set('Host', 'miu.test').set('Origin', origin)).status, 204);
  assert.equal(observed.length, 1);
});

test('offline auth HTTP: absent, invalid, duplicate, and bearer-only account credentials do not authenticate', async () => {
  const { http, store } = fixture();
  const session = await store.login('sam', '1');
  for (const header of ['', 'other=present', 'miu_auth=missing-token', 'miu_auth=%broken', `miu_auth=${session.token}; miu_auth=another-token`]) {
    const result = await http.get('/api/auth/me').set('Host', 'miu.test').set('Cookie', header);
    assert.equal(result.status, 401, header);
  }
  const bearerOnly = await http.get('/api/auth/me').set('Host', 'miu.test').set('Authorization', `Bearer ${session.token}`);
  assert.equal(bearerOnly.status, 401);
  assert.equal(requestAuthToken({ headers: { cookie: `other=value; miu_auth=${session.token}` } }), session.token);
  assert.deepEqual(await authenticateRequest({ headers: { cookie: `miu_auth=${session.token}` } }, store), store.user);
});

test('offline auth HTTP: login and registration share the 20-attempt IP budget', async () => {
  const { http, store } = fixture();
  for (let i = 0; i < 10; i++) {
    const response = await http.post('/api/auth/register').set('Host', 'miu.test').set('Origin', origin).send({ username: `family_${i}`, password: 'a-long-password' });
    assert.equal(response.status, 201);
  }
  for (let i = 0; i < 10; i++) {
    const response = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: `missing_${i}`, password: 'wrong' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'invalid_credentials');
    assert.doesNotMatch(JSON.stringify(response.body), /must-not-expose|password.hash/u);
  }
  const limited = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).send({ username: 'sam', password: '1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'auth_rate_limited');
  assert.equal(limited.headers['cache-control'], 'no-store');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(store.loginCalls, 10);
});

test('offline auth HTTP: ten failed username attempts apply across IPs and normalized username casing', async () => {
  const { http, store } = fixture();
  for (let i = 0; i < 10; i++) {
    const response = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).set('X-Forwarded-For', `198.51.100.${i + 1}`).send({ username: i % 2 ? ' SAM ' : 'sam', password: 'wrong' });
    assert.equal(response.status, 401);
  }
  const limited = await http.post('/api/auth/login').set('Host', 'miu.test').set('Origin', origin).set('X-Forwarded-For', '198.51.100.99').send({ username: 'sam', password: '1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'auth_rate_limited');
  assert.equal(store.loginCalls, 10);
});
