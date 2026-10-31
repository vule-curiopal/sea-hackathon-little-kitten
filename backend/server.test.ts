import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createEngineServer, startEngineServer } from './server.js';
import { MiuApplication, type TurnResponse } from './application.js';
import { createMemoryStore, type MemoryStore } from './memory/index.js';
import { FakeProvider } from './pipeline/providers.js';
import { AppError } from './shared/types.js';
import type { MemoryContext } from './shared/types.js';

interface Opened { session_id: string; demo_token: string; context: MemoryContext; capabilities: { text: boolean; audio: boolean } }

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}
async function closeServer(server: Server) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

// Real HTTP exercises body framing, bearer scope, transport validation and
// serial lifecycle while PGlite executes the actual PostgreSQL migrations.
describe('localhost text engine API', () => {
  let memory: MemoryStore;
  let app: MiuApplication;
  let server: Server;
  let base: string;
  before(async () => {
    memory = await createMemoryStore({ now: () => new Date('2026-10-31T02:00:00Z') });
    app = new MiuApplication(memory, new FakeProvider());
    server = createEngineServer(app, { sweepIntervalMs: 1_000 });
    base = await listen(server);
  });
  after(async () => { await closeServer(server); await app.close(); });
  const call = async (path: string, method = 'GET', body?: unknown, bearer?: string) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
  };
  const open = async (demo_profile_key = 'an') => {
    const response = await call('/api/engine/sessions', 'POST', { demo_profile_key });
    assert.equal(response.status, 201);
    return response.body as unknown as Opened;
  };
  const receipt = (opened: Opened, turn: TurnResponse, status: 'started' | 'completed') => call('/api/engine/sessions/' + opened.session_id + '/turns/' + turn.turn_id + '/playback', 'POST', { request_id: randomUUID(), status, state_version: turn.state_version }, opened.demo_token);

  test('health states text-only capabilities and never exposes credentials', async () => {
    const result = await call('/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.capabilities, { text: true, audio: false });
    assert.equal(result.body.provider_mode, 'fake');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.body.OPENAI_API_KEY, undefined);
    assert.equal((await call('/api/sessions', 'POST', {})).status, 404);
  });

  test('fictional bootstrap rejects arbitrary profile registration and unknown fields', async () => {
    assert.equal((await call('/api/engine/sessions', 'POST', { demo_profile_key: 'someone-else' })).status, 400);
    assert.equal((await call('/api/engine/sessions', 'POST', { demo_profile_key: 'an', age: 7 })).status, 400);
    const opened = await open();
    assert.ok(opened.demo_token);
    assert.equal(opened.capabilities.audio, false);
    assert.equal(opened.context.profile.demoKey, 'an');
  });

  test('profile reads require server-issued bearer tokens', async () => {
    assert.equal((await call('/api/engine/profile')).status, 401);
    assert.equal((await call('/api/engine/profile', 'GET', undefined, randomUUID())).status, 401);
    const opened = await open();
    const profile = await call('/api/engine/profile', 'GET', undefined, opened.demo_token);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.id, opened.context.profile.id);
    assert.equal(profile.body.history, undefined);
  });

  test('turn validation blocks cross-profile sessions, invalid UUIDs and unknown fields', async () => {
    const an = await open();
    const binh = await open('binh');
    const path = '/api/engine/sessions/' + an.session_id + '/turns';
    assert.equal((await call(path, 'POST', { request_id: randomUUID(), kind: 'utterance', text: 'Hello' }, binh.demo_token)).status, 404);
    assert.equal((await call(path, 'POST', { request_id: 'bad', kind: 'utterance', text: 'Hello' }, an.demo_token)).status, 400);
    assert.equal((await call(path, 'POST', { request_id: randomUUID(), kind: 'utterance', text: 'Hello', profile_id: binh.context.profile.id }, an.demo_token)).status, 400);
    assert.equal((await call(path, 'POST', { request_id: randomUUID(), kind: 'greeting', text: 'injected words' }, an.demo_token)).status, 400);
    assert.equal((await call(path, 'POST', { request_id: randomUUID(), kind: 'utterance' }, an.demo_token)).status, 400);
  });

  test('body framing rejects unsupported media, invalid JSON and oversize payloads', async () => {
    for (const [contentType, text, expected] of [
      ['text/plain', '{}', 415],
      ['application/json', '{invalid', 400],
      ['application/json', JSON.stringify({ text: 'x'.repeat(17_000) }), 413],
    ] as const) {
      const response = await fetch(base + '/api/engine/sessions', { method: 'POST', headers: { 'content-type': contentType }, body: text });
      assert.equal(response.status, expected);
      const error = await response.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(error), ['error']);
    }
  });

  test('a completed text turn learns once and cannot expose the other profile', async () => {
    const an = await open();
    const request = { request_id: randomUUID(), kind: 'utterance', text: 'My dog Mochi fell in a puddle.' };
    const turnPath = '/api/engine/sessions/' + an.session_id + '/turns';
    const response = await call(turnPath, 'POST', request, an.demo_token);
    assert.equal(response.status, 200);
    const turn = response.body as unknown as TurnResponse;
    assert.equal(turn.input_mode, 'text');
    assert.equal((await call('/api/engine/profile', 'GET', undefined, an.demo_token)).body.entities.length, 0);
    assert.equal((await receipt(an, turn, 'started')).status, 200);
    assert.equal((await receipt(an, turn, 'completed')).status, 200);
    assert.equal((await receipt(an, turn, 'completed')).status, 200);
    const learned = await call('/api/engine/profile', 'GET', undefined, an.demo_token);
    assert.equal(learned.body.entities.filter((entity: { name: string }) => entity.name === 'Mochi').length, 1);
    const binh = await open('binh');
    const isolated = await call('/api/engine/profile', 'GET', undefined, binh.demo_token);
    assert.equal(isolated.body.entities.some((entity: { name: string }) => entity.name === 'Mochi'), false);
  });

  test('configuration accepts only style fields and deduplicates concurrent request IDs', async () => {
    const opened = await open();
    const bad = await call('/api/engine/config', 'PATCH', { personality: 'ENFP', safety: false }, opened.demo_token);
    assert.equal(bad.status, 400);
    const body = { request_id: randomUUID(), personality: 'ISTJ', language_mode: 'vi' };
    const [first, repeated] = await Promise.all([
      call('/api/engine/config', 'PATCH', body, opened.demo_token),
      call('/api/engine/config', 'PATCH', body, opened.demo_token),
    ]);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, repeated.body);
    assert.equal(first.body.config.personality, 'ISTJ');
    assert.equal(first.body.language_mode, 'vi');
    assert.equal(first.body.entities, undefined);
    assert.equal((await call('/api/engine/config', 'PATCH', { ...body, personality: 'ENFP' }, opened.demo_token)).status, 409);
    assert.equal((await call('/api/engine/config', 'PATCH', {}, opened.demo_token)).status, 400);
  });

  test('Next day rejects an active turn, advances after completion and is idempotent', async () => {
    const opened = await open();
    const turnReply = await call('/api/engine/sessions/' + opened.session_id + '/turns', 'POST', { request_id: randomUUID(), kind: 'utterance', text: 'Hello' }, opened.demo_token);
    const turn = turnReply.body as unknown as TurnResponse;
    const body = { request_id: randomUUID(), expected_clock_version: opened.context.clock.version };
    assert.equal((await call('/api/engine/next-day', 'POST', body, opened.demo_token)).status, 409);
    await receipt(opened, turn, 'started');
    await receipt(opened, turn, 'completed');
    const first = await call('/api/engine/next-day', 'POST', body, opened.demo_token);
    const repeated = await call('/api/engine/next-day', 'POST', body, opened.demo_token);
    assert.equal(first.status, 200);
    assert.equal(repeated.status, 200);
    assert.equal(first.body.clock.localDate, '2026-11-01');
    assert.equal(first.body.clock.version, repeated.body.clock.version);
  });

  test('cancellation and closing use the same authenticated session boundary', async () => {
    const opened = await open();
    const turnId = randomUUID();
    await call('/api/engine/sessions/' + opened.session_id + '/turns', 'POST', { request_id: turnId, kind: 'utterance', text: 'My friend is Unheard.' }, opened.demo_token);
    const result = await call('/api/engine/sessions/' + opened.session_id + '/turns/' + turnId, 'DELETE', undefined, opened.demo_token);
    assert.equal(result.status, 200);
    assert.equal(result.body.canceled, true);
    assert.equal((await call('/api/engine/sessions/' + opened.session_id, 'DELETE', undefined, opened.demo_token)).status, 200);
    assert.equal((await call('/api/engine/sessions/' + opened.session_id + '/turns', 'POST', { request_id: randomUUID(), kind: 'greeting' }, opened.demo_token)).status, 409);
  });

  test('internal errors expose no raw error message, stack or provider output', async () => {
    const opened = await open();
    const original = app.getContext.bind(app);
    app.getContext = async () => { throw new Error('sensitive SQL and provider output'); };
    try {
      const result = await call('/api/engine/profile', 'GET', undefined, opened.demo_token);
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: { code: 'internal_error' } });
    } finally { app.getContext = original; }
  });

  test('committed deletion invalidation survives a subsequent validation error', async () => {
    const opened = await open();
    const original = app.prepareTurn.bind(app);
    app.prepareTurn = async () => {
      const error = new AppError('validation_failed', 503, 'private provider refusal');
      error.invalidation = { state_version: 9, clock_version: 2, memory: { invalidate_replay: true } };
      throw error;
    };
    try {
      const response = await call('/api/engine/sessions/' + opened.session_id + '/turns', 'POST', { request_id: randomUUID(), kind: 'utterance', text: 'forget that' }, opened.demo_token);
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, { error: { code: 'validation_failed' }, state_version: 9, clock_version: 2, memory: { invalidate_replay: true } });
    } finally { app.prepareTurn = original; }
  });

  test('disabled demo server hides bootstrap and profile routes', async () => {
    const disabled = createEngineServer(app, { demoMode: false });
    const disabledBase = await listen(disabled);
    try {
      assert.equal((await fetch(disabledBase + '/health')).status, 200);
      assert.equal((await fetch(disabledBase + '/api/engine/profile')).status, 404);
      assert.equal((await fetch(disabledBase + '/api/engine/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"demo_profile_key":"an"}' })).status, 404);
    } finally { await closeServer(disabled); }
  });
});

test('standalone configuration fails before opening storage for disabled or public demo hosting', async () => {
  await assert.rejects(() => startEngineServer({ DEMO_MODE: 'false' }), /demo_mode_required/);
  await assert.rejects(() => startEngineServer({ HOST: '0.0.0.0' }), /loopback_host_required/);
});


test('idle server maintenance advances fictional growth daily without a conversation', async () => {
  let now = Date.parse('2026-10-31T02:00:00Z');
  const memory = await createMemoryStore({ now: () => new Date(now), clockMode: 'real' });
  const app = new MiuApplication(memory, new FakeProvider(), () => now);
  await app.bootstrap();
  const profile = (await memory.findProfile('an'))!;
  const original = await memory.getContext(profile.id);
  let completedTick: () => void = () => {};
  const tick = new Promise<void>(resolve => { completedTick = resolve; });
  const maintain = app.maintain.bind(app);
  app.maintain = async () => { await maintain(); completedTick(); };
  const server = createEngineServer(app, { sweepIntervalMs: 10 });
  await listen(server);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    now += 86_400_000;
    await Promise.race([tick, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('maintenance did not run')), 2_000); })]);
    const next = await memory.getContext(profile.id);
    assert.equal(next.daily.localDate, '2026-11-01');
    assert.equal(next.daily.growthDays, original.daily.growthDays + 1);
    await maintain();
    await maintain();
    const repeated = await memory.getContext(profile.id);
    assert.deepEqual(repeated.daily, next.daily);
  } finally {
    if (timeout) clearTimeout(timeout);
    await closeServer(server);
    await app.close();
  }
});
