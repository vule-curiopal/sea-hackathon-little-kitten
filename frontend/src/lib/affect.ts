/** Server-owned fictional character state. Cosmetic randomness never changes it. */
export type AffectMood = 'content' | 'curious' | 'mellow';
export type AffectVector = { valence: number; energy: number };
export type AffectSnapshot = {
  policyVersion: 'affect-v1'; localDate: string; dailyMood: AffectMood;
  baseline: AffectVector; conversation: AffectVector; current: AffectVector;
  updatedAt: string; lastInteractionAt: string | null; revision: number;
  currentMood: AffectMood; decayHalfLifeMinutes: number;
};
export type AffectPresentation = {
  policyVersion: 'affect-v1'; dailyMood: AffectMood; currentMood: AffectMood;
  valence: number; energy: number; variation: AffectVector;
  reason: 'blended' | 'comfort_override' | 'bedtime_override' | 'evening_adjustment' | 'protected_turn';
  emotion: 'neutral' | 'happy' | 'curious' | 'gentle' | 'sleepy';
  delivery: 'gentle' | 'normal' | 'playful' | 'sleepy';
  gesture: 'none' | 'head_tilt' | 'slow_blink' | 'small_bounce' | 'yawn';
};
export type IdleAffect = { mood: AffectMood; energy: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const mood = (value: unknown): value is AffectMood => value === 'content' || value === 'curious' || value === 'mellow';
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const vector = (value: unknown): value is AffectVector => record(value) && bounded(value.valence, -1, 1) && bounded(value.energy, 0, 1);

/** Optional/invalid/unknown-version fields leave older rendering available. */
export function readAffectSnapshot(value: unknown): AffectSnapshot | undefined {
  if (!record(value) || value.policyVersion !== 'affect-v1' || typeof value.localDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(value.localDate) || !Number.isFinite(Date.parse(value.localDate))
    || new Date(value.localDate).toISOString().slice(0, 10) !== value.localDate
    || !mood(value.dailyMood) || !mood(value.currentMood) || !vector(value.baseline)
    || !vector(value.conversation) || !vector(value.current) || !timestamp(value.updatedAt)
    || (value.lastInteractionAt !== null && !timestamp(value.lastInteractionAt))
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !bounded(value.decayHalfLifeMinutes, Number.MIN_VALUE, 10080)) return undefined;
  return value as AffectSnapshot;
}
export function readAffectPresentation(value: unknown): AffectPresentation | undefined {
  if (!record(value) || value.policyVersion !== 'affect-v1' || !mood(value.dailyMood) || !mood(value.currentMood)
    || !bounded(value.valence, -1, 1) || !bounded(value.energy, 0, 1) || !record(value.variation)
    || !bounded(value.variation.valence, -.05, .05) || !bounded(value.variation.energy, -.05, .05)
    || !['blended', 'comfort_override', 'bedtime_override', 'evening_adjustment', 'protected_turn'].includes(String(value.reason))
    || !['neutral', 'happy', 'curious', 'gentle', 'sleepy'].includes(String(value.emotion))
    || !['gentle', 'normal', 'playful', 'sleepy'].includes(String(value.delivery))
    || !['none', 'head_tilt', 'slow_blink', 'small_bounce', 'yawn'].includes(String(value.gesture))) return undefined;
  return value as AffectPresentation;
}
export function affectMoodLabel(value: AffectMood, language: 'vi' | 'en'): string {
  return language === 'vi' ? { content: 'Vui nhẹ', curious: 'Tò mò', mellow: 'Êm dịu' }[value]
    : { content: 'Content', curious: 'Curious', mellow: 'Mellow' }[value];
}
