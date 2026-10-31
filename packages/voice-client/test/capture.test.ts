import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserVoiceCapture, type CaptureEnvironment, type CaptureEvent } from '../src/capture.js';
import type { MeterSnapshot } from '../src/detector.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

class FakeTrack extends EventTarget {
  stop = vi.fn();
  getSettings = () => ({ sampleRate: 48000, channelCount: 1 });
}
class FakeRecorder extends EventTarget {
  state = 'inactive';
  mimeType = 'audio/mp4';
  start = vi.fn(() => { this.state = 'recording'; });
  stop = vi.fn(() => { this.state = 'inactive'; });
  emitData(text: string) {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: new Blob([text], { type: this.mimeType }) });
    this.dispatchEvent(event);
  }
  flush(text = 'last') { this.emitData(text); this.dispatchEvent(new Event('stop')); }
}
class FakeContext extends EventTarget {
  state = 'running';
  analyser = {
    fftSize: 1024,
    level: -60,
    getFloatTimeDomainData(samples: Float32Array) { samples.fill(10 ** (this.level / 20)); },
  };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  createAnalyser = () => this.analyser;
  createMediaStreamSource = () => this.source;
}

function environment(permission?: Promise<MediaStream>) {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const recorder = new FakeRecorder();
  const context = new FakeContext();
  let visible = true;
  let visibilityListener = () => {};
  const env: CaptureEnvironment = {
    getUserMedia: vi.fn(() => permission ?? Promise.resolve(stream)),
    createAudioContext: () => context as unknown as AudioContext,
    createRecorder: vi.fn(() => recorder as unknown as MediaRecorder),
    isTypeSupported: mime => mime.startsWith('audio/mp4'),
    now: () => Date.now(),
    interval: (callback, ms) => { const timer = setInterval(callback, ms); return () => clearInterval(timer); },
    timeout: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
    isVisible: () => visible,
    onVisibilityChange: callback => { visibilityListener = callback; return () => { visibilityListener = () => {}; }; },
    isSecureContext: () => true,
  };
  return { env, track, stream, recorder, context, hide: () => { visible = false; visibilityListener(); } };
}

describe('browser capture lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports the finalized clip metadata including the last flushed bytes without exposing audio or device IDs', async () => {
    const fake = environment();
    fake.track.getSettings = () => ({ sampleRate: 48000, channelCount: 1, deviceId: 'private-device' });
    const capture = new BrowserVoiceCapture({ environment: fake.env, endpointing: 'manual' });
    const events: CaptureEvent[] = [];
    capture.subscribe(event => events.push(event));
    const result = capture.start();
    await settle();
    fake.context.analyser.level = -32;
    await vi.advanceTimersByTimeAsync(200);
    fake.recorder.emitData('first');
    capture.send();
    expect(events.some(event => event.type === 'complete')).toBe(false);
    fake.recorder.flush('last');
    expect((await result).blob.size).toBe(9);
    const complete = events.filter(event => event.type === 'complete');
    expect(complete).toEqual([{ type: 'complete', mimeType: 'audio/mp4', bytes: 9, durationMs: 200, reason: 'manual',
      peakLevelDbfs: expect.closeTo(-32, 1), sampleRate: 48000, channelCount: 1 }]);
    expect(JSON.stringify(complete)).not.toMatch(/private-device|first|last|blob/);
    expect(fake.track.stop).toHaveBeenCalledOnce();
  });

  it('keeps recording through silence in hold mode and sends only when released', async () => {
    const fake = environment();
    const capture = new BrowserVoiceCapture({ environment: fake.env, endpointing: 'manual' });
    let meter: MeterSnapshot | undefined;
    capture.subscribe(event => { if (event.type === 'meter') meter = event.snapshot; });
    const result = capture.start();
    await settle();
    await vi.advanceTimersByTimeAsync(6000); // A child may pause before speaking.
    expect(capture.state).toBe('recording');
    fake.context.analyser.level = -30;
    await vi.advanceTimersByTimeAsync(200);
    fake.context.analyser.level = -60;
    await vi.advanceTimersByTimeAsync(3000); // A pause must not end the held question.
    expect(capture.state).toBe('recording');
    expect(fake.recorder.stop).not.toHaveBeenCalled();
    expect(meter?.elapsedMs).toBe(9200);
    expect(meter?.levelDbfs).toBeCloseTo(-60);
    expect(meter?.decision).toBe(null);
    fake.recorder.emitData('question');
    expect(capture.send()).toBe(true);
    expect(capture.send()).toBe(false);
    fake.recorder.flush();
    expect(await result).toMatchObject({ reason: 'manual', durationMs: 9200 });
    expect(fake.track.stop).toHaveBeenCalledOnce();
  });

  it('cancels a hold released before microphone permission resolves, closing a late-granted stream', async () => {
    const permission = deferred<MediaStream>();
    const fake = environment(permission.promise);
    const capture = new BrowserVoiceCapture({ environment: fake.env, endpointing: 'manual' });
    const result = capture.start();
    const rejection = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    expect(capture.state).toBe('requesting_permission');
    expect(capture.send()).toBe(false);
    permission.resolve(fake.stream);
    await rejection;
    await settle();
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(fake.env.createRecorder).not.toHaveBeenCalled();
    expect(capture.state).toBe('idle');
  });

  it('does not upload an empty quick tap and never submits a hold at the recording limit', async () => {
    const quick = environment();
    const capture = new BrowserVoiceCapture({ environment: quick.env, endpointing: 'manual' });
    const short = capture.start();
    const noAudio = expect(short).rejects.toMatchObject({ code: 'NO_AUDIO' });
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    capture.send();
    quick.recorder.flush();
    await noAudio;
    expect(quick.track.stop).toHaveBeenCalledOnce();

    const long = environment();
    const second = new BrowserVoiceCapture({ environment: long.env, endpointing: 'manual' });
    const held = second.start();
    const limited = expect(held).rejects.toMatchObject({ code: 'RECORDING_LIMIT' });
    await settle();
    long.context.analyser.level = -30;
    await vi.advanceTimersByTimeAsync(30000);
    await limited;
    expect(second.state).toBe('idle');
    expect(second.send()).toBe(false);
    expect(long.track.stop).toHaveBeenCalledOnce();
  });

  it('uses one stream and actual MIME, waits for the final chunk, and manually sends quiet audio', async () => {
    const fake = environment();
    const capture = new BrowserVoiceCapture({ environment: fake.env });
    const result = capture.start();
    let resolved = false;
    void result.then(() => { resolved = true; });
    await settle();
    expect(fake.context.resume).toHaveBeenCalledOnce();
    expect(fake.env.getUserMedia).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    fake.recorder.emitData('first');
    expect(capture.send()).toBe(true);
    expect(capture.send()).toBe(false);
    await settle();
    expect(resolved).toBe(false);
    expect(fake.track.stop).not.toHaveBeenCalled();
    fake.recorder.flush();
    const audio = await result;
    expect(audio.mimeType).toBe('audio/mp4');
    expect(audio.blob.type).toBe('audio/mp4');
    expect(await audio.blob.text()).toBe('firstlast');
    expect(audio).toMatchObject({ reason: 'manual', durationMs: 200 });
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(capture.state).toBe('idle');
  });

  it('ignores final data and stop callbacks after Cancel, including during flush', async () => {
    const fake = environment();
    const capture = new BrowserVoiceCapture({ environment: fake.env });
    const result = capture.start();
    const rejection = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    capture.send();
    capture.cancel();
    fake.recorder.flush('should never upload');
    await rejection;
    expect(fake.track.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(capture.state).toBe('idle');
  });

  it('stops a stream granted after permission was canceled', async () => {
    const permission = deferred<MediaStream>();
    const fake = environment(permission.promise);
    const capture = new BrowserVoiceCapture({ environment: fake.env });
    const result = capture.start();
    const rejection = expect(result).rejects.toMatchObject({ code: 'CANCELED' });
    capture.cancel();
    permission.resolve(fake.stream);
    await rejection;
    await settle();
    expect(fake.track.stop).toHaveBeenCalledOnce();
    expect(fake.env.createRecorder).not.toHaveBeenCalled();
    expect(fake.context.close).toHaveBeenCalledOnce();
  });

  it('cancels on a hidden page or interrupted audio context instead of auto-submitting', async () => {
    for (const interruption of ['hidden', 'interrupted'] as const) {
      const fake = environment();
      const capture = new BrowserVoiceCapture({ environment: fake.env });
      const result = capture.start();
      const rejection = expect(result).rejects.toMatchObject({ code: 'CAPTURE_INTERRUPTED' });
      await settle();
      if (interruption === 'hidden') fake.hide();
      else { fake.context.state = 'interrupted'; fake.context.dispatchEvent(new Event('statechange')); }
      fake.recorder.flush();
      await rejection;
      expect(fake.track.stop).toHaveBeenCalledOnce();
    }
  });

  it('auto-finalizes only after confirmed signal and enough quiet; initial silence never uploads', async () => {
    const fake = environment();
    const capture = new BrowserVoiceCapture({ environment: fake.env });
    const result = capture.start();
    await settle();
    await vi.advanceTimersByTimeAsync(760);
    fake.context.analyser.level = -30;
    await vi.advanceTimersByTimeAsync(160);
    fake.context.analyser.level = -60;
    await vi.advanceTimersByTimeAsync(1500);
    expect(capture.state).toBe('recording');
    await vi.advanceTimersByTimeAsync(20);
    expect(capture.state).toBe('finalizing_capture');
    fake.recorder.flush();
    expect((await result).reason).toBe('silence');

    const quiet = environment();
    const second = new BrowserVoiceCapture({ environment: quiet.env });
    const secondResult = second.start();
    const rejection = expect(secondResult).rejects.toMatchObject({ code: 'NO_SIGNAL' });
    await settle();
    await vi.advanceTimersByTimeAsync(5800);
    await rejection;
    quiet.recorder.flush();
    expect(second.state).toBe('idle');
  });

  it('provides manual-only capture if the meter is unavailable and bounds a missing final event', async () => {
    const fake = environment();
    fake.context.createAnalyser = () => { throw new Error('unsupported meter'); };
    const capture = new BrowserVoiceCapture({ environment: fake.env });
    const events: string[] = [];
    capture.subscribe(event => { events.push(event.type); });
    const result = capture.start();
    const rejection = expect(result).rejects.toMatchObject({ code: 'RECORDER_TIMEOUT' });
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toContain('manual_only');
    expect(capture.send()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(fake.track.stop).toHaveBeenCalledOnce();
  });
});
