import { LIMITS } from '@miu/voice-contracts';

export interface AdaptiveSilenceConfig {
  calibrationMs: number;
  maxAnalysisGapMs: number;
  noisePercentile: number;
  noiseFloorMinDbfs: number;
  noiseFloorMaxDbfs: number;
  noiseWindowMs: number;
  noiseAdaptationMs: number;
  startMarginDb: number;
  endMarginDb: number;
  startMinDbfs: number;
  startMaxDbfs: number;
  endMinDbfs: number;
  endMaxDbfs: number;
  minSignalMs: number;
  endSilenceMs: number;
  initialSilenceTimeoutMs: number;
  maxRecordingMs: number;
}

export const DEFAULT_DETECTOR_CONFIG: Readonly<AdaptiveSilenceConfig> = Object.freeze({
  calibrationMs: 750,
  maxAnalysisGapMs: 250,
  noisePercentile: 20,
  noiseFloorMinDbfs: -80,
  noiseFloorMaxDbfs: -25,
  noiseWindowMs: 2000,
  noiseAdaptationMs: 1000,
  startMarginDb: 12,
  endMarginDb: 6,
  startMinDbfs: -55,
  startMaxDbfs: -15,
  endMinDbfs: -61,
  endMaxDbfs: -21,
  minSignalMs: 120,
  endSilenceMs: 1500,
  initialSilenceTimeoutMs: 5000,
  maxRecordingMs: LIMITS.recordingMs,
});

export type DetectorDecision =
  | { action: 'submit'; reason: 'silence' | 'max_duration' }
  | { action: 'cancel'; reason: 'no_signal' | 'analysis_gap' | 'invalid_clock' | 'invalid_level' };

export interface MeterSnapshot {
  phase: 'calibrating' | 'waiting' | 'signal' | 'ended';
  timeMs: number;
  elapsedMs: number;
  levelDbfs: number;
  noiseFloorDbfs: number;
  startThresholdDbfs: number;
  endThresholdDbfs: number;
  hasSignal: boolean;
  belowThresholdMs: number;
  decision: DetectorDecision | null;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function percentile(values: readonly number[], percent: number): number {
  if (!values.length) return -80;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percent / 100;
  const lower = Math.floor(position);
  const a = sorted[lower]!;
  return a + (sorted[Math.ceil(position)]! - a) * (position - lower);
}

function validateConfig(config: AdaptiveSilenceConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value)) throw new RangeError(`${key} must be finite.`);
  }
  for (const key of [
    'maxAnalysisGapMs', 'noiseWindowMs', 'noiseAdaptationMs', 'minSignalMs',
    'endSilenceMs', 'initialSilenceTimeoutMs', 'maxRecordingMs',
  ] as const) {
    if (config[key] <= 0) throw new RangeError(`${key} must be positive.`);
  }
  if (config.calibrationMs < 0 || config.calibrationMs >= config.maxRecordingMs) {
    throw new RangeError('calibrationMs must fit within a recording.');
  }
  if (config.noisePercentile < 0 || config.noisePercentile > 100) throw new RangeError('Invalid noisePercentile.');
  if (config.noiseFloorMinDbfs >= config.noiseFloorMaxDbfs
    || config.startMinDbfs > config.startMaxDbfs || config.endMinDbfs > config.endMaxDbfs
    || config.endMarginDb >= config.startMarginDb) throw new RangeError('Invalid detector thresholds.');
  // Clamp transitions are piecewise linear; verify their breakpoints as well as the limits.
  const points = [config.noiseFloorMinDbfs, config.noiseFloorMaxDbfs,
    config.startMinDbfs - config.startMarginDb, config.startMaxDbfs - config.startMarginDb,
    config.endMinDbfs - config.endMarginDb, config.endMaxDbfs - config.endMarginDb];
  for (const point of points) {
    const noise = clamp(point, config.noiseFloorMinDbfs, config.noiseFloorMaxDbfs);
    if (clamp(noise + config.endMarginDb, config.endMinDbfs, config.endMaxDbfs)
      >= clamp(noise + config.startMarginDb, config.startMinDbfs, config.startMaxDbfs)) {
      throw new RangeError('The end threshold must remain below the start threshold.');
    }
  }
}

export function rmsDbfs(samples: ArrayLike<number>): number {
  if (!samples.length) throw new RangeError('Audio samples are empty.');
  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    if (!Number.isFinite(sample)) throw new RangeError('Audio samples must be finite.');
    sum += sample * sample;
  }
  return 20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1e-6));
}

/** Pure local energy detector. Its signal state is not a claim that speech was recognized. */
export class AdaptiveSilenceDetector {
  readonly config: Readonly<AdaptiveSilenceConfig>;
  private readonly calibration: number[] = [];
  private quietHistory: { at: number; level: number }[] = [];
  private calibratedAt: number | null = null;
  private candidateAt: number | null = null;
  private quietAt: number | null = null;
  private lastAt: number;
  private noise = -80;
  private signal = false;
  private decision: DetectorDecision | null = null;
  private lastLevel = -120;

  constructor(config: Partial<AdaptiveSilenceConfig> = {}, readonly startedAtMs = 0) {
    if (!Number.isFinite(startedAtMs)) throw new RangeError('startedAtMs must be finite.');
    this.config = Object.freeze({ ...DEFAULT_DETECTOR_CONFIG, ...config });
    validateConfig(this.config);
    this.lastAt = startedAtMs;
    if (this.config.calibrationMs === 0) this.calibratedAt = startedAtMs;
  }

  get snapshot(): MeterSnapshot {
    const start = clamp(this.noise + this.config.startMarginDb, this.config.startMinDbfs, this.config.startMaxDbfs);
    const end = clamp(this.noise + this.config.endMarginDb, this.config.endMinDbfs, this.config.endMaxDbfs);
    return {
      phase: this.decision ? 'ended' : this.calibratedAt === null ? 'calibrating' : this.signal ? 'signal' : 'waiting',
      timeMs: this.lastAt, elapsedMs: Math.max(0, this.lastAt - this.startedAtMs), levelDbfs: this.lastLevel,
      noiseFloorDbfs: this.noise, startThresholdDbfs: start, endThresholdDbfs: end,
      hasSignal: this.signal, belowThresholdMs: this.quietAt === null ? 0 : this.lastAt - this.quietAt,
      decision: this.decision ? { ...this.decision } : null,
    };
  }

  update(levelDbfs: number, nowMs: number): MeterSnapshot {
    if (this.decision) return this.snapshot;
    if (!Number.isFinite(nowMs) || nowMs < this.lastAt) {
      this.decision = { action: 'cancel', reason: 'invalid_clock' };
      return this.snapshot;
    }
    const delta = nowMs - this.lastAt;
    this.lastAt = nowMs;
    if (delta > this.config.maxAnalysisGapMs) {
      this.decision = { action: 'cancel', reason: 'analysis_gap' };
      return this.snapshot;
    }
    if (!Number.isFinite(levelDbfs)) {
      this.decision = { action: 'cancel', reason: 'invalid_level' };
      return this.snapshot;
    }
    this.lastLevel = levelDbfs;
    if (this.calibratedAt === null) {
      this.calibration.push(levelDbfs);
      if (nowMs - this.startedAtMs >= this.config.calibrationMs) {
        this.noise = clamp(percentile(this.calibration, this.config.noisePercentile),
          this.config.noiseFloorMinDbfs, this.config.noiseFloorMaxDbfs);
        this.calibratedAt = nowMs;
        this.quietHistory = this.calibration.map(level => ({ at: nowMs, level }));
        this.calibration.length = 0;
      }
    } else if (!this.signal) {
      const thresholds = this.snapshot;
      if (levelDbfs >= thresholds.startThresholdDbfs) {
        this.candidateAt ??= nowMs;
        if (nowMs - this.candidateAt >= this.config.minSignalMs) this.signal = true;
      } else {
        this.candidateAt = null;
        if (levelDbfs < thresholds.endThresholdDbfs) {
          this.quietHistory = this.quietHistory.filter(item => item.at >= nowMs - this.config.noiseWindowMs);
          this.quietHistory.push({ at: nowMs, level: levelDbfs });
          const target = clamp(percentile(this.quietHistory.map(item => item.level), this.config.noisePercentile),
            this.config.noiseFloorMinDbfs, this.config.noiseFloorMaxDbfs);
          this.noise += (target - this.noise) * (1 - Math.exp(-delta / this.config.noiseAdaptationMs));
        }
      }
    } else if (levelDbfs < this.snapshot.endThresholdDbfs) {
      this.quietAt ??= nowMs;
      if (nowMs - this.quietAt >= this.config.endSilenceMs) this.decision = { action: 'submit', reason: 'silence' };
    } else {
      this.quietAt = null;
    }
    if (!this.decision && nowMs - this.startedAtMs >= this.config.maxRecordingMs) {
      this.decision = this.signal ? { action: 'submit', reason: 'max_duration' } : { action: 'cancel', reason: 'no_signal' };
    }
    if (!this.decision && !this.signal && this.calibratedAt !== null
      && nowMs - this.calibratedAt >= this.config.initialSilenceTimeoutMs) {
      this.decision = { action: 'cancel', reason: 'no_signal' };
    }
    return this.snapshot;
  }
}
