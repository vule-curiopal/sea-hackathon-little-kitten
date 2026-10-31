/** Stateful area resampling to mono 16kHz PCM16. Sample/time continuity survives arbitrary worklet blocks. */
export class Pcm16Encoder {
  private readonly ratio: number;
  private weighted = 0;
  private weight = 0;
  private chunk: number[] = [];
  constructor(sampleRate: number, private readonly chunkSamples = 3200) {
    if (!Number.isFinite(sampleRate) || sampleRate < 16000 || !Number.isInteger(chunkSamples) || chunkSamples < 1) {
      throw new RangeError('Unsupported PCM encoder configuration');
    }
    this.ratio = sampleRate / 16000;
  }
  push(samples: Float32Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (const sample of samples) {
      if (!Number.isFinite(sample)) throw new RangeError('Invalid audio sample');
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.weighted += sample * take;
        this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          this.chunk.push(this.weighted / this.ratio);
          this.weighted = 0; this.weight = 0;
          if (this.chunk.length === this.chunkSamples) chunks.push(this.take());
        }
      }
    }
    return chunks;
  }
  flush(): Uint8Array | undefined {
    if (this.weight > 1e-9) { this.chunk.push(this.weighted / this.weight); this.weight = 0; this.weighted = 0; }
    return this.chunk.length ? this.take() : undefined;
  }
  private take(): Uint8Array {
    const result = new Uint8Array(this.chunk.length * 2);
    const view = new DataView(result.buffer);
    this.chunk.forEach((sample, i) => {
      const clipped = Math.min(1, Math.max(-1, sample));
      view.setInt16(i * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
    });
    this.chunk = [];
    return result;
  }
}

// Bundled with the client: no third-party runtime, model download or absolute asset path.
export const PCM_WORKLET = `
class MiuAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(2048); this.length = 0;
    this.port.onmessage = event => { if (event.data === 'flush') {
      this.flush(); this.port.postMessage({type:'flushed'});
    }};
  }
  flush() {
    if (!this.length) return;
    const samples = this.samples.slice(0, this.length); this.length = 0;
    this.port.postMessage({type:'samples', samples}, [samples.buffer]);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) for (let i=0; i<channel.length; i++) {
      this.samples[this.length++] = channel[i];
      if (this.length === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor('miu-audio-capture', MiuAudioCapture);
`;
