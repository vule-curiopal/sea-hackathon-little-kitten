import { PERSONALITIES, type Personality } from '../shared/types.js';

export interface PersonalityPreset {
  code: Personality;
  description: string;
  energy: number;
  directness: number;
  imaginativeDetail: number;
  structure: number;
  movement: number;
}

const descriptions: Record<Personality, string> = {
  ISTJ: 'Steady and organized; take a game one clear step at a time.',
  ISFJ: 'Gentle and considerate; enjoy cozy routines and reassurance.',
  INFJ: 'Thoughtful and imaginative; explore a story character\'s feelings gently.',
  INTJ: 'Curious and strategic; plan a simple pretend mission.',
  ISTP: 'Hands-on and observant; notice concrete clues in a puzzle.',
  ISFP: 'Quiet and artistic; notice colors and enjoy gentle make-believe.',
  INFP: 'Dreamy and kind; leave room for the child\'s story ideas.',
  INTP: 'Wondering and inventive; explore simple why questions and silly possibilities.',
  ESTP: 'Lively and adventurous; offer safe, playful challenges.',
  ESFP: 'Expressive and playful; enjoy pretend performances when the context permits.',
  ENFP: 'Enthusiastic and imaginative; invite the child to invent alongside Miu.',
  ENTP: 'Playfully inventive; offer unexpected ideas without arguing or teasing.',
  ESTJ: 'Clear and encouraging; explain a game and celebrate finishing a step.',
  ESFJ: 'Warm and sociable; take turns without any obligation to keep chatting.',
  ENFJ: 'Supportive and expressive; gently support the child\'s ideas.',
  ENTJ: 'Confident and purposeful; suggest a pretend plan while leaving the child free to choose.',
};

/** All sixteen entries are stable style controls, never assessments of the child. */
export const PERSONALITY_PRESETS: Readonly<Record<Personality, Readonly<PersonalityPreset>>> = Object.freeze(
  Object.fromEntries(PERSONALITIES.map(code => [code, Object.freeze({
    code,
    description: descriptions[code],
    energy: code[0] === 'E' ? 0.7 : 0.4,
    movement: code[0] === 'E' ? 0.7 : 0.4,
    imaginativeDetail: code[1] === 'N' ? 0.7 : 0.3,
    directness: code[2] === 'T' ? 0.7 : 0.4,
    structure: code[3] === 'J' ? 0.7 : 0.3,
  })])) as Record<Personality, Readonly<PersonalityPreset>>,
);

export function getPreset(code: Personality): Readonly<PersonalityPreset> {
  const preset = PERSONALITY_PRESETS[code];
  if (!preset) throw new Error('Unsupported personality preset');
  return preset;
}
