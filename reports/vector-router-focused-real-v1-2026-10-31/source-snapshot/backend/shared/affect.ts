/** Miu's fictional affect, never a psychological profile of the child. */
export const AFFECT_POLICY_VERSION = 'affect-v1' as const;
export type AffectMood = 'content' | 'curious' | 'mellow';
export interface AffectVector { valence: number; energy: number }

export interface CharacterAffectState {
  policyVersion: typeof AFFECT_POLICY_VERSION;
  localDate: string;
  dailyMood: AffectMood;
  baseline: AffectVector;
  conversation: AffectVector;
  /** Narrative time of the latest committed conversation adjustment. */
  updatedAt: string;
  /** Actual wall time, used only for retention. */
  lastInteractionAt: string | null;
  revision: number;
}

export interface AffectSnapshot extends CharacterAffectState {
  current: AffectVector;
  currentMood: AffectMood;
  decayHalfLifeMinutes: number;
}

export interface AffectSignal {
  kind: 'positive' | 'calming' | 'fatigue' | 'engagement';
  target: AffectVector;
  strength: number;
}

/** Internal server-owned input. No source text or child-emotion label is stored. */
export interface AffectLearningUpdate {
  localDate: string;
  observedAt: string;
  signal: AffectSignal;
}

export interface AffectObservation {
  intent: string;
  statedFeeling: string | null;
  uncertain: boolean;
  suppressLearning: boolean;
}

export interface AffectPresentation {
  policyVersion: typeof AFFECT_POLICY_VERSION;
  dailyMood: AffectMood;
  currentMood: AffectMood;
  valence: number;
  energy: number;
  variation: AffectVector;
  reason: 'blended' | 'comfort_override' | 'bedtime_override' | 'evening_adjustment' | 'protected_turn';
  emotion: 'neutral' | 'happy' | 'curious' | 'gentle' | 'sleepy';
  delivery: 'gentle' | 'normal' | 'playful' | 'sleepy';
  gesture: 'none' | 'head_tilt' | 'slow_blink' | 'small_bounce' | 'yawn';
}

export interface DailyAffectInput {
  profileId: string;
  localDate: string;
  effectiveNow: string;
  personalityEnergy?: number;
}

export interface PreviewAffectInput {
  profileId: string;
  turnId: string;
  state: CharacterAffectState;
  observation: AffectObservation;
  /** Explicit profile-local date; do not derive it by slicing the UTC timestamp. */
  localDate: string;
  effectiveNow: string;
  rhythm: 'morning' | 'daytime' | 'evening' | 'bedtime';
  comfortActive: boolean;
  /** Operations and safety branches retain their existing explicit tone. */
  protectedTurn?: boolean;
  personalityEnergy?: number;
}

export interface PreviewAffectResult {
  presentation: AffectPresentation;
  /** Undefined for no-save, uncertainty, privacy/safety operations, or no signal. */
  learning?: AffectLearningUpdate;
}
