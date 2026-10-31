import { describe, expect, it, vi } from 'vitest';
import { VoicePlayback, type PlaybackEnvironment } from '../src/playback.js';
import { turn } from './fixtures.js';

class FakeAudio extends EventTarget {
  src = '';
  preload = '';
  currentTime = 0;
  ended = false;
  paused = true;
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  });
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')); });
  removeAttribute = vi.fn(() => { this.src = ''; });
  load = vi.fn();
}
function player() {
  const audio = new FakeAudio();
  let blob: Blob | undefined;
  const environment: PlaybackEnvironment = {
    createAudio: () => audio as unknown as HTMLAudioElement,
    createObjectURL: value => { blob = value; return 'blob:test'; },
    revokeObjectURL: vi.fn(), decodeBase64: value => atob(value),
  };
  let id = 0;
  const playback = new VoicePlayback({ environment, createRequestId: () => `receipt-${++id}` });
  return { playback, environment, audio, blob: () => blob };
}

describe('playback and real-event receipts', () => {
  it('uses response MIME and orders started/completed receipts only after actual media events', async () => {
    const fake = player();
    const receipts = vi.fn(async () => {});
    const response = { ...turn(), audio: { ...turn().audio, mime_type: 'audio/mpeg' } };
    expect(await fake.playback.play(response, receipts)).toBe('playing');
    expect(fake.blob()?.type).toBe('audio/mpeg');
    await fake.playback.flushReceipts();
    expect(receipts.mock.calls[0]![0]).toMatchObject({ status: 'started', played_ms: 0, state_version: 2 });
    fake.audio.currentTime = 1;
    fake.audio.ended = true;
    fake.audio.dispatchEvent(new Event('ended'));
    await fake.playback.flushReceipts();
    expect(receipts.mock.calls[1]![0]).toMatchObject({ status: 'completed', played_ms: 1000 });
    expect(receipts.mock.calls[0]![0].request_id).not.toBe(receipts.mock.calls[1]![0].request_id);
    expect(fake.environment.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    expect(fake.playback.state).toBe('idle');
  });

  it('keeps blocked audio for an explicit Play gesture and reports no fictional playback', async () => {
    const fake = player();
    fake.audio.play.mockRejectedValueOnce(new DOMException('Requires a gesture', 'NotAllowedError'));
    const receipts = vi.fn(async () => {});
    expect(await fake.playback.play(turn(), receipts)).toBe('blocked');
    await fake.playback.flushReceipts();
    expect(fake.playback.state).toBe('blocked');
    expect(receipts).not.toHaveBeenCalled();
    expect(await fake.playback.resume()).toBe('playing');
    await fake.playback.flushReceipts();
    expect(receipts).toHaveBeenCalledOnce();
    fake.audio.currentTime = 0.4;
    fake.playback.stop();
    await fake.playback.flushReceipts();
    expect(receipts.mock.calls[1]![0]).toMatchObject({ status: 'interrupted', played_ms: 400 });
  });

  it('does not retry or resume a stale play promise after Stop', async () => {
    const fake = player();
    let finish!: () => void;
    fake.audio.play.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const receipts = vi.fn(async () => {});
    const result = fake.playback.play(turn(), receipts);
    fake.playback.stop();
    expect(await result).toBe('canceled');
    finish();
    fake.audio.dispatchEvent(new Event('playing'));
    fake.audio.dispatchEvent(new Event('ended'));
    await fake.playback.flushReceipts();
    expect(receipts).not.toHaveBeenCalled();
    expect(await fake.playback.resume()).toBe('canceled');
    expect(fake.audio.play).toHaveBeenCalledOnce();
  });

  it('stops the active audio on AbortSignal and prevents observer-triggered Stop from starting audio', async () => {
    const fake = player();
    const abort = new AbortController();
    const receipts = vi.fn(async () => {});
    await fake.playback.play(turn(), receipts, abort.signal);
    abort.abort();
    await fake.playback.flushReceipts();
    expect(receipts.mock.calls.map(call => call[0].status)).toEqual(['started', 'interrupted']);
    const second = player();
    second.playback.subscribe(event => { if (event.type === 'state' && event.state === 'starting') second.playback.stop(); });
    expect(await second.playback.play(turn(), receipts)).toBe('canceled');
    expect(second.audio.play).not.toHaveBeenCalled();
  });
});
