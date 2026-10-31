import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRealtimeSttFactory } from '../src/providers/elevenlabs/realtime-stt.provider.js';

interface SocketDouble {
  url: URL;
  options: { headers: Record<string, string> };
  readyState: number;
  bufferedAmount: number;
  sent: Record<string, unknown>[];
  emit(event: string, value: unknown): void;
  terminate: ReturnType<typeof vi.fn>;
}
const transport = vi.hoisted(() => ({ sockets: [] as SocketDouble[] }));

// Offline request-contract checks only. The WebSocket is an in-memory double;
// no provider request is made and these checks do not establish STT quality.
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent: Record<string, unknown>[] = [];
    terminate = vi.fn(() => { this.readyState = 3; });
    constructor(readonly url: URL, readonly options: { headers: Record<string, string> }) {
      super(); transport.sockets.push(this);
    }
    send(value: string) { this.sent.push(JSON.parse(value) as Record<string, unknown>); }
  } };
});

const config = () => loadConfig({ MIU_PROVIDER: 'real', STT_LOGGING: '1',
  ELEVENLABS_API_KEY: 'offline-realtime-contract', OPENAI_API_KEY: 'offline-unused-contract' });
const actualConfig = { model_id: 'scribe_v2_realtime', filter_background_audio: true,
  vad_commit_strategy: false, vad_silence_threshold_secs: 1.5, keepalive_interval_ms: 1000, disable_logging: false };
function setup(logging = true) {
  const emit = vi.fn();
  const connection = createRealtimeSttFactory({ ...config(), enableLogging: logging })('vi', emit);
  const socket = transport.sockets.at(-1)!;
  const message = (data: Record<string, unknown>) => socket.emit('message', Buffer.from(JSON.stringify(data)));
  return { connection, socket, emit, message,
    ready: () => message({ message_type: 'session_started', config: actualConfig }) };
}

describe('offline ElevenLabs manual realtime commit contract', () => {
  beforeEach(() => { transport.sockets.length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it('requests manual commits and filtering, then sends one ordered final commit and accepts its complete result', async () => {
    const t = setup();
    expect(t.socket.url.searchParams.get('commit_strategy')).toBe('manual');
    expect(t.socket.url.searchParams.get('filter_background_audio')).toBe('true');
    expect(t.socket.url.searchParams.has('vad_silence_threshold_secs')).toBe(false);
    expect(t.socket.url.searchParams.get('keepalive_interval_ms')).toBe('1000');
    expect(t.socket.url.searchParams.has('enable_logging')).toBe(false);
    // The observed manual-mode echo retains an unrelated 1.5 s VAD default.
    t.ready(); await t.connection.ready;
    t.connection.send(Buffer.from([1, 0]));
    t.message({ message_type: 'partial_transcript', text: 'First part.' });
    t.connection.send(Buffer.from([2, 0]));
    t.message({ message_type: 'partial_transcript', text: 'First part. Final tail.' });
    expect(t.emit.mock.calls.map(([event]) => event.type)).toEqual(['partial', 'partial']);
    t.connection.commit();
    expect(t.socket.sent).toEqual([
      { message_type: 'input_audio_chunk', audio_base_64: 'AQA=', sample_rate: 16000 },
      { message_type: 'input_audio_chunk', audio_base_64: 'AgA=', sample_rate: 16000 },
      { message_type: 'input_audio_chunk', audio_base_64: '', sample_rate: 16000, commit: true },
    ]);
    expect(() => t.connection.commit()).toThrow('invalid_audio_sequence');
    expect(() => t.connection.send(Buffer.from([3, 0]))).toThrow('invalid_audio_sequence');
    t.message({ message_type: 'committed_transcript', text: 'First part. Final tail.' });
    expect(t.emit).toHaveBeenLastCalledWith({ type: 'committed', text: 'First part. Final tail.' });
    t.connection.close();
  });

  it.each([
    { ...actualConfig, vad_commit_strategy: true },
    { ...actualConfig, filter_background_audio: false },
    { ...actualConfig, model_id: 'unexpected-model' },
  ])('rejects incompatible session configuration instead of continuing: %j', async returnedConfig => {
    const t = setup();
    const rejected = expect(t.connection.ready).rejects.toMatchObject({ code: 'provider_configuration' });
    t.message({ message_type: 'session_started', config: returnedConfig });
    await rejected;
    expect(t.emit).toHaveBeenCalledExactlyOnceWith({ type: 'error', code: 'provider_configuration' });
    expect(() => t.connection.send(Buffer.from([1, 0]))).toThrow('speech_backpressure');
    t.connection.close();
  });

  it('preserves explicit zero retention and fails when the provider does not apply it', async () => {
    const t = setup(false);
    expect(t.socket.url.searchParams.get('enable_logging')).toBe('false');
    const rejected = expect(t.connection.ready).rejects.toMatchObject({ code: 'retention_not_applied' });
    t.ready(); await rejected;
    expect(t.emit).toHaveBeenCalledExactlyOnceWith({ type: 'error', code: 'retention_not_applied' });
    t.connection.close();
  });

  it('fails closed on an unsolicited commit and ignores later transcript events', async () => {
    const t = setup(); t.ready(); await t.connection.ready;
    t.connection.send(Buffer.from([1, 0]));
    t.message({ message_type: 'committed_transcript', text: 'Unexpected earlier VAD segment.' });
    t.message({ message_type: 'partial_transcript', text: 'Later revision.' });
    expect(t.emit).toHaveBeenCalledExactlyOnceWith({ type: 'error', code: 'invalid_transcript' });
    expect(t.socket.terminate).toHaveBeenCalledOnce();
    expect(() => t.connection.commit()).toThrow('speech_backpressure');
    expect(t.socket.sent).toHaveLength(1);
    t.connection.close();
    expect(t.socket.terminate).toHaveBeenCalledOnce();
  });

  it('accepts an empty manual acknowledgement without promoting a partial, then rejects a duplicate commit', async () => {
    const t = setup(); t.ready(); await t.connection.ready;
    t.connection.send(Buffer.from([0, 0]));
    t.message({ message_type: 'partial_transcript', text: 'A tentative revision.' });
    t.connection.commit();
    t.message({ message_type: 'committed_transcript', text: '' });
    expect(t.emit).toHaveBeenLastCalledWith({ type: 'committed', text: '' });
    t.message({ message_type: 'committed_transcript', text: 'Unexpected duplicate.' });
    expect(t.emit).toHaveBeenLastCalledWith({ type: 'error', code: 'invalid_transcript' });
    expect(t.emit.mock.calls.filter(([event]) => event.type === 'committed')).toHaveLength(1);
    t.connection.close();
  });

  it('ignores late partials and commits after cancellation', async () => {
    const t = setup(); t.ready(); await t.connection.ready;
    t.connection.send(Buffer.from([1, 0])); t.connection.close();
    t.message({ message_type: 'partial_transcript', text: 'Late partial.' });
    t.message({ message_type: 'committed_transcript', text: 'Late final.' });
    expect(t.emit).not.toHaveBeenCalled();
    expect(t.socket.terminate).toHaveBeenCalledOnce();
  });
});
