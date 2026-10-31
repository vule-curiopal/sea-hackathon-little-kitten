import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectAudio, inspectSynthesizedAudio } from '../src/audio.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const originalProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const mockedSpawn = vi.mocked(spawn);
const available = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0
  && spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
const signal = (): AbortSignal => new AbortController().signal;

function wav(seconds = 0.4): Buffer {
  const rate = 16000;
  const count = Math.round(seconds * rate);
  const data = Buffer.alloc(44 + count * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) data.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 2000), 44 + index * 2);
  return data;
}
function encode(format: 'mp4' | 'webm' | 'mp3', seconds = 0.4): Buffer {
  const options = format === 'mp4' ? ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov']
    : format === 'webm' ? ['-c:a', 'libopus', '-live', '1'] : ['-c:a', 'libmp3lame'];
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', ...options, '-f', format, 'pipe:1'], {
    input: wav(seconds), windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Unable to generate synthetic audio fixture');
  return result.stdout;
}
function encodeTailMoov(): Buffer {
  // Only synthetic test audio is written to a unique temp file by this fixture generator.
  // The application inspector itself always keeps user audio in memory.
  const directory = mkdtempSync(join(tmpdir(), 'miu-audio-synthetic-'));
  const target = join(directory, 'synthetic.mp4');
  try {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-ar', '48000', '-c:a', 'aac', '-b:a', '128k', target], {
      input: wav(5), windowsHide: true,
    });
    if (generated.status !== 0) throw new Error('Unable to generate synthetic tail-moov MP4');
    return readFileSync(target);
  } finally {
    try { unlinkSync(target); } catch { /* failed encoding may not create a file */ }
    rmdirSync(directory);
  }
}
function fakeChild(output?: string | Buffer): ReturnType<typeof spawn> {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  if (output !== undefined) queueMicrotask(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0); });
  return child as unknown as ReturnType<typeof spawn>;
}
function mp4Header(): Buffer {
  const box = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer => {
    const result = Buffer.alloc(8 + payload.length);
    result.writeUInt32BE(result.length); result.write(type, 4); payload.copy(result, 8);
    return result;
  };
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isomiso2')), box('moov'), box('mdat', Buffer.alloc(1))]);
}
const probe = (durationSeconds = 0.4): string => JSON.stringify({
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', sample_rate: '16000', channels: 1 }],
  packets: [{ stream_index: 0, pts_time: '0', duration_time: String(durationSeconds), size: '8' }],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
});

beforeEach(() => { mockedSpawn.mockReset(); mockedSpawn.mockImplementation(originalProcess.spawn); });
afterEach(() => { vi.useRealTimers(); });

describe('audio upload validation', () => {
  it('measures valid PCM WAV in memory rather than trusting the filename', async () => {
    await expect(inspectAudio(wav(), 'audio/x-wav', '../../irrelevant.mp4', signal())).resolves.toEqual({ mimeType: 'audio/wav', durationMs: 400 });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
  it('rejects a mismatched MIME, malformed PCM alignment and truncated WAV', async () => {
    await expect(inspectAudio(wav(), 'audio/webm', 'lie.webm', signal())).rejects.toMatchObject({ code: 'unsupported_audio', status: 415 });
    const inconsistent = wav(); inconsistent.writeUInt16LE(4, 32);
    await expect(inspectAudio(inconsistent, 'audio/wav', 'bad.wav', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    await expect(inspectAudio(wav().subarray(0, 100), 'audio/wav', 'short.wav', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
  });
  it('rejects empty, too-short, oversized and over-duration uploads', async () => {
    await expect(inspectAudio(Buffer.alloc(0), 'audio/wav', 'empty.wav', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    await expect(inspectAudio(wav(0.05), 'audio/wav', 'tiny.wav', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    await expect(inspectAudio(Buffer.alloc(5242881), 'audio/wav', 'large.wav', signal())).rejects.toMatchObject({ code: 'audio_too_large', status: 413 });
    await expect(inspectAudio(wav(30.01), 'audio/wav', 'long.wav', signal())).rejects.toMatchObject({ code: 'audio_too_long', status: 413 });
  });
  it('does not mistake an arbitrary extensible-WAV subtype for PCM', async () => {
    const standard = wav();
    const extended = Buffer.concat([standard.subarray(0, 36), Buffer.alloc(24), standard.subarray(36)]);
    extended.writeUInt32LE(extended.length - 8, 4);
    extended.writeUInt32LE(40, 16);
    extended.writeUInt16LE(0xfffe, 20);
    extended.writeUInt16LE(22, 36);
    extended.writeUInt16LE(16, 38);
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(extended, 44);
    await expect(inspectAudio(extended, 'audio/wav', 'extended.wav', signal())).resolves.toMatchObject({ durationMs: 400 });
    extended[59] = 0;
    await expect(inspectAudio(extended, 'audio/wav', 'not-pcm.wav', signal())).rejects.toMatchObject({ code: 'unsupported_audio' });
  });
  it('rejects an already canceled capture before probing', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(inspectAudio(wav(), 'audio/wav', 'audio.wav', abort.signal)).rejects.toMatchObject({ code: 'turn_canceled' });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
  it('reports missing ffprobe without revealing a process error', async () => {
    await expect(inspectAudio(mp4Header(), 'audio/mp4', 'audio.mp4', signal(), 'missing-miu-ffprobe-executable')).rejects.toMatchObject({ code: 'audio_probe_unavailable', status: 503 });
  });
  it('rejects MP4 whose declared box size extends beyond its actual bytes', async () => {
    const corrupt = mp4Header(); corrupt.writeUInt32BE(1000000, 0);
    await expect(inspectAudio(corrupt, 'audio/mp4', 'audio.mp4', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(!available)('real in-memory container probing (requires ffmpeg + ffprobe)', () => {
  it('accepts MP4/AAC and preserves an honest measured duration', async () => {
    const audio = encode('mp4');
    const result = await inspectAudio(audio, 'audio/mp4;codecs=mp4a.40.2', 'capture.m4a', signal());
    expect(result.mimeType).toBe('audio/mp4');
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
    expect(result.durationMs).toBeLessThan(550);
  });
  it('inspects tail-moov MP4 beyond the stdin seek buffer without mutating the uploaded bytes', async () => {
    const audio = encodeTailMoov();
    const original = Buffer.from(audio);
    expect(audio.length).toBeGreaterThan(32768);
    expect(audio.indexOf('moov')).toBeGreaterThan(audio.indexOf('mdat'));
    const result = await inspectAudio(audio, 'audio/mp4', 'capture.mp4', signal());
    expect(result.mimeType).toBe('audio/mp4');
    expect(result.durationMs).toBeGreaterThanOrEqual(5000);
    expect(result.durationMs).toBeLessThan(5150);
    expect(audio.equals(original)).toBe(true);
  });
  it('uses packet timestamps for browser-like WebM without a duration header', async () => {
    const result = await inspectAudio(encode('webm'), 'audio/webm;codecs=opus', 'capture.webm', signal());
    expect(result.mimeType).toBe('audio/webm');
    expect(result.durationMs).toBeGreaterThanOrEqual(390);
    expect(result.durationMs).toBeLessThan(450);
  });
  it('rejects truncated MP4 and wrong-container content', async () => {
    const original = encode('mp4');
    await expect(inspectAudio(original.subarray(0, original.length - 10), 'audio/mp4', 'capture.mp4', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    await expect(inspectAudio(original, 'audio/webm', 'capture.webm', signal())).rejects.toMatchObject({ code: 'unsupported_audio' });
  });
  it('rejects video-only WebM', async () => {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=5', '-t', '0.4', '-c:v', 'libvpx', '-f', 'webm', 'pipe:1'], { windowsHide: true });
    expect(generated.status).toBe(0);
    await expect(inspectAudio(generated.stdout, 'audio/webm', 'video.webm', signal())).rejects.toMatchObject({ code: 'unsupported_audio' });
  });
  it('accepts actual synthesized MP3, but does not accept MP3 as microphone input', async () => {
    const audio = encode('mp3');
    const result = await inspectSynthesizedAudio(audio, 'audio/mpeg', signal());
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
    await expect(inspectAudio(audio, 'audio/mpeg', 'capture.mp3', signal())).rejects.toMatchObject({ code: 'unsupported_audio' });
  });
});

describe('bounded and cancellable ffprobe subprocess', () => {
  it('uses a fixed argument array with no shell or filename interpolation', async () => {
    mockedSpawn.mockReturnValueOnce(fakeChild(probe()));
    await inspectAudio(mp4Header(), 'audio/mp4', 'capture;bad.mp4', signal());
    const [executable, args, options] = mockedSpawn.mock.calls[0]!;
    expect(executable).toBe('ffprobe');
    expect(args).toContain('pipe:0');
    expect(args).not.toContain('capture;bad.mp4');
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });
  it('rejects invalid JSON, missing packets, invalid stream objects and empty packets', async () => {
    for (const output of ['not-json', '{}', '{"streams":[null],"packets":[{}]}', probe().replace('"size":"8"', '"size":"0"')]) {
      mockedSpawn.mockReturnValueOnce(fakeChild(output));
      await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    }
  });
  it('uses the next timestamp when ffprobe 6 omits a fragmented MP4 first packet duration', async () => {
    const output = JSON.parse(probe());
    output.packets = [
      { stream_index: 0, pts_time: '0', size: '8' },
      { stream_index: 0, pts_time: '0.064', duration_time: '0.064', size: '8' },
    ];
    mockedSpawn.mockReturnValueOnce(fakeChild(JSON.stringify(output)));
    await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).resolves.toMatchObject({ durationMs: 128 });
    output.packets[1].pts_time = '30.2';
    mockedSpawn.mockReturnValueOnce(fakeChild(JSON.stringify(output)));
    await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).rejects.toMatchObject({ code: 'audio_too_long' });
  });
  it('requires a positive measured boundary and rejects other absent or invalid packet durations', async () => {
    const packet = { stream_index: 0, pts_time: '0', duration_time: '0.064', size: '8' };
    const missing = { stream_index: 0, pts_time: '0', size: '8' };
    const invalidPackets = [
      [missing],
      [missing, packet],
      [missing, { ...packet, pts_time: '-0.064' }],
      [packet, { ...missing, pts_time: '0.064' }],
      [packet, { ...missing, pts_time: '0.064' }, { ...packet, pts_time: '0.128' }],
      [{ ...packet, duration_time: 'invalid' }, { ...packet, pts_time: '0.064' }],
      [{ ...packet, duration_time: '0' }, { ...packet, pts_time: '0.064' }],
    ];
    for (const packets of invalidPackets) {
      const output = { ...JSON.parse(probe()), packets };
      mockedSpawn.mockReturnValueOnce(fakeChild(JSON.stringify(output)));
      await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    }
  });
  it('allows at most 250ms compressed encoder padding without changing the measured duration', async () => {
    mockedSpawn.mockReturnValueOnce(fakeChild(probe(30.2)));
    await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).resolves.toMatchObject({ durationMs: 30200 });
    mockedSpawn.mockReturnValueOnce(fakeChild(probe(30.251)));
    await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).rejects.toMatchObject({ code: 'audio_too_long' });
  });
  it('kills a subprocess producing too much output', async () => {
    const child = fakeChild(Buffer.alloc(1024 * 1024 + 1));
    mockedSpawn.mockReturnValueOnce(child);
    await expect(inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal())).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(child.kill).toHaveBeenCalled();
  });
  it('kills a subprocess on capture cancellation', async () => {
    const child = fakeChild(); mockedSpawn.mockReturnValueOnce(child);
    const abort = new AbortController();
    const pending = inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'turn_canceled', status: 409 });
    expect(child.kill).toHaveBeenCalled();
  });
  it('bounds runtime even when a subprocess never closes', async () => {
    vi.useFakeTimers();
    const child = fakeChild(); mockedSpawn.mockReturnValueOnce(child);
    const pending = inspectAudio(mp4Header(), 'audio/mp4', 'capture.mp4', signal());
    const result = expect(pending).rejects.toMatchObject({ code: 'audio_probe_timeout', status: 503 });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(child.kill).toHaveBeenCalled();
  });
  it('does not expose a corrupt provider audio payload', async () => {
    await expect(inspectSynthesizedAudio(Buffer.from('not valid audio or an upstream secret'), 'audio/mpeg', signal())).rejects.toMatchObject({ code: 'provider_invalid_audio', status: 503 });
  });
});
