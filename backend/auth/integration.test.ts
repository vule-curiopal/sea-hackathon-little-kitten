import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { createIntegratedApp } from '../integration/server.js';
import { createMemoryStore } from '../memory/index.js';
import { OpenAIProvider } from '../pipeline/providers.js';

// Offline authentication/transport/lifecycle checks only. The actual real-mode
// adapter is constructed with unusable placeholder credentials, but no turns,
// model evaluations, audio capture, synthesis, or outbound requests are allowed.
const host = 'miu.test';
const origin = `http://${host}`;
const password = 'offline protocol password';
const marker = 'paper folding';
function cookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  assert.equal(typeof first, 'string');
  return String(first).split(';')[0]!;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'miu-auth-integration-'));
  const dataDir = join(directory, 'database');
  let integrated: Awaited<ReturnType<typeof createIntegratedApp>> | undefined;
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    outbound++;
    throw new Error('offline_auth_outbound_forbidden');
  });
  t.after(async () => {
    try {
      assert.equal(outbound, 0, 'Authentication and lifecycle operations must not issue provider requests.');
      if (integrated) {
        const provider = integrated.bridge.application.provider;
        assert.ok(provider instanceof OpenAIProvider);
        assert.equal(provider.mode, 'real');
        assert.equal(provider.telemetry.length, 0);
      }
    } finally {
      await integrated?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  // Persist a literal storage-contract fixture before integrated startup, so
  // seeding must retain an existing profile rather than silently replacing it.
  const memory = await createMemoryStore({ dataDir });
  let anId: string;
  try {
    const an = await memory.createProfile({ demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'vi', timezone: 'Asia/Ho_Chi_Minh' });
    anId = an.id;
    const context = await memory.getContext(an.id);
    await memory.learn({
      profileId: an.id, turnId: randomUUID(), deletionEpoch: context.profile.deletionEpoch, localDate: context.clock.localDate,
      sourceText: 'I like paper folding.', candidates: [{ kind: 'preference', category: 'like', value: marker, evidence: 'I like paper folding.' }],
    });
  } finally { await memory.db.close(); }
  integrated = await createIntegratedApp({
    HOST: '127.0.0.1', DEMO_MODE: 'true', MIU_SEED_TEST_USER: 'true', DATABASE_SSH_TUNNEL: 'false',
    MIU_DATA_DIR: dataDir, MIU_FRONTEND_DIR: join(directory, 'no-frontend'), ALLOWED_ORIGINS: origin,
    OPENAI_API_KEY: 'offline-auth-protocol-placeholder-unused', ELEVENLABS_API_KEY: 'offline-auth-protocol-placeholder-unused',
    STT_LOGGING: '0',
  });
  const http = supertest(integrated.app);
  const session = (authCookie: string | null, selector = 'account') => {
    const request = http.post('/api/sessions').set('Host', host).set('Origin', origin);
    if (authCookie) request.set('Cookie', authCookie);
    return request.send({ request_id: randomUUID(), demo_profile_key: selector });
  };
  const panel = (token: string, authCookie?: string) => {
    const request = http.get('/api/demo/panel').set('Host', host).set('Authorization', `Bearer ${token}`);
    if (authCookie) request.set('Cookie', authCookie);
    return request;
  };
  const register = (username: string) => http.post('/api/auth/register').set('Host', host).set('Origin', origin).send({ username, password });
  return { integrated, http, anId, session, panel, register };
}

test('offline integrated auth: sam/1 opens the existing An profile and retains its saved test data', async t => {
  const h = await fixture(t);
  const login = await h.http.post('/api/auth/login').set('Host', host).set('Origin', origin).send({ username: 'sam', password: '1' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, 'sam');
  assert.equal(login.body.user.profile_key, 'an');
  const opened = await h.session(cookie(login));
  assert.equal(opened.status, 200);
  assert.equal(opened.body.provider_mode, 'real');
  assert.equal(opened.body.engine_mode, 'character_memory');
  const panel = await h.panel(opened.body.demo_token, cookie(login));
  assert.equal(panel.status, 200);
  assert.equal(panel.body.context.profile.id, h.anId);
  assert.equal(panel.body.context.profile.demoKey, 'an');
  assert.ok(panel.body.context.preferences.some((preference: { value: string }) => preference.value === marker));
});

test('offline integrated auth: account sessions and configuration remain bound to their owner', async t => {
  const h = await fixture(t);
  const registeredA = await h.register('protocol_user_a');
  const registeredB = await h.register('protocol_user_b');
  assert.equal(registeredA.status, 201);
  assert.equal(registeredB.status, 201);
  const cookieA = cookie(registeredA); const cookieB = cookie(registeredB);
  assert.notEqual(registeredA.body.user.profile_key, registeredB.body.user.profile_key);
  const openedA = await h.session(cookieA); const openedB = await h.session(cookieB);
  assert.equal(openedA.status, 200); assert.equal(openedB.status, 200);
  const tokenA = openedA.body.demo_token as string; const tokenB = openedB.body.demo_token as string;
  const beforeA = await h.panel(tokenA, cookieA); const beforeB = await h.panel(tokenB, cookieB);
  assert.equal(beforeA.status, 200); assert.equal(beforeB.status, 200);
  assert.notEqual(beforeA.body.context.profile.id, beforeB.body.context.profile.id);
  assert.notEqual(beforeA.body.context.profile.id, h.anId);
  assert.equal(beforeA.body.context.profile.demoKey, registeredA.body.user.profile_key);
  assert.equal(beforeB.body.context.profile.demoKey, registeredB.body.user.profile_key);
  const configured = await h.http.patch('/api/profiles/current/config').set('Host', host).set('Origin', origin)
    .set('Cookie', cookieA).set('Authorization', `Bearer ${tokenA}`).send({ request_id: randomUUID(), personality: 'ISTJ', role: 'teacher' });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.configuration.personality, 'ISTJ');
  const afterA = await h.panel(tokenA, cookieA); const afterB = await h.panel(tokenB, cookieB);
  assert.equal(afterA.body.context.config.personality, 'ISTJ');
  assert.equal(afterA.body.context.config.role, 'teacher');
  assert.equal(afterB.body.context.config.personality, beforeB.body.context.config.personality);
  assert.equal(afterB.body.context.config.role, beforeB.body.context.config.role);
  const foreign = await h.panel(tokenB, cookieA);
  assert.equal(foreign.status, 403); assert.equal(foreign.body.error.code, 'forbidden');
  const bearerOnly = await h.panel(tokenA);
  assert.equal(bearerOnly.status, 401); assert.equal(bearerOnly.body.error.code, 'unauthorized');
  for (const path of ['/api/DEMO/PANEL', '/api/demo/panel/']) {
    const foreignAlias = await h.http.get(path).set('Host', host).set('Cookie', cookieA).set('Authorization', `Bearer ${tokenB}`);
    assert.equal(foreignAlias.status, 403, path);
    assert.equal(foreignAlias.body.error.code, 'forbidden', path);
    const bearerOnlyAlias = await h.http.get(path).set('Host', host).set('Authorization', `Bearer ${tokenA}`);
    assert.equal(bearerOnlyAlias.status, 401, path);
    assert.equal(bearerOnlyAlias.body.error.code, 'unauthorized', path);
  }
  const foreignConfigAlias = await h.http.patch('/api/PROFILES/CURRENT/CONFIG/').set('Host', host).set('Origin', origin)
    .set('Cookie', cookieA).set('Authorization', `Bearer ${tokenB}`).send({ request_id: randomUUID(), role: 'teacher' });
  assert.equal(foreignConfigAlias.status, 403);
  assert.equal(foreignConfigAlias.body.error.code, 'forbidden');
  const chosenOwner = await h.session(cookieA, registeredB.body.user.profile_key);
  assert.equal(chosenOwner.status, 400);
  assert.equal(chosenOwner.body.error.code, 'invalid_demo_profile');
  const siblingOrigin = await h.http.post('/api/sessions').set('Host', host).set('Origin', 'http://evil.miu.test')
    .set('Sec-Fetch-Site', 'same-site').set('Cookie', cookieA).send({ request_id: randomUUID(), demo_profile_key: 'account' });
  assert.equal(siblingOrigin.status, 403);
  assert.equal(siblingOrigin.body.error.code, 'auth_origin_forbidden');
  const existingSession = await h.panel(tokenA, cookieA);
  assert.equal(existingSession.status, 200, 'Rejected sibling-origin session creation cannot replace or close the owned session.');
  assert.equal(existingSession.body.context.profile.id, beforeA.body.context.profile.id);
  const closed = await h.http.delete(`/api/sessions/${openedA.body.session_id}`).set('Host', host)
    .set('Cookie', cookieA).set('Authorization', `Bearer ${tokenA}`);
  assert.equal(closed.status, 200);
  const signedInAgain = await h.http.post('/api/auth/login').set('Host', host).set('Origin', origin)
    .send({ username: 'protocol_user_a', password });
  assert.equal(signedInAgain.status, 200);
  const reopened = await h.session(cookie(signedInAgain));
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.configuration.personality, 'ISTJ');
  assert.equal(reopened.body.configuration.role, 'teacher');
});

test('offline integrated auth: logout invalidates the old cookie even when its engine bearer is retained', async t => {
  const h = await fixture(t);
  const registered = await h.register('logout_protocol_user');
  assert.equal(registered.status, 201);
  const authCookie = cookie(registered);
  const opened = await h.session(authCookie);
  assert.equal(opened.status, 200);
  const token = opened.body.demo_token as string;
  assert.equal((await h.panel(token, authCookie)).status, 200);
  const logout = await h.http.post('/api/auth/logout').set('Host', host).set('Origin', origin).set('Cookie', authCookie);
  assert.equal(logout.status, 204);
  const me = await h.http.get('/api/auth/me').set('Host', host).set('Cookie', authCookie);
  assert.equal(me.status, 401);
  const oldBearer = await h.panel(token, authCookie);
  assert.equal(oldBearer.status, 401);
  assert.equal(oldBearer.body.error.code, 'unauthorized');
  assert.equal((await h.session(authCookie)).status, 401);
  const close = await h.http.delete(`/api/sessions/${opened.body.session_id}`).set('Host', host)
    .set('Cookie', authCookie).set('Authorization', `Bearer ${token}`);
  assert.equal(close.status, 401);
});

test('offline integrated auth: anonymous legacy demo selectors create separate guests without Sam data', async t => {
  const h = await fixture(t);
  const login = await h.http.post('/api/auth/login').set('Host', host).set('Origin', origin).send({ username: 'sam', password: '1' });
  assert.equal(login.status, 200);
  const sam = await h.session(cookie(login));
  assert.equal(sam.status, 200);
  const samPanel = await h.panel(sam.body.demo_token, cookie(login));
  assert.equal(samPanel.body.context.profile.id, h.anId);
  const ids = new Set<string>([h.anId]);
  for (const selector of ['an', 'binh', 'guest']) {
    const opened = await h.session(null, selector);
    assert.equal(opened.status, 200, selector);
    const guest = await h.panel(opened.body.demo_token);
    assert.equal(guest.status, 200, selector);
    assert.match(guest.body.context.profile.demoKey, /^guest_[0-9a-f-]{36}$/u);
    assert.equal(ids.has(guest.body.context.profile.id), false, selector);
    ids.add(guest.body.context.profile.id);
    assert.equal(guest.body.context.preferences.some((preference: { value: string }) => preference.value === marker), false, selector);
    const closed = await h.http.delete(`/api/sessions/${opened.body.session_id}`).set('Host', host)
      .set('Authorization', `Bearer ${opened.body.demo_token}`);
    assert.equal(closed.status, 200, selector);
    const remaining = await h.integrated.bridge.application.memory.db.query('SELECT id FROM profiles WHERE id=$1', [guest.body.context.profile.id]);
    assert.equal(remaining.rows.length, 0, 'Closing a guest removes only its ephemeral profile.');
    assert.equal((await h.panel(opened.body.demo_token)).status, 401, 'Closed guest bearer must be retired.');
  }
  const samStillOwned = await h.panel(sam.body.demo_token, cookie(login));
  assert.equal(samStillOwned.status, 200, 'Anonymous demos must not close Sam’s distinct account session.');
  assert.equal(samStillOwned.body.context.profile.id, h.anId);
  assert.equal((await h.session(null, 'account')).status, 401);
});
