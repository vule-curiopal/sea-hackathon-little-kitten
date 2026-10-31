import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@miu/voice-contracts';
import { loadConfig } from '../src/config.js';
import type { PipelineProviders } from '../src/ports.js';
import { createTestApp, type TestApp } from './http-test-app.js';

const applications: TestApp[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.runtime.close())); });
const boundary = 'miu-multipart-limit-test';
const contentType = `multipart/form-data; boundary=${boundary}`;
interface Session { session_id: string; demo_token: string }

function multipartPrefix(id: string): Buffer {
  const fields = { request_id: id, kind: 'utterance', fixture_id: 'voice_sample_vi' };
  return Buffer.from(Object.entries(fields).map(([key, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
  ).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
}
function body(sample: Buffer, id: string, preamble = 0, epilogue = 0): Buffer {
  return Buffer.concat([
    Buffer.from('P'.repeat(preamble) + (preamble ? '\r\n' : '')),
    multipartPrefix(id), sample, Buffer.from(`\r\n--${boundary}--\r\n`), Buffer.alloc(epilogue, 'E'),
  ]);
}
async function server() {
  const sample = await readFile(new URL('../fixtures/vi.wav', import.meta.url));
  const consumed = vi.fn<PipelineProviders['transcribe']>(async (_audio, language) => ({ text: 'Xin chào.', language }));
  const providers: PipelineProviders = {
    mode: 'fake', transcribe: consumed,
    response: { generate: vi.fn(async input => ({ turnId: input.turnId, replyText: 'Chào bạn!', language: input.language })) },
    synthesize: vi.fn(async () => ({ bytes: sample, mimeType: 'audio/wav', durationMs: 3680 })),
  };
  const app = await createTestApp({ config: loadConfig({}), providers });
  applications.push(app);
  const created = await app.http.post('/api/sessions').send({ demo_profile_key: 'an', request_id: randomUUID() });
  expect(created.status).toBe(200);
  return { app, consumed, sample, session: created.body as Session };
}
interface WireResponse { status: number; json: Record<string, any> }
function uploadUrl(app: TestApp, session: Session): URL {
  return new URL(`/api/sessions/${session.session_id}/turns`, app.baseUrl);
}
async function chunked(app: TestApp, session: Session, chunks: Buffer[]): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseReceived = false;
    const req = httpRequest(uploadUrl(app, session), {
      method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${session.demo_token}` },
    });
    req.on('error', error => { if (!settled && !responseReceived) { settled = true; reject(error); } });
    req.on('response', response => {
      responseReceived = true;
      const output: Buffer[] = [];
      response.on('data', chunk => output.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          settled = true;
          resolve({ status: response.statusCode!, json: JSON.parse(Buffer.concat(output).toString()) });
        } catch (error) { reject(error); }
      });
    });
    // No Content-Length: transfer encoding is genuinely chunked over TCP.
    void (async () => {
      for (const chunk of chunks) {
        if (req.destroyed || settled) return;
        req.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!req.destroyed && !settled) req.end();
    })().catch(reject);
  });
}
async function oversizedHeaders(app: TestApp, session: Session): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(uploadUrl(app, session), {
      method: 'POST', headers: {
        'content-type': contentType, authorization: `Bearer ${session.demo_token}`,
        'content-length': String(LIMITS.requestBytes + 1),
      },
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Server waited for oversized request body')); }, 2000);
    req.on('error', error => { if (!settled) { clearTimeout(timer); reject(error); } });
    req.on('response', response => {
      const output: Buffer[] = [];
      response.on('data', chunk => output.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        settled = true;
        clearTimeout(timer);
        try { resolve({ status: response.statusCode!, json: JSON.parse(Buffer.concat(output).toString()) }); }
        catch (error) { reject(error); }
        req.destroy();
      });
    });
    // Deliberately send no body or end event: Content-Length must be rejected early.
    req.flushHeaders();
  });
}

describe('whole multipart request limit through Express and real TCP', () => {
  it('keeps original WAV bytes across delayed chunks and accepts preamble/epilogue under the limit', async () => {
    const { app, consumed, sample, session } = await server();
    const payload = body(sample, randomUUID(), 50, 50);
    const response = await chunked(app, session, [payload.subarray(0, 80), payload.subarray(80, 150), payload.subarray(150)]);
    expect(response.status).toBe(200);
    expect(response.json.audio.mime_type).toBe('audio/wav');
    expect(consumed).toHaveBeenCalledOnce();
    expect(consumed.mock.calls[0]![0].bytes).toEqual(sample);
  });

  it('rejects oversized Content-Length before any body or multipart processing', async () => {
    const { app, consumed, session } = await server();
    const response = await oversizedHeaders(app, session);
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe('recording_too_large');
    expect(consumed).not.toHaveBeenCalled();
  });

  it('counts chunked preamble past 6MiB and fails before calling providers', async () => {
    const { app, consumed, sample, session } = await server();
    const padding = Buffer.alloc(LIMITS.requestBytes / 2 + 1, 'P');
    const response = await chunked(app, session, [padding, padding, body(sample, randomUUID())]);
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe('recording_too_large');
    expect(consumed).not.toHaveBeenCalled();
  });

  it('counts chunked epilogue after an otherwise valid file', async () => {
    const { app, consumed, sample, session } = await server();
    const padding = Buffer.alloc(LIMITS.requestBytes / 2, 'E');
    const response = await chunked(app, session, [body(sample, randomUUID()), padding, padding]);
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe('recording_too_large');
    expect(consumed).not.toHaveBeenCalled();
  });

  it('returns a bounded 413 when an oversized chunked sender never ends the body', async () => {
    const { app, consumed, session } = await server();
    const response = await new Promise<WireResponse>((resolve, reject) => {
      let settled = false;
      let responseReceived = false;
      const req = httpRequest(uploadUrl(app, session), {
        method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${session.demo_token}` },
      });
      const timer = setTimeout(() => {
        settled = true;
        req.destroy();
        reject(new Error('Oversized chunked upload waited indefinitely for end'));
      }, 2000);
      req.on('error', error => {
        if (!settled && !responseReceived) { clearTimeout(timer); reject(error); }
      });
      req.on('response', incoming => {
        responseReceived = true;
        const output: Buffer[] = [];
        incoming.on('data', chunk => output.push(chunk));
        incoming.on('error', error => { clearTimeout(timer); reject(error); });
        incoming.on('end', () => {
          settled = true;
          clearTimeout(timer);
          try { resolve({ status: incoming.statusCode!, json: JSON.parse(Buffer.concat(output).toString()) }); }
          catch (error) { reject(error); }
          req.destroy();
        });
      });
      // No Content-Length, terminating chunk, req.end(), or later data event.
      req.write(Buffer.alloc(LIMITS.requestBytes + 1, 'P'));
    });
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe('recording_too_large');
    expect(consumed).not.toHaveBeenCalled();
  });

  it('leaves canonical JSON session bodies parseable alongside multipart requests', async () => {
    const { app } = await server();
    const response = await app.http.post('/api/sessions').send({ demo_profile_key: 'binh', request_id: randomUUID() });
    expect(response.status).toBe(200);
    expect(response.body.session_id).toEqual(expect.any(String));
    expect(response.body.demo_token).toEqual(expect.any(String));
    expect(response.body.configuration.language_mode).toBe('vi');
  });

  it('ends an aborted chunked input without invoking providers or damaging the server', async () => {
    const { app, consumed, session } = await server();
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(uploadUrl(app, session), {
        method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${session.demo_token}` },
      });
      req.once('close', () => resolve());
      req.on('error', () => resolve()); // The intentional client disconnect has no HTTP response to inspect.
      req.on('response', response => { response.resume(); reject(new Error('Incomplete multipart unexpectedly completed')); });
      req.write(multipartPrefix(randomUUID()), () => { setTimeout(() => req.destroy(), 10); });
    });
    await vi.waitFor(async () => {
      const panel = await app.http.get('/api/demo/panel').set('authorization', `Bearer ${session.demo_token}`);
      expect(panel.status).toBe(200);
      expect(panel.body.active_turn).toBeNull();
    });
    expect(consumed).not.toHaveBeenCalled();
    expect((await app.http.get('/api/health')).status).toBe(200);
  });
});
