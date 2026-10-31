import { describe, expect, it } from 'vitest';
import { AdaptiveSilenceDetector, rmsDbfs } from '../src/detector.js';

function feed(detector: AdaptiveSilenceDetector, start: number, end: number, level: number, step = 20) {
  let snapshot = detector.snapshot;
  for (let time = start; time <= end; time += step) snapshot = detector.update(level, time);
  return snapshot;
}

describe('adaptive RMS detector', () => {
  it('calibrates despite a short loud click, confirms signal then waits a full silence interval', () => {
    const detector = new AdaptiveSilenceDetector();
    for (let time = 20; time <= 760; time += 20) detector.update(time === 400 ? -10 : -60, time);
    expect(detector.snapshot).toMatchObject({ phase: 'waiting', noiseFloorDbfs: -60, startThresholdDbfs: -48, endThresholdDbfs: -54 });
    feed(detector, 780, 880, -30);
    expect(detector.snapshot.hasSignal).toBe(false);
    detector.update(-30, 900);
    expect(detector.snapshot.hasSignal).toBe(true);
    feed(detector, 920, 2400, -60);
    expect(detector.snapshot.decision).toBeNull();
    expect(detector.update(-60, 2420).decision).toEqual({ action: 'submit', reason: 'silence' });
  });

  it('keeps between-threshold sounds in an active phrase and freezes its noise floor', () => {
    const detector = new AdaptiveSilenceDetector();
    feed(detector, 20, 760, -60);
    feed(detector, 780, 920, -30);
    feed(detector, 940, 1940, -70);
    expect(detector.update(-50, 1960).belowThresholdMs).toBe(0);
    feed(detector, 1980, 3460, -70);
    expect(detector.snapshot.decision).toBeNull();
    expect(detector.update(-70, 3480)).toMatchObject({ noiseFloorDbfs: -60, decision: { action: 'submit', reason: 'silence' } });
  });

  it('adapts to quiet changes before signal but does not learn a loud signal candidate as noise', () => {
    const detector = new AdaptiveSilenceDetector({ initialSilenceTimeoutMs: 10000 });
    feed(detector, 20, 760, -60);
    feed(detector, 780, 3740, -70);
    expect(detector.snapshot.noiseFloorDbfs).toBeLessThan(-65);
    const noise = detector.snapshot.noiseFloorDbfs;
    feed(detector, 3760, 4200, -30);
    expect(detector.snapshot).toMatchObject({ hasSignal: true, noiseFloorDbfs: noise });
  });

  it('discards short clicks, counts initial timeout after calibration and never submits silence', () => {
    const detector = new AdaptiveSilenceDetector();
    feed(detector, 20, 760, -60);
    feed(detector, 780, 840, -20);
    feed(detector, 860, 5740, -60);
    expect(detector.snapshot).toMatchObject({ hasSignal: false, decision: null });
    expect(detector.update(-60, 5760).decision).toEqual({ action: 'cancel', reason: 'no_signal' });
  });

  it('has a hard recording limit including calibration, and rejects gaps/backwards clocks', () => {
    const detector = new AdaptiveSilenceDetector({ maxRecordingMs: 2000 });
    feed(detector, 20, 760, -60);
    expect(feed(detector, 780, 2000, -20).decision).toEqual({ action: 'submit', reason: 'max_duration' });
    const gap = new AdaptiveSilenceDetector();
    gap.update(-60, 20);
    expect(gap.update(-60, 271).decision).toEqual({ action: 'cancel', reason: 'analysis_gap' });
    const backwards = new AdaptiveSilenceDetector();
    backwards.update(-60, 20);
    expect(backwards.update(-60, 19).decision).toEqual({ action: 'cancel', reason: 'invalid_clock' });
  });

  it('computes RMS, handles digital silence, and rejects contradictory hysteresis', () => {
    expect(rmsDbfs(new Float32Array([0.1, -0.1]))).toBeCloseTo(-20);
    expect(rmsDbfs(new Float32Array(1024))).toBe(-120);
    expect(() => new AdaptiveSilenceDetector({ endMarginDb: 20 })).toThrow(RangeError);
    expect(() => rmsDbfs([NaN])).toThrow(RangeError);
  });
});
