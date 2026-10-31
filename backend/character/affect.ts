import { createHash } from 'node:crypto';
import {
  AFFECT_POLICY_VERSION,
  type AffectLearningUpdate, type AffectMood, type AffectPresentation, type AffectSignal,
  type AffectSnapshot, type AffectVector, type CharacterAffectState,
  type DailyAffectInput, type PreviewAffectInput, type PreviewAffectResult,
} from '../shared/affect.js';

const HALF_LIFE_MINUTES = 30;
const MAX_SIGNAL_STRENGTH = .35;
const MAX_SIGNAL_CHANGE = .15;
const MOODS: readonly AffectMood[] = ['content', 'curious', 'mellow'];
const DAILY_VECTORS: Readonly<Record<AffectMood, AffectVector>> = {
  content: { valence: .55, energy: .53 },
  curious: { valence: .60, energy: .73 },
  mellow: { valence: .40, energy: .31 },
};
const DISTRESS = new Set(['sad', 'sadness', 'scared', 'afraid', 'fear', 'angry', 'anger', 'frustrated', 'frustration', 'disappointed', 'disappointment', 'upset']);
const FATIGUE = new Set(['tired', 'sleepy', 'exhausted', 'fatigue']);
const PROTECTED_INTENTS = new Set(['forget', 'correct', 'stop', 'unsafe']);
const ENGAGEMENT_INTENTS = new Set(['chat', 'share', 'story', 'continue_story']);
const SIGNAL_KINDS = new Set(['positive', 'calming', 'fatigue', 'engagement']);
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const copy = (vector: AffectVector): AffectVector => ({ valence: vector.valence, energy: vector.energy });

function number(value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError('invalid_affect_number');
}
function vector(value: AffectVector): void {
  if (!value || typeof value !== 'object') throw new RangeError('invalid_affect_vector');
  number(value.valence, -1, 1); number(value.energy, 0, 1);
}
function localDate(value: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new RangeError('invalid_affect_date');
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || date.toISOString().slice(0, 10) !== value) throw new RangeError('invalid_affect_date');
}
function timestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new RangeError('invalid_affect_timestamp');
  }
  localDate(value.slice(0, 10));
  const result = Date.parse(value);
  if (!Number.isFinite(result) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    throw new RangeError('invalid_affect_timestamp');
  }
  return result;
}
function identifier(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RangeError('invalid_affect_identifier');
}
function energy(value: number | undefined): number {
  const result = value ?? .5; number(result, 0, 1); return result;
}
function validateState(state: CharacterAffectState): void {
  if (!state || state.policyVersion !== AFFECT_POLICY_VERSION || !MOODS.includes(state.dailyMood)) throw new RangeError('invalid_affect_state');
  localDate(state.localDate); vector(state.baseline); vector(state.conversation); timestamp(state.updatedAt);
  if (state.lastInteractionAt !== null) timestamp(state.lastInteractionAt);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new RangeError('invalid_affect_revision');
}
function validateSignal(signal: AffectSignal): void {
  if (!signal || !SIGNAL_KINDS.has(signal.kind)) throw new RangeError('invalid_affect_signal');
  vector(signal.target); number(signal.strength, 0, MAX_SIGNAL_STRENGTH);
}
function unit(parts: readonly string[]): number {
  return createHash('sha256').update(JSON.stringify(parts)).digest().readUInt32BE(0) / 0xffff_ffff;
}
function seededVariation(parts: readonly string[]): AffectVector {
  return { valence: (unit([...parts, 'valence']) * 2 - 1) * .05, energy: (unit([...parts, 'energy']) * 2 - 1) * .05 };
}
function bounded(value: AffectVector): AffectVector {
  return { valence: clamp(value.valence, -1, 1), energy: clamp(value.energy, 0, 1) };
}
function decayed(state: CharacterAffectState, effectiveNow: string): AffectVector {
  const minutes = Math.max(0, timestamp(effectiveNow) - timestamp(state.updatedAt)) / 60_000;
  const remaining = 2 ** (-minutes / HALF_LIFE_MINUTES);
  return bounded({
    valence: state.baseline.valence + (state.conversation.valence - state.baseline.valence) * remaining,
    energy: state.baseline.energy + (state.conversation.energy - state.baseline.energy) * remaining,
  });
}
function smooth(previous: AffectVector, signal: AffectSignal): AffectVector {
  return bounded({
    valence: previous.valence + clamp((signal.target.valence - previous.valence) * signal.strength, -MAX_SIGNAL_CHANGE, MAX_SIGNAL_CHANGE),
    energy: previous.energy + clamp((signal.target.energy - previous.energy) * signal.strength, -MAX_SIGNAL_CHANGE, MAX_SIGNAL_CHANGE),
  });
}
function blend(baseline: AffectVector, conversation: AffectVector): AffectVector {
  return bounded({ valence: .65 * baseline.valence + .35 * conversation.valence, energy: .65 * baseline.energy + .35 * conversation.energy });
}
function mood(value: AffectVector): AffectMood {
  if (value.energy < .42 || value.valence < .20) return 'mellow';
  return value.energy >= .64 ? 'curious' : 'content';
}
function stateCopy(state: CharacterAffectState): CharacterAffectState {
  return { ...state, baseline: copy(state.baseline), conversation: copy(state.conversation) };
}

/** Seed once per local day; persistence keeps this independent baseline unchanged. */
export function createDailyAffect(input: DailyAffectInput): CharacterAffectState {
  identifier(input.profileId); localDate(input.localDate);
  const now = timestamp(input.effectiveNow);
  const personalityEnergy = energy(input.personalityEnergy);
  const seed = [AFFECT_POLICY_VERSION, input.profileId, input.localDate, 'daily'];
  const dailyMood = MOODS[Math.min(MOODS.length - 1, Math.floor(unit(seed) * MOODS.length))]!;
  const baseline = bounded({
    valence: DAILY_VECTORS[dailyMood].valence,
    energy: DAILY_VECTORS[dailyMood].energy + (personalityEnergy - .5) * .12,
  });
  return {
    policyVersion: AFFECT_POLICY_VERSION, localDate: input.localDate, dailyMood,
    baseline, conversation: copy(baseline), updatedAt: new Date(now).toISOString(),
    lastInteractionAt: null, revision: 0,
  };
}

/** Read-time decay is derived only; the saved vector/timestamp and revision stay intact. */
export function snapshotAffect(state: CharacterAffectState, effectiveNow: string): AffectSnapshot {
  validateState(state);
  const current = blend(state.baseline, decayed(state, effectiveNow));
  return { ...stateCopy(state), current, currentMood: mood(current), decayHalfLifeMinutes: HALF_LIFE_MINUTES };
}

function observedSignal(input: PreviewAffectInput, distress: boolean): AffectSignal | undefined {
  const feeling = input.observation.statedFeeling?.trim().toLowerCase();
  if (distress) return { kind: 'calming', target: { valence: .35, energy: .25 }, strength: .35 };
  if (feeling === 'happy' || feeling === 'happiness' || feeling === 'excited') return { kind: 'positive', target: { valence: .85, energy: .80 }, strength: .35 };
  if (feeling && FATIGUE.has(feeling)) return { kind: 'fatigue', target: { valence: .40, energy: .15 }, strength: .30 };
  if (ENGAGEMENT_INTENTS.has(input.observation.intent)) return { kind: 'engagement', target: { valence: .55, energy: .58 + (energy(input.personalityEnergy) - .5) * .12 }, strength: .12 };
  return undefined;
}
function defaultTone(value: AffectVector, currentMood: AffectMood): Pick<AffectPresentation, 'emotion' | 'delivery' | 'gesture'> {
  if (value.valence < .20) return { emotion: 'gentle', delivery: 'gentle', gesture: 'slow_blink' };
  if (value.energy <= .28) return { emotion: 'sleepy', delivery: 'sleepy', gesture: 'yawn' };
  if (currentMood === 'curious') return { emotion: 'curious', delivery: 'playful', gesture: 'head_tilt' };
  if (currentMood === 'mellow') return { emotion: 'neutral', delivery: 'gentle', gesture: 'slow_blink' };
  return { emotion: value.valence >= .55 ? 'happy' : 'neutral', delivery: 'normal', gesture: value.energy >= .68 ? 'small_bounce' : 'none' };
}

/** No I/O or writes. The caller may commit learning only after completed delivery. */
export function previewAffect(input: PreviewAffectInput): PreviewAffectResult {
  identifier(input.profileId); identifier(input.turnId); validateState(input.state); localDate(input.localDate); timestamp(input.effectiveNow); energy(input.personalityEnergy);
  const observation = input.observation;
  if (!observation || typeof observation.intent !== 'string' || !observation.intent || observation.intent.length > 64
    || !(observation.statedFeeling === null || typeof observation.statedFeeling === 'string' && observation.statedFeeling.length <= 64)
    || typeof observation.uncertain !== 'boolean' || typeof observation.suppressLearning !== 'boolean'
    || typeof input.comfortActive !== 'boolean' || input.protectedTurn !== undefined && typeof input.protectedTurn !== 'boolean'
    || !['morning', 'daytime', 'evening', 'bedtime'].includes(input.rhythm)) throw new RangeError('invalid_affect_observation');
  // The store owns day rollover; a preview must never silently replace a baseline.
  if (input.localDate !== input.state.localDate) throw new RangeError('affect_day_mismatch');
  if (timestamp(input.effectiveNow) < timestamp(input.state.updatedAt)) throw new RangeError('stale_affect_preview');
  const feeling = observation.statedFeeling?.trim().toLowerCase();
  const distress = !!feeling && DISTRESS.has(feeling);
  const comfort = input.comfortActive || distress;
  const protectedTurn = input.protectedTurn === true || PROTECTED_INTENTS.has(observation.intent);
  const signal = protectedTurn ? undefined : observedSignal(input, comfort);
  const previous = decayed(input.state, input.effectiveNow);
  const proposed = signal ? smooth(previous, signal) : previous;
  let beforeVariation = blend(input.state.baseline, proposed);
  let reason: AffectPresentation['reason'] = 'blended';
  if (protectedTurn) reason = 'protected_turn';
  else if (comfort) { beforeVariation = { ...beforeVariation, energy: Math.min(beforeVariation.energy, .30) }; reason = 'comfort_override'; }
  else if (input.rhythm === 'bedtime') { beforeVariation = { ...beforeVariation, energy: Math.min(beforeVariation.energy, .20) }; reason = 'bedtime_override'; }
  else if (input.rhythm === 'evening') { beforeVariation = { ...beforeVariation, energy: Math.min(.52, beforeVariation.energy * .85) }; reason = 'evening_adjustment'; }
  // Label and tone use the pre-jitter blend, so random variation cannot flip either.
  const currentMood = mood(beforeVariation);
  const variation = protectedTurn ? { valence: 0, energy: 0 } : seededVariation([AFFECT_POLICY_VERSION, input.profileId, input.state.localDate, input.turnId, 'turn']);
  const current = bounded({ valence: beforeVariation.valence + variation.valence, energy: beforeVariation.energy + variation.energy });
  let tone = defaultTone(beforeVariation, currentMood);
  if (protectedTurn) tone = { emotion: comfort ? 'gentle' : 'neutral', delivery: comfort ? 'gentle' : 'normal', gesture: 'none' };
  else if (comfort) tone = { emotion: 'gentle', delivery: 'gentle', gesture: 'slow_blink' };
  else if (input.rhythm === 'bedtime') tone = { emotion: 'sleepy', delivery: 'sleepy', gesture: 'yawn' };
  return {
    presentation: { policyVersion: AFFECT_POLICY_VERSION, dailyMood: input.state.dailyMood, currentMood,
      valence: current.valence, energy: current.energy, variation, reason, ...tone },
    ...(signal && !observation.uncertain && !observation.suppressLearning ? {
      learning: { localDate: input.state.localDate, observedAt: new Date(timestamp(input.effectiveNow)).toISOString(), signal: { ...signal, target: copy(signal.target) } },
    } : {}),
  };
}

/** Storage supplies deduplication, delivery authorization, and real-time expiry. */
export function applyAffectSignal(state: CharacterAffectState, update: AffectLearningUpdate, realNow: string): CharacterAffectState {
  validateState(state); timestamp(realNow);
  if (!update) throw new RangeError('invalid_affect_update');
  localDate(update.localDate); validateSignal(update.signal);
  if (update.localDate !== state.localDate) throw new RangeError('affect_day_mismatch');
  const observedAt = timestamp(update.observedAt);
  if (observedAt < timestamp(state.updatedAt)) throw new RangeError('stale_affect_update');
  if (update.signal.strength === 0) return stateCopy(state);
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('invalid_affect_revision');
  return {
    ...stateCopy(state), conversation: smooth(decayed(state, update.observedAt), update.signal),
    updatedAt: new Date(observedAt).toISOString(), lastInteractionAt: new Date(timestamp(realNow)).toISOString(), revision: state.revision + 1,
  };
}
