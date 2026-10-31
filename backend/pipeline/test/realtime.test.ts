import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { PipelineProviders } from '../src/ports.js';
import type { RealtimeSttEvent } from '../src/providers/elevenlabs/realtime-stt.provider.js';
import { createTestApp, type TestApp } from './http-test-app.js';
import { SessionService } from '../src/modules/sessions/session.service.js';
import { SpeechStreamService } from '../src/modules/speech-streams/speech-stream.service.js';
import type { TurnService } from '../src/modules/turns/turn.service.js';
import { publicSpeechError, speechClientAddress } from '../src/modules/speech-streams/speech-stream.routes.js';

class AppError extends Error {
  constructor(public code: string, public status = 400) { super('Private provider diagnostic: must not reach client'); }
}

// Offline transport/orchestration checks; doubles do not establish model or memory quality.
const apps: TestApp[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await Promise.all(apps.splice(0).map(a => a.runtime.close())); });

async function setup() {
  const sample = await readFile(new URL('../fixtures/en.wav', import.meta.url));
  let upstream!: (event: RealtimeSttEvent) => void;
  const connection = { ready: Promise.resolve(), send: vi.fn(), commit: vi.fn(), close: vi.fn() };
  const providers: PipelineProviders = {
    mode: 'real', transcribe: vi.fn(async () => { throw new Error('Realtime must not use batch STT'); }),
    response: { generate: vi.fn(async input => ({ turnId: input.turnId, replyText: 'Chào bạn!', language: input.language })) },
    synthesize: vi.fn(async () => ({ bytes: sample, mimeType: 'audio/wav', durationMs: 3400 })),
  };
  const config = loadConfig({ MIU_PROVIDER: 'real', STT_LOGGING: '1', ELEVENLABS_API_KEY: 'test', OPENAI_API_KEY: 'test' });
  const factory = vi.fn((_language, emit) => { upstream = emit; return connection; });
  const app = await createTestApp({ config, providers, realtimeStt: factory }); apps.push(app);
  const created = await app.http.post('/api/sessions').send({ demo_profile_key: 'an', request_id: randomUUID() });
  const session = created.body;
  const requestId = randomUUID();
  const socket = new WebSocket(`${app.baseUrl.replace('http:', 'ws:')}/api/sessions/${session.session_id}/speech-stream`, { origin: app.baseUrl }); sockets.push(socket);
  const messages: Record<string, any>[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', raw => { messages.push(JSON.parse(raw.toString())); for (const wake of waiters.splice(0)) wake(); });
  const wait = async (type: string): Promise<Record<string, any>> => {
    for (let i = 0; i < 100; i++) {
      const message = messages.find(m => m.type === type); if (message) return message;
      await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]);
    }
    throw new Error(`No ${type}: ${JSON.stringify(messages)}`);
  };
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'stream.start', token: session.demo_token, request_id: requestId, language: 'vi' }));
  await wait('stream.ready');
  const audio = (seq = 0) => { const packet = Buffer.alloc(6404); packet.writeUInt32LE(seq); socket.send(packet); };
  return { app, session, requestId, socket, messages, wait, audio, providers, connection, factory, emit: (event: RealtimeSttEvent) => upstream(event) };
}

describe('realtime speech turn gate', () => {
  it('keeps trusted reverse-proxy clients separate for stream limits', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(speechClientAddress({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': '198.51.100.1' } }, true)).toBe('198.51.100.1');
      expect(speechClientAddress({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': '2001:db8::1' } }, true)).toBe('2001:db8::1');
    }
  });
  it('ignores forwarded addresses from untrusted peers, disabled proxy trust, or malformed headers', () => {
    expect(speechClientAddress({ socket: { remoteAddress: '198.51.100.2' }, headers: { 'x-forwarded-for': '198.51.100.1' } }, true)).toBe('198.51.100.2');
    expect(speechClientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.1' } }, false)).toBe('127.0.0.1');
    for (const forwarded of ['198.51.100.1, 198.51.100.2', 'not-an-ip', ['198.51.100.1']]) {
      expect(speechClientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': forwarded } }, true)).toBe('127.0.0.1');
    }
  });
  it('preserves a stable engine quota code after full transcript without leaking its message', async () => {
    const t = await setup();
    vi.mocked(t.providers.response.generate).mockRejectedValueOnce(new AppError('provider_quota_exceeded', 429));
    t.audio(); t.emit({ type: 'committed', text: 'Xin chào.' });
    t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
    await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce());
    t.emit({ type: 'committed', text: '' });
    expect(await t.wait('stream.error')).toEqual({ type: 'stream.error', code: 'provider_quota_exceeded', status: 429, retryable: true });
    expect(t.messages.some(message => message.type === 'turn.result')).toBe(false);
  });
  it('masks unexpected errors and invalid engine codes', () => {
    for (const error of [new Error('private'), new AppError('private message with secrets', 500), new AppError('provider_unavailable', 200)]) {
      expect(publicSpeechError(error)).toEqual({ code: 'speech_stream_failed', status: 500, retryable: false });
    }
  });
  it('buffers revisions and segments, flushes the final chunk, then calls the engine exactly once with full text', async () => {
    const t = await setup(); t.audio();
    t.emit({ type: 'partial', text: 'Hôm' }); t.emit({ type: 'partial', text: 'Hôm nay mình buồn.' });
    expect(t.providers.response.generate).not.toHaveBeenCalled();
    t.emit({ type: 'committed', text: 'Hôm nay mình buồn.' });
    await t.wait('turn.end_candidate');
    expect(t.providers.response.generate).not.toHaveBeenCalled();
    t.audio(1); t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 1 }));
    await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce());
    expect(t.providers.response.generate).not.toHaveBeenCalled();
    t.emit({ type: 'committed', text: 'Bạn chơi với mình nhé.' });
    const result = await t.wait('turn.result');
    expect(result.response.input_mode).toBe('realtime_stt');
    expect(result.response.transcript.text).toBe('Hôm nay mình buồn. Bạn chơi với mình nhé.');
    expect(t.providers.response.generate).toHaveBeenCalledOnce();
    expect(t.providers.response.generate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hôm nay mình buồn. Bạn chơi với mình nhé.' }), expect.any(AbortSignal));
    expect(t.providers.transcribe).not.toHaveBeenCalled();
  });

  it('accepts an empty final commit acknowledgement without duplicating the committed text', async () => {
    const t = await setup(); t.audio(); t.emit({ type: 'committed', text: 'Xin chào.' });
    t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
    await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce());
    t.emit({ type: 'committed', text: '' });
    expect((await t.wait('turn.result')).response.transcript.text).toBe('Xin chào.');
  });

  it('preserves repeated spoken text and ignores partial replacements in the final transcript', async () => {
    const t = await setup(); t.audio();
    t.emit({ type: 'committed', text: 'Không.' }); t.emit({ type: 'partial', text: 'Không không không' });
    t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
    await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce());
    t.emit({ type: 'committed', text: 'Không.' });
    expect((await t.wait('turn.result')).response.transcript.text).toBe('Không. Không.');
  });

  it('rejects missing/out-of-order audio before invoking the engine', async () => {
    const t = await setup(); t.audio(1);
    expect((await t.wait('stream.error')).code).toBe('invalid_audio_sequence');
    expect(t.providers.response.generate).not.toHaveBeenCalled();
  });

  it('rejects a false last_seq rather than finalizing truncated audio', async () => {
    const t = await setup(); t.audio();
    t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 3 }));
    expect((await t.wait('stream.error')).code).toBe('invalid_audio_sequence');
    expect(t.connection.commit).not.toHaveBeenCalled(); expect(t.providers.response.generate).not.toHaveBeenCalled();
  });

  it('does not send noise-only or empty transcripts to GPT', async () => {
    const t = await setup(); t.audio(); t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
    await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce()); t.emit({ type: 'committed', text: '' });
    expect((await t.wait('stream.error')).code).toBe('unclear_audio');
    expect(t.providers.response.generate).not.toHaveBeenCalled();
  });

  it('cancels a stream through the existing turn endpoint, ignores late commits and releases the profile', async () => {
    const t = await setup(); t.audio(); t.emit({ type: 'partial', text: 'Xin chào' });
    const canceled = await t.app.http.delete(`/api/sessions/${t.session.session_id}/turns/${t.requestId}`).set('authorization', `Bearer ${t.session.demo_token}`);
    expect(canceled.status).toBe(200); await t.wait('stream.error');
    t.emit({ type: 'committed', text: 'Xin chào' }); expect(t.providers.response.generate).not.toHaveBeenCalled();
    const config = await t.app.http.patch('/api/profiles/current/config').set('authorization', `Bearer ${t.session.demo_token}`).send({ request_id: randomUUID(), language_mode: 'en' });
    expect(config.status).toBe(200);
  });

  it('blocks competing turns and configuration while the microphone stream owns a reservation', async () => {
    const t = await setup();
    const config = await t.app.http.patch('/api/profiles/current/config').set('authorization', `Bearer ${t.session.demo_token}`).send({ request_id: randomUUID(), language_mode: 'en' });
    expect(config.status).toBe(409);
    const turn = await t.app.http.post(`/api/sessions/${t.session.session_id}/turns`).set('authorization', `Bearer ${t.session.demo_token}`).send({ request_id: randomUUID(), kind: 'utterance', text: 'Other turn' });
    expect(turn.status).toBe(409); expect(t.providers.response.generate).not.toHaveBeenCalled();
  });

  it('fails provider errors without promoting a partial transcript to a final answer', async () => {
    const t = await setup(); t.emit({ type: 'partial', text: 'Xin chào' }); t.emit({ type: 'error', code: 'provider_unavailable' });
    expect((await t.wait('stream.error')).code).toBe('provider_unavailable');
    expect(t.providers.response.generate).not.toHaveBeenCalled();
  });

  it('cancels duplicate finalization rather than dispatching twice', async () => {
    const t = await setup(); t.audio();
    t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
    await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce());
    t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
    expect((await t.wait('stream.error')).code).toBe('invalid_audio_sequence');
    t.emit({ type: 'committed', text: 'Late result' });
    expect(t.providers.response.generate).not.toHaveBeenCalled();
  });

  it('still rejects changed persistent state after full transcript, before the engine', async () => {
    const t = await setup();
    const reconcile = vi.spyOn(SessionService.prototype, 'reconcile').mockImplementation(async function (session) {
      this.applySnapshot(session.profile, { configuration: session.profile.configuration,
        state_version: session.profile.stateVersion + 1, clock_version: 1, effective_now: new Date().toISOString() });
    });
    try {
      t.audio(); t.emit({ type: 'committed', text: 'Full transcript' });
      t.socket.send(JSON.stringify({ type: 'audio.end', last_seq: 0 }));
      await vi.waitFor(() => expect(t.connection.commit).toHaveBeenCalledOnce());
      t.emit({ type: 'committed', text: '' });
      expect((await t.wait('stream.error')).code).toBe('turn_canceled');
      expect(t.providers.response.generate).not.toHaveBeenCalled();
    } finally { reconcile.mockRestore(); }
  });
});

describe('realtime deadlines never submit partial text', () => {
  afterEach(() => vi.useRealTimers());
  async function service() {
    vi.useFakeTimers();
    const sessions = new SessionService(); const session = sessions.create('an', randomUUID());
    let emit!: (event: RealtimeSttEvent) => void;
    const execute = vi.fn(); const failure = vi.fn();
    const input = new SpeechStreamService({
      config: loadConfig({}), sessions, session, turnId: randomUUID(),
      turns: { execute } as unknown as TurnService,
      emit: vi.fn(), fail: error => { failure(error); input.cancel(); },
      factory: (_language, callback) => { emit = callback; return { ready: Promise.resolve(), send: vi.fn(), commit: vi.fn(), close: vi.fn() }; },
    });
    await input.start(); return { input, execute, failure, emit };
  }
  it('fails a missing final commit acknowledgement without using partial text', async () => {
    const t = await service();
    t.input.audio(0, Buffer.alloc(6400)); t.emit({ type: 'partial', text: 'Not final' });
    const pending = expect(t.input.end(0)).rejects.toMatchObject({ code: 'speech_drain_timeout' });
    await vi.advanceTimersByTimeAsync(10000); await pending;
    expect(t.execute).not.toHaveBeenCalled(); t.input.cancel();
  });
  it('rejects a 30s hard limit instead of sending an unfinished utterance', async () => {
    const t = await service(); t.emit({ type: 'partial', text: 'Still speaking' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(t.failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'recording_limit' }));
    expect(t.execute).not.toHaveBeenCalled(); t.input.cancel();
  });
});

describe('realtime database access boundary', () => {
  it('does not reconcile at startup, per audio frame, per partial, per segment or while draining', async () => {
    const sessions = new SessionService();
    const session = sessions.create('an', randomUUID());
    const reconcile = vi.spyOn(sessions, 'reconcile');
    let emit!: (event: RealtimeSttEvent) => void;
    const execute = vi.fn(async () => {
      await sessions.reconcile(session);
      return { timings_ms: { stt: 0, server_total: 0 } };
    });
    const failure = vi.fn();
    const input = new SpeechStreamService({ config: loadConfig({}), sessions, session, turnId: randomUUID(),
      turns: { execute } as unknown as TurnService, emit: vi.fn(), fail: failure,
      factory: (_language, callback) => { emit = callback; return { ready: Promise.resolve(), send: vi.fn(), commit: vi.fn(), close: vi.fn() }; },
    });
    try {
      await input.start();
      input.audio(0, Buffer.alloc(6400));
      for (let i = 0; i < 147; i++) emit({ type: 'partial', text: `Revision ${i}` });
      emit({ type: 'committed', text: 'First sentence.' });
      expect(reconcile).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const completed = input.end(0);
      expect(reconcile).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      emit({ type: 'committed', text: 'Last sentence.' });
      await completed;
      expect(reconcile).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(session, expect.objectContaining({ text: 'First sentence. Last sentence.' }), expect.any(AbortSignal));
    } finally { input.cancel(); sessions.dispose(); }
  });
});
