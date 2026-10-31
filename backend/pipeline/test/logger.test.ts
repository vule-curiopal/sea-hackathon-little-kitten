import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, errorFields } from '../src/logger.js';
import { PipelineError } from '../src/errors.js';
import { createTestApp, type TestApp } from './http-test-app.js';

const apps: TestApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.runtime.close())); });

describe('diagnostic metadata boundary (offline harness)', () => {
  it('keeps correlation and metrics but drops bodies, credentials and raw error messages', () => {
    const lines: string[] = [];
    const log = createLogger(line => lines.push(line));
    const id = randomUUID();
    log('speech.failed', { turn_id: id, code: 'provider_unavailable', duration_ms: 123.4,
      transcript: 'Private words', audio: 'base64data', token: 'private-token', message: 'private diagnostic',
      headers: { Authorization: 'Bearer private-token' }, bytes: -1, session_id: 'private-token' });
    expect(JSON.parse(lines[0])).toEqual({ time: expect.any(String), level: 'warn', service: 'miu-voice',
      event: 'speech.failed', turn_id: id, code: 'provider_unavailable', duration_ms: 123 });
    expect(errorFields(new Error('private provider response'))).toEqual({ code: 'internal_error' });
    expect(errorFields(new PipelineError('unclear_audio', 422))).toEqual({ code: 'unclear_audio', status: 422 });
    expect(() => createLogger(() => { throw new Error('disk failure'); })('turn.started')).not.toThrow();
  });

  it('authenticates client diagnostics, limits volume and rejects arbitrary payloads', async () => {
    const app = await createTestApp(); apps.push(app);
    const session = (await app.http.post('/api/sessions').send({ demo_profile_key: 'an', request_id: randomUUID() })).body;
    const body = { session_id: session.session_id, code: 'MIC_PERMISSION_DENIED' };
    expect((await app.http.post('/api/client-events').send(body)).status).toBe(401);
    const post = (payload = body) => app.http.post('/api/client-events').set('Authorization', `Bearer ${session.demo_token}`).send(payload);
    expect((await post({ ...body, transcript: 'private words' } as typeof body)).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(429);
  });
});
