import { describe, expect, it } from 'vitest';
import { Pcm16Encoder } from '../src/realtime/pcm.js';

function encode(rate: number, samples: Float32Array, blockSize: number): Buffer {
  const encoder = new Pcm16Encoder(rate); const chunks: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += blockSize) chunks.push(...encoder.push(samples.subarray(i, i + blockSize)));
  const final = encoder.flush(); if (final) chunks.push(final);
  return Buffer.concat(chunks);
}
describe('streaming PCM encoder', () => {
  it.each([16000, 44100, 48000])('preserves one second and block continuity at %i Hz', rate => {
    const samples = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin(i * 2 * Math.PI * 440 / rate));
    const whole = encode(rate, samples, samples.length), blocked = encode(rate, samples, 128);
    expect(blocked.length).toBe(32000); expect(blocked).toEqual(whole);
  });
  it('clips finite samples and encodes signed little-endian PCM', () => {
    const bytes = encode(16000, new Float32Array([-2, 0, 2]), 1);
    expect([bytes.readInt16LE(0), bytes.readInt16LE(2), bytes.readInt16LE(4)]).toEqual([-32768, 0, 32767]);
  });
  it('keeps the last fractional sample and rejects invalid inputs', () => {
    const encoder = new Pcm16Encoder(48000);
    expect(encoder.push(new Float32Array([0.5]))).toEqual([]); expect(encoder.flush()?.length).toBe(2);
    expect(encoder.flush()).toBeUndefined(); expect(() => encoder.push(new Float32Array([NaN]))).toThrow();
    expect(() => new Pcm16Encoder(0)).toThrow();
  });
});
