import type { Emotion } from './miu-pose.ts';
import type { Phase } from './conversation.ts';

export type CatReaction = 'purr' | 'play' | 'wake' | 'boop' | 'tickle' | 'highfive' | 'cuddle' | 'snack';
export type CatActivity = 'settled' | 'look' | 'ears' | 'groom' | 'stretch' | 'pout' | 'doze' | 'sleep' | CatReaction;
export const reactionDuration: Record<CatReaction, number> = { purr: 2400, play: 5200, wake: 1800, boop: 1500, tickle: 2200, highfive: 2000, cuddle: 3000, snack: 2800 };

export type IdleRoutine = readonly (readonly [number, CatActivity])[];
const autonomousActivities = ['look', 'ears', 'groom', 'stretch', 'play', 'snack'] as const;
const idleDurations: Record<typeof autonomousActivities[number], number> = { look: 4200, ears: 2400, groom: 4200, stretch: 2200, play: 6000, snack: 3500 };

// Miu chooses its own little moments. No needs meters, recording, or model calls.
// A shuffled bag gives variety without repeating one action over and over.
export function createIdleRoutine(random: () => number = Math.random, mood = { energy: .6, poutChance: .25 }): IdleRoutine {
  const routine: [number, CatActivity][] = [[0, 'settled']];
  const choose = () => Math.max(0, Math.min(.999999, random()));
  const pauseScale = 1.25 - Math.max(.25, Math.min(.95, mood.energy)) * .4;
  let cursor = 4500 + choose() * 2500;
  let previous: CatActivity = 'settled';
  let pouted = false;
  while (cursor < 78000) {
    const before = cursor;
    const bag = [...autonomousActivities];
    for (let index = bag.length - 1; index > 0; index--) {
      const selected = Math.floor(choose() * (index + 1));
      [bag[index], bag[selected]] = [bag[selected], bag[index]];
    }
    if (bag[0] === previous) [bag[0], bag[1]] = [bag[1], bag[0]];
    for (const activity of bag) {
      if (cursor + idleDurations[activity] >= 82000) break;
      routine.push([cursor, activity]);
      cursor += idleDurations[activity];
      // A brief pretend disappointment about the yarn, never about the child.
      if (activity === 'play' && !pouted && choose() < Math.max(0, Math.min(.35, mood.poutChance)) && cursor + 2400 < 82000) {
        routine.push([cursor, 'pout']);
        cursor += 2400;
        pouted = true;
      }
      routine.push([cursor, 'settled']);
      cursor += (4000 + choose() * 3000) * pauseScale;
      previous = activity;
    }
    if (cursor === before) break;
  }
  routine.push([82000, 'doze'], [90000, 'sleep']);
  return routine;
}

export function idleMoment(routine: IdleRoutine, elapsed: number, comfort = false) {
  let index = 0;
  while (index + 1 < routine.length && elapsed >= routine[index + 1][0]) index++;
  const current = routine[index];
  const next = routine[index + 1];
  const activity = comfort && ['groom', 'stretch', 'play', 'snack', 'pout'].includes(current[1]) ? 'settled' : current[1];
  return { activity, nextIn: next ? next[0] - Math.max(0, elapsed) : null };
}

export function presentedActivity(phase: Phase, visible: boolean, suspended: boolean, activity: CatActivity, comfort = false): CatActivity {
  if (phase === 'resting') return 'sleep';
  if (!visible || suspended || phase !== 'answered') return 'settled';
  if (comfort && ['play', 'tickle', 'highfive', 'pout', 'snack', 'groom', 'stretch'].includes(activity)) return 'settled';
  return activity;
}

export function activityEmotion(activity: CatActivity): Emotion {
  if (activity === 'pout') return 'sulky';
  if (activity === 'sleep' || activity === 'doze') return 'sleepy';
  if (activity === 'purr' || activity === 'groom' || activity === 'snack') return 'shy';
  if (activity === 'boop') return 'wink';
  if (activity === 'tickle') return 'laughing';
  if (activity === 'highfive') return 'excited';
  if (activity === 'cuddle') return 'love';
  if (activity === 'play') return 'happy';
  return 'neutral';
}
