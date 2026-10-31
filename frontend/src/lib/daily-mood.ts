import type { Emotion } from './miu-pose.ts';
import type { CatActivity } from './miu-behavior.ts';
import type { Phase } from './conversation.ts';

export const moodFeelings = ['happy', 'curious', 'calm', 'love', 'sad', 'sleepy', 'sulky'] as const;
export type MoodFeeling = typeof moodFeelings[number];
export type EmotionLevels = Record<MoodFeeling, number>;
export type DailyMood = { version: 1; profile: string; date: string; levels: EmotionLevels; feeling: MoodFeeling };
export type TurnMood = { profile: string; date: string; emotion: Emotion; intensity: number; levels: EmotionLevels; comfort: boolean };
export type FeelingPresentation = { emotion: Emotion; intensity: number; comfort: boolean };

const themes: readonly EmotionLevels[] = [
  { happy: 78, curious: 60, calm: 55, love: 65, sad: 8, sleepy: 18, sulky: 9 },
  { happy: 62, curious: 84, calm: 50, love: 60, sad: 12, sleepy: 24, sulky: 8 },
  { happy: 50, curious: 44, calm: 80, love: 75, sad: 17, sleepy: 49, sulky: 6 },
  { happy: 40, curious: 48, calm: 84, love: 66, sad: 31, sleepy: 37, sulky: 12 },
  { happy: 85, curious: 72, calm: 43, love: 67, sad: 10, sleepy: 18, sulky: 22 },
];
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
function hash(value: string) {
  let result = 2166136261;
  for (const letter of value) result = Math.imul(result ^ letter.charCodeAt(0), 16777619);
  return result >>> 0;
}
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function dominantFeeling(levels: EmotionLevels): MoodFeeling {
  return moodFeelings.reduce((best, feeling) => levels[feeling] > levels[best] ? feeling : best, 'calm' as MoodFeeling);
}
export function feelingEmotion(feeling: MoodFeeling): Emotion { return feeling === 'calm' ? 'neutral' : feeling; }
export function feelingForEmotion(emotion: Emotion): MoodFeeling {
  if (['excited', 'laughing', 'wink'].includes(emotion)) return 'happy';
  if (['thinking', 'confused', 'surprised'].includes(emotion)) return 'curious';
  if (emotion === 'shy') return 'love';
  return moodFeelings.includes(emotion as MoodFeeling) ? emotion as MoodFeeling : 'calm';
}

/** Fictional Miu state only. A local date and profile select one stable day. */
export function createDailyMood(profile: string, date: string): DailyMood {
  const seed = hash(`miu-daily-v1:${profile}:${date}`);
  const theme = themes[seed % themes.length];
  const levels = Object.fromEntries(moodFeelings.map(feeling => [feeling,
    clamp(theme[feeling] + hash(`${seed}:${feeling}`) % 17 - 8, 3, 94),
  ])) as EmotionLevels;
  return { version: 1, profile, date, levels, feeling: dominantFeeling(levels) };
}

export function restoreDailyMood(profile: string, date: string, stored: string | null): DailyMood {
  try {
    const value = JSON.parse(stored ?? 'null') as DailyMood | null;
    if (value?.version === 1 && value.profile === profile && value.date === date && value.levels
      && Object.keys(value.levels).length === moodFeelings.length
      && moodFeelings.every(feeling => typeof value.levels[feeling] === 'number' && Number.isFinite(value.levels[feeling]) && value.levels[feeling] >= 0 && value.levels[feeling] <= 100)) {
      return { version: 1, profile, date, levels: { ...value.levels }, feeling: dominantFeeling(value.levels) };
    }
  } catch { /* Corrupt or unavailable storage starts a valid day. */ }
  return createDailyMood(profile, date);
}

function normalized(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[’‘]/g, "'").toLowerCase();
}

/** Deterministic conversational cues; never an acoustic diagnosis or a stored child score. */
export function conversationMood(daily: DailyMood, message: string, fallback: Emotion = 'neutral', previous: TurnMood | null = null): TurnMood {
  const text = normalized(message);
  const released = /\b(?:i(?:'m| am| feel) (?:not|no longer) (?:sad|scared|afraid|lonely|worried)|i (?:feel|am) (?:better|okay|fine|happy)|i'm (?:okay|fine|happy|better))\b/.test(text)
    || /\b(?:minh|con|to|toi|em) (?:da |dang |rat )*(?:het buon|vui(?: lai)?|on(?: roi)?|khong (?:con )?(?:buon|so|lo lang))\b/.test(text);
  const expressedNeed = /\b(?:i'm|i am|i feel) (?:feeling |really |very |so |a little |quite |still )*(?:sad|lonely|scared|afraid|upset|worried|not happy|not okay)\b/.test(text)
    || /\b(?:minh|con|to|toi|em) (?:dang |cam thay |rat |hoi |thay |qua |hom nay |bi |that |cuc ky )*(?:buon(?! ngu)|co don|so|lo lang|khong vui)\b/.test(text);
  const prior = previous?.profile === daily.profile && previous.date === daily.date ? previous : null;
  const comfort = !released && (expressedNeed || prior?.comfort === true);
  const strong = /\b(very|really|so|super|extremely|rat|cuc ky|sieu|lam|qua)\b/.test(text);
  const gentle = /\b(a little|a bit|slightly|hoi|mot chut)\b/.test(text);
  let emotion: Emotion;
  if (comfort) emotion = 'sad';
  else if (released) emotion = 'happy';
  else if (/\b(?:sleep|sleepy|tired|bedtime|rest|buon ngu|ngu|met|nghi ngoi)\b/.test(text)) emotion = 'sleepy';
  else if (/\b(?:love you|like you|hug|cuddle|yeu miu|thuong miu|om miu)\b/.test(text)) emotion = 'love';
  else if (/\b(?:joke|funny|laugh|chuyen cuoi|buon cuoi)\b/.test(text)) emotion = 'laughing';
  else if (/\b(?:happy|excited|yay|hooray|great|vui|hao hung|tuyet)\b/.test(text)) emotion = strong ? 'excited' : 'happy';
  else if (fallback !== 'neutral' && !['listening', 'thinking', 'sulky'].includes(fallback)) emotion = fallback;
  else if (/\b(?:why|how|what|where|which|when|wonder|imagine|story|dinosaur|tai sao|vi sao|nhu the nao|ke chuyen|khung long)\b/.test(text)) emotion = 'curious';
  else emotion = feelingEmotion(daily.feeling);
  const feeling = feelingForEmotion(emotion);
  const levels = { ...daily.levels };
  const hasContext = text.trim().length > 0;
  let strength = hasContext ? clamp(Math.round(daily.levels[feeling] * .35 + 47 + (strong ? 15 : 0) - (gentle ? 15 : 0)), 30, 95) : daily.levels[feeling];
  if (comfort) strength = clamp(56 + daily.levels.sad * .18 + (strong ? 8 : 0) - (gentle ? 7 : 0), 48, 72);
  levels[feeling] = Math.round(strength);
  if (comfort) { levels.happy = Math.min(levels.happy, 25); levels.curious = Math.min(levels.curious, 30); levels.sulky = 0; levels.calm = Math.max(levels.calm, 65); }
  return { profile: daily.profile, date: daily.date, emotion, intensity: clamp(strength / 100, .2, .95), levels, comfort };
}

export function emotionLevel(intensity: number): number { return clamp(Math.ceil((Number.isFinite(intensity) ? intensity : 0) * 5), 0, 5); }

export function spokenMoodText(response: { provider_mode: string; transcript?: { text?: string; uncertain_spans?: unknown[] } | null }): string {
  return response.provider_mode === 'real' && response.transcript?.uncertain_spans?.length === 0 && typeof response.transcript.text === 'string' ? response.transcript.text : '';
}
export function dailyEnergy(daily: DailyMood): number {
  return clamp(.35 + daily.levels.happy / 250 + daily.levels.curious / 400 - daily.levels.sleepy / 250, .25, .95);
}

export function moodPresentation(daily: DailyMood, turn: TurnMood | null, phase: Phase, activity: CatActivity, activityFeeling: Emotion): FeelingPresentation {
  const current = turn?.profile === daily.profile && turn.date === daily.date ? turn : null;
  const comfort = current?.comfort === true;
  if (phase === 'resting' || activity === 'sleep' || activity === 'doze') return { emotion: 'sleepy', intensity: .4, comfort };
  if (phase === 'listening' || phase === 'thinking') return { emotion: phase, intensity: .45, comfort };
  if (comfort) {
    if (activity === 'purr' || activity === 'cuddle') return { emotion: 'love', intensity: .45, comfort };
    return { emotion: 'sad', intensity: current!.intensity, comfort };
  }
  if (phase === 'speaking' || activity === 'settled') return current ?? { emotion: feelingEmotion(daily.feeling), intensity: daily.levels[daily.feeling] / 100, comfort };
  const emotion = activityFeeling === 'neutral' ? feelingEmotion(daily.feeling) : activityFeeling;
  const feeling = feelingForEmotion(emotion);
  return { emotion, intensity: clamp(.3 + daily.levels[feeling] / 150, .3, .95), comfort };
}
