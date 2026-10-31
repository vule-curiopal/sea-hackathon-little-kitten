import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { PipelineError } from '../src/errors.js';
import type { PipelineProviders } from '../src/ports.js';
import { createTestApp, type TestApp } from './http-test-app.js';

const apps: TestApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.runtime.close())); });

async function setup(overrides: Partial<PipelineProviders> = {}, timeout = 1000) {
  const sample = await readFile(new URL('../fixtures/en.wav', import.meta.url));
  const providers: PipelineProviders = {
    mode: 'fake',
    transcribe: vi.fn(async (_audio, language) => ({ text: language === 'vi' ? 'Xin chào' : 'Hello', language })),
    response: {
      generate: vi.fn(async input => ({ turnId: input.turnId, replyText: input.language === 'vi' ? 'Chào bạn!' : 'Hello friend!', language: input.language })),
    },
    synthesize: vi.fn(async () => ({ bytes: sample, mimeType: 'audio/wav', durationMs: 3400 })),
    ...overrides,
  };
  const config = loadConfig({});
  config.turnTimeoutMs = timeout;
  const app = await createTestApp({ config, providers });
  apps.push(app);
  const create = await app.http.post('/api/sessions').send({ demo_profile_key: 'an', request_id: randomUUID() });
  expect(create.status).toBe(200);
  return { app, providers, session: create.body, sample };
}

function multipart(id: string, bytes: Buffer, extra: Record<string, string> = {}) {
  const boundary = 'miu-test-boundary';
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries({ request_id: id, kind: 'utterance', fixture_id: 'voice_sample_vi', ...extra })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function submit(app: TestApp, session: { session_id: string; demo_token: string }, body: ReturnType<typeof multipart>) {
  return app.http.post(`/api/sessions/${session.session_id}/turns`)
    .set('authorization', `Bearer ${session.demo_token}`)
    .set('content-type', body.contentType)
    .send(body.payload);
}

describe('canonical batch Express HTTP API', () => {
  it('returns voice-stub envelope, no memory; a same-body retry does not call providers twice', async () => {
    const { app, providers, session, sample } = await setup();
    const id = randomUUID();
    const body = multipart(id, sample);
    const first = await submit(app, session, body);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toMatchObject({ turn_id: id, engine_mode: 'voice_stub', memory: null, face: null, presentation: null, audio: { mime_type: 'audio/wav' } });
    expect((await submit(app, session, body)).body).toEqual(first.body);
    expect(providers.transcribe).toHaveBeenCalledTimes(1);
    expect(providers.response.generate).toHaveBeenCalledTimes(1);
    expect((await submit(app, session, multipart(id, sample, { language_hint: 'vi' }))).status).toBe(409);
    const unauthorized = await app.http.post(`/api/sessions/${session.session_id}/turns`)
      .set('content-type', body.contentType).send(body.payload);
    expect(unauthorized.status).toBe(401);
  });

  it('isolates profiles and switches voice defaults with the configured language', async () => {
    const { app, session, sample, providers } = await setup();
    const second = (await app.http.post('/api/sessions').send({ demo_profile_key: 'binh', request_id: randomUUID() })).body;
    const forbidden = await app.http.delete(`/api/sessions/${session.session_id}/turns/${randomUUID()}`)
      .set('authorization', `Bearer ${second.demo_token}`);
    expect(forbidden.status).toBe(404);
    const configured = await app.http.patch('/api/profiles/current/config')
      .set('authorization', `Bearer ${session.demo_token}`)
      .send({ request_id: randomUUID(), language_mode: 'en' });
    expect(configured.body.configuration.voice_id).toBe('fBD19tfE58bkETeiwUoC');
    const invalidRole = await app.http.patch('/api/profiles/current/config')
      .set('authorization', `Bearer ${session.demo_token}`)
      .send({ request_id: randomUUID(), role: ['teacher'] });
    expect(invalidRole.status).toBe(400);
    const result = await submit(app, session, multipart(randomUUID(), sample, { language_hint: 'en', fixture_id: 'voice_sample_en' }));
    expect(result.status).toBe(200);
    expect(providers.transcribe).toHaveBeenCalledWith(expect.anything(), 'en', expect.any(AbortSignal), 'voice_sample_en');
    expect((await submit(app, session, multipart(randomUUID(), sample, { language_hint: 'vi' }))).status).toBe(400);
  });

  it('honors cancel-before-upload tombstones without provider calls', async () => {
    const { app, providers, session, sample } = await setup();
    const id = randomUUID();
    const canceled = await app.http.delete(`/api/sessions/${session.session_id}/turns/${id}`)
      .set('authorization', `Bearer ${session.demo_token}`);
    expect(canceled.status).toBe(200);
    expect((await submit(app, session, multipart(id, sample))).body.error.code).toBe('turn_canceled');
    expect(providers.transcribe).not.toHaveBeenCalled();
  });

  it('cancels a pending provider, rejects configuration while busy and releases the lock', async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const { app, providers, session, sample } = await setup({
      transcribe: vi.fn<PipelineProviders['transcribe']>(async (_audio, _language, signal) => {
        entered();
        return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new PipelineError('turn_canceled', 409)), { once: true }));
      }),
    });
    const id = randomUUID();
    const pending = submit(app, session, multipart(id, sample));
    await ready;
    const patch = await app.http.patch('/api/profiles/current/config')
      .set('authorization', `Bearer ${session.demo_token}`)
      .send({ request_id: randomUUID(), language_mode: 'en' });
    expect(patch.status).toBe(409);
    await app.http.delete(`/api/sessions/${session.session_id}/turns/${id}`)
      .set('authorization', `Bearer ${session.demo_token}`);
    expect((await pending).status).toBe(409);
    expect(providers.response.generate).not.toHaveBeenCalled();
    const unlocked = await app.http.patch('/api/profiles/current/config')
      .set('authorization', `Bearer ${session.demo_token}`)
      .send({ request_id: randomUUID(), language_mode: 'en' });
    expect(unlocked.status).toBe(200);
  });

  it('bounds uncooperative providers by the turn deadline without exposing errors', async () => {
    const { app, session, sample } = await setup({ transcribe: vi.fn<PipelineProviders['transcribe']>(() => new Promise<never>(() => {})) }, 30);
    const result = await submit(app, session, multipart(randomUUID(), sample));
    expect(result.status).toBe(504);
    expect(result.body.error.code).toBe('provider_timeout');
  });

  it('validates audio before providers and rejects invalid generator output before TTS', async () => {
    const { app, providers, session, sample } = await setup({
      response: { generate: vi.fn(async input => ({ turnId: input.turnId, language: input.language, replyText: '[giggles] **bad**' })) },
    });
    expect((await submit(app, session, multipart(randomUUID(), Buffer.from('not audio')))).status).toBeGreaterThanOrEqual(400);
    expect(providers.transcribe).not.toHaveBeenCalled();
    expect((await submit(app, session, multipart(randomUUID(), sample))).status).toBeGreaterThanOrEqual(400);
    expect(providers.synthesize).not.toHaveBeenCalled();
  });

  it('requires actual ordered playback and disallows completed after cancellation', async () => {
    const { app, session, sample } = await setup();
    const id = randomUUID();
    const result = (await submit(app, session, multipart(id, sample))).body;
    const receipt = (status: string, played_ms: number) => app.http.post(`/api/sessions/${session.session_id}/turns/${id}/playback`)
      .set('authorization', `Bearer ${session.demo_token}`)
      .send({ request_id: randomUUID(), status, played_ms, state_version: result.state_version });
    expect((await receipt('completed', 100)).status).toBe(409);
    expect((await receipt('started', 0)).status).toBe(200);
    expect((await receipt('started', 0)).status).toBe(409);
    await app.http.delete(`/api/sessions/${session.session_id}/turns/${id}`)
      .set('authorization', `Bearer ${session.demo_token}`);
    expect((await receipt('interrupted', 100)).status).toBe(200);
    expect((await receipt('completed', 200)).status).toBe(409);
  });
});
