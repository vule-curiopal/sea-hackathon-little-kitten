import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse, TurnResponse } from '@miu/voice-contracts';
import type { CaptureEvent } from '../src/capture.js';
import { RealtimeVoiceCapture } from '../src/realtime/capture.js';

// Offline protocol/lifecycle checks only. Microphone, AudioWorklet and WebSocket
// are in-memory doubles; a "real" protocol marker is not provider evidence.
// No audio leaves this process and no character/memory evaluation runs here.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const session: SessionResponse = {
  session_id: 'offline-realtime-session', demo_token: 'offline-realtime-bearer', provider_mode: 'real', engine_mode: 'character_memory',
  clock_version: 1, state_version: 1, effective_now: '2026-11-01T02:00:00.000Z',
  configuration: { language_mode: 'en', voice_id: 'offline-approved-voice', personality: 'ENFP', role: 'friend' },
};
const requestId = 'offline-realtime-turn';
function response(): TurnResponse {
  return {
    session_id: session.session_id, turn_id: requestId, sequence: 1, provider_mode: 'real', engine_mode: 'character_memory', input_mode: 'realtime_stt',
    clock_version: 1, state_version: 2,
    transcript: { text: 'Offline request-contract text.', language: 'en', uncertain_spans: [] },
    reply: { text: 'Offline protocol reply.', sentences: ['Offline protocol reply.'], language: 'en' },
    audio: { mime_type: 'audio/mpeg', data_base64: 'b2ZmbGluZQ==', duration_ms: 100 },
    presentation: null, face: null, memory: null,
    timings_ms: { stt: 0, reply: 0, validation: 0, tts: 0, server_total: 0 },
  };
}

class Track extends EventTarget { stop = vi.fn(); }
class AudioContextDouble extends EventTarget {
  static instances: AudioContextDouble[] = [];
  state = 'suspended';
  readonly sampleRate = 48000;
  readonly destination = {};
  readonly source = { connect: vi.fn(), disconnect: vi.fn() };
  readonly audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; this.dispatchEvent(new Event('statechange')); });
  createMediaStreamSource = vi.fn(() => this.source);
  constructor() { super(); AudioContextDouble.instances.push(this); }
}
class WorkletDouble {
  static instances: WorkletDouble[] = [];
  onprocessorerror: (() => void) | null = null;
  readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(_context: AudioContext, _name: string) { WorkletDouble.instances.push(this); }
  samples(count: number, value = .25) { this.port.onmessage?.({ data: { type: 'samples', samples: new Float32Array(count).fill(value) } }); }
  flushed() { this.port.onmessage?.({ data: { type: 'flushed' } }); }
}
class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: SocketDouble[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  send = vi.fn((value: string | Uint8Array) => { this.sent.push(typeof value === 'string' ? value : value.slice()); });
  close = vi.fn(() => { this.readyState = SocketDouble.CLOSED; this.onclose?.(); });
  constructor(readonly url: string | URL) { SocketDouble.instances.push(this); }
  open() { this.readyState = SocketDouble.OPEN; this.onopen?.(); }
  message(value: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(value) }); }
  controls(): Record<string, unknown>[] { return this.sent.filter((value): value is string => typeof value === 'string').map(value => JSON.parse(value) as Record<string, unknown>); }
  packets(): Uint8Array[] { return this.sent.filter((value): value is Uint8Array => value instanceof Uint8Array); }
}

function environment(permission?: Promise<MediaStream>) {
  const track = new Track();
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const getUserMedia = vi.fn(() => permission ?? Promise.resolve(stream));
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { origin: 'https://miu.test' });
  vi.stubGlobal('AudioContext', AudioContextDouble);
  vi.stubGlobal('AudioWorkletNode', WorkletDouble);
  vi.stubGlobal('WebSocket', SocketDouble);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:offline-worklet');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const capture = new RealtimeVoiceCapture();
  const events: CaptureEvent[] = [];
  capture.subscribe(event => events.push(event));
  const abort = new AbortController();
  const processing = vi.fn();
  const start = (beforeConnect?: Promise<unknown>) => capture.start(session, requestId, abort.signal, processing, beforeConnect);
  const lastState = () => events.filter(event => event.type === 'state').at(-1)?.state;
  const connect = async () => {
    await settle();
    const socket = SocketDouble.instances.at(-1)!;
    expect(socket).toBeDefined();
    socket.open();
    return socket;
  };
  const ready = async () => {
    const socket = await connect();
    socket.message({ type: 'stream.ready', sample_rate: 16000, chunk_ms: 200, max_recording_ms: 30000 });
    return socket;
  };
  return { capture, events, track, stream, document, getUserMedia, abort, processing, start, lastState, connect, ready };
}

describe('offline realtime hold-to-talk capture contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    AudioContextDouble.instances = []; WorkletDouble.instances = []; SocketDouble.instances = [];
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('stays recording through server VAD endpoint suggestions while the hold remains active', async () => {
    const fake = environment();
    const result = fake.start();
    const socket = await fake.ready();
    const worklet = WorkletDouble.instances[0]!;
    worklet.samples(9600);
    socket.message({ type: 'transcript.segment', text: 'A partial segment.' });
    socket.message({ type: 'turn.end_candidate' });
    await vi.advanceTimersByTimeAsync(3500);
    socket.message({ type: 'turn.end_candidate' });
    expect(fake.lastState()).toBe('recording');
    expect(worklet.port.postMessage).not.toHaveBeenCalled();
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    expect(fake.track.stop).not.toHaveBeenCalled();
    expect(fake.processing).not.toHaveBeenCalled();
    worklet.samples(4800);
    expect(fake.capture.send()).toBe(true);
    worklet.flushed(); await settle();
    socket.message({ type: 'turn.result', response: response() });
    await expect(result).resolves.toMatchObject({ input_mode: 'realtime_stt', turn_id: requestId });
  });

  it('release flushes buffered PCM and sends exactly one ordered audio.end before accepting the turn result', async () => {
    const fake = environment();
    const result = fake.start();
    const socket = await fake.ready();
    expect(String(socket.url)).toBe(`wss://miu.test/api/sessions/${session.session_id}/speech-stream`);
    expect(socket.controls()).toEqual([{ type: 'stream.start', token: session.demo_token, request_id: requestId, language: 'en' }]);
    const worklet = WorkletDouble.instances[0]!;
    worklet.samples(9600); // One complete 200 ms 16 kHz frame.
    worklet.samples(4800); // A remaining 100 ms tail held by the actual encoder.
    expect(fake.capture.send()).toBe(true);
    expect(fake.capture.send()).toBe(false);
    expect(fake.lastState()).toBe('finalizing_capture');
    expect(worklet.port.postMessage).toHaveBeenCalledExactlyOnceWith('flush');
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    worklet.flushed(); await settle();
    expect(socket.packets().map(packet => new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true))).toEqual([0, 1]);
    expect(socket.packets().map(packet => packet.length)).toEqual([6404, 3204]);
    expect(socket.controls().filter(message => message.type === 'audio.end')).toEqual([{ type: 'audio.end', last_seq: 1 }]);
    expect(fake.capture.send()).toBe(false);
    expect(fake.track.stop).toHaveBeenCalled();
    expect(AudioContextDouble.instances[0]!.state).toBe('closed');
    socket.message({ type: 'stream.processing' });
    expect(fake.processing).toHaveBeenCalledOnce();
    socket.message({ type: 'turn.result', response: response() });
    await expect(result).resolves.toMatchObject({ turn_id: requestId });
    expect(fake.lastState()).toBe('idle');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('release before microphone permission cancels and closes a late-granted stream without creating a socket', async () => {
    const permission = deferred<MediaStream>();
    const fake = environment(permission.promise);
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    expect(fake.lastState()).toBe('requesting_permission');
    expect(fake.capture.send()).toBe(false);
    permission.resolve(fake.stream);
    await rejected; await settle();
    expect(fake.lastState()).toBe('idle');
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(AudioContextDouble.instances[0]!.close).toHaveBeenCalledOnce();
    expect(WorkletDouble.instances).toHaveLength(0);
    expect(SocketDouble.instances).toHaveLength(0);
  });

  it('release before stream.ready cancels without beginning recording when readiness arrives late', async () => {
    const fake = environment();
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    const socket = await fake.connect();
    expect(fake.lastState()).toBe('preparing_stream');
    expect(AudioContextDouble.instances[0]!.source.connect).not.toHaveBeenCalled();
    expect(fake.capture.send()).toBe(false);
    await rejected;
    socket.message({ type: 'stream.ready' }); await settle();
    expect(fake.lastState()).toBe('idle');
    expect(AudioContextDouble.instances[0]!.source.connect).not.toHaveBeenCalled();
    expect(fake.events.some(event => event.type === 'state' && event.state === 'recording')).toBe(false);
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('release during the previous-turn cancellation fence never opens a speech socket afterward', async () => {
    const beforeConnect = deferred<void>();
    const fake = environment();
    const result = fake.start(beforeConnect.promise);
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    await settle();
    expect(fake.lastState()).toBe('preparing_stream');
    expect(WorkletDouble.instances).toHaveLength(1);
    expect(SocketDouble.instances).toHaveLength(0);
    expect(fake.capture.send()).toBe(false);
    await rejected;
    beforeConnect.resolve(); await settle();
    expect(SocketDouble.instances).toHaveLength(0);
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(fake.lastState()).toBe('idle');
  });

  it('server recording-limit failure stops the microphone and discards the held turn without auto-submitting', async () => {
    const fake = environment();
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'recording_limit', status: 422 });
    const socket = await fake.ready();
    WorkletDouble.instances[0]!.samples(9600);
    await vi.advanceTimersByTimeAsync(30000);
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    socket.message({ type: 'stream.error', code: 'recording_limit', status: 422, retryable: false });
    await rejected;
    expect(fake.capture.send()).toBe(false);
    expect(fake.lastState()).toBe('idle');
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(AudioContextDouble.instances[0]!.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    expect(fake.processing).not.toHaveBeenCalled();
  });

  it('cancel during release flushing ignores late worklet samples, flush acknowledgements, and server processing', async () => {
    const fake = environment();
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    const socket = await fake.ready();
    const worklet = WorkletDouble.instances[0]!;
    worklet.samples(4800);
    expect(fake.capture.send()).toBe(true);
    fake.abort.abort();
    worklet.samples(9600); worklet.flushed();
    socket.message({ type: 'stream.processing' });
    socket.message({ type: 'turn.result', response: response() });
    await rejected; await settle();
    expect(fake.lastState()).toBe('idle');
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    expect(socket.packets()).toHaveLength(0);
    expect(fake.processing).not.toHaveBeenCalled();
    expect(fake.track.stop).toHaveBeenCalledOnce();
  });

  it('an empty quick release fails without an invalid negative audio sequence or an automatic request', async () => {
    const fake = environment();
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'NO_AUDIO' });
    const socket = await fake.ready();
    expect(fake.capture.send()).toBe(true);
    WorkletDouble.instances[0]!.flushed();
    await rejected;
    expect(socket.packets()).toHaveLength(0);
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    expect(fake.processing).not.toHaveBeenCalled();
    expect(fake.lastState()).toBe('idle');
    expect(fake.track.stop).toHaveBeenCalled();
  });

  it('a duplicate ready message fails instead of creating a second source or restarting the held recording', async () => {
    const fake = environment();
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const socket = await fake.ready();
    socket.message({ type: 'stream.ready' });
    await rejected;
    expect(AudioContextDouble.instances[0]!.createMediaStreamSource).toHaveBeenCalledOnce();
    expect(fake.events.filter(event => event.type === 'state' && event.state === 'recording')).toHaveLength(1);
    expect(fake.lastState()).toBe('idle');
    expect(socket.controls().some(message => message.type === 'audio.end')).toBe(false);
    expect(fake.track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    { type: 'transcript.final', text: 'Offline premature text.' },
    { type: 'stream.processing' },
    { type: 'turn.result', response: response() },
  ])('rejects premature $type before the person releases the held utterance', async message => {
    const fake = environment();
    const result = fake.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const socket = await fake.ready();
    WorkletDouble.instances[0]!.samples(9600);
    socket.message(message);
    await rejected;
    expect(fake.processing).not.toHaveBeenCalled();
    expect(fake.events.some(event => event.type === 'transcript_final')).toBe(false);
    expect(socket.controls().some(control => control.type === 'audio.end')).toBe(false);
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(fake.lastState()).toBe('idle');
  });
});
