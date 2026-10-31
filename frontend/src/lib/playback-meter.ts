import type { PlaybackEnvironment } from '@miu/voice-client';

/** Measures only the approved reply's output audio. It never opens the microphone. */
export function createPlaybackMeter(onLevel: (level: number) => void) {
  let context: AudioContext | null = null;
  let frame = 0;
  let disposed = false;
  const stops = new Set<() => void>();
  function unlock() {
    if (disposed) return;
    try {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!context && Constructor) context = new Constructor();
      void context?.resume().catch(() => {});
    } catch { /* Output audio still works when analysis is unavailable. */ }
  }
  const environment: PlaybackEnvironment = {
    createAudio() {
      const audio = new Audio();
      let source: MediaElementAudioSourceNode | undefined;
      let analyser: AnalyserNode | undefined;
      let smoothed = 0;
      const stop = () => { cancelAnimationFrame(frame); onLevel(0); smoothed = 0; };
      if (context && context.state !== 'closed') {
        try {
          source = context.createMediaElementSource(audio);
          analyser = context.createAnalyser(); analyser.fftSize = 256;
          source.connect(analyser); analyser.connect(context.destination);
        } catch { analyser = undefined; try { source?.disconnect(); source?.connect(context.destination); } catch { /* Optional analysis. */ } }
      }
      const samples = new Uint8Array(256);
      const sample = () => {
        if (disposed || audio.paused || audio.ended || !analyser) { stop(); return; }
        analyser.getByteTimeDomainData(samples);
        const energy = samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length;
        const level = Math.min(1, Math.max(0, Math.sqrt(energy) * 4.5 - .025));
        smoothed = smoothed * .4 + level * .6;
        onLevel(smoothed);
        frame = requestAnimationFrame(sample);
      };
      audio.addEventListener('playing', sample);
      audio.addEventListener('pause', stop);
      audio.addEventListener('ended', stop);
      audio.addEventListener('emptied', () => { stop(); source?.disconnect(); analyser?.disconnect(); stops.delete(stop); }, { once: true });
      stops.add(stop);
      return audio;
    },
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url),
    decodeBase64: value => atob(value),
  };
  return {
    environment, unlock,
    dispose() { disposed = true; stops.forEach(stop => stop()); stops.clear(); void context?.close().catch(() => {}); },
  };
}
