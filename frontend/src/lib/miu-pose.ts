export const emotions = ['neutral', 'listening', 'thinking', 'happy', 'excited', 'laughing', 'love', 'curious', 'surprised', 'wink', 'shy', 'confused', 'sad', 'sulky', 'sleepy'] as const;
export type Emotion = typeof emotions[number];

import type { CatActivity } from './miu-behavior';

type Face = {
  eyes: 'open' | 'happy' | 'closed' | 'heart' | 'wink';
  lx: number; ly: number; pupil: number; wide: boolean;
  brow: 'calm' | 'up' | 'sad' | 'focus' | 'tilt' | 'pout';
  line: 'w' | 'small' | 'flat' | 'frown' | 'wavy' | 'smirk' | 'pout' | null;
  fill: 'smile' | 'laugh' | 'o' | 'tiny' | null;
  ear: number[]; arm: number[]; blush: number; puff: number; extra: string | null;
};

const brows = {
  calm: ['M128 122 Q 150 114 172 120', 'M228 120 Q 250 114 272 122'],
  up: ['M128 108 Q 150 98 172 106', 'M228 106 Q 250 98 272 108'],
  sad: ['M128 120 Q 152 116 172 106', 'M228 106 Q 248 116 272 120'],
  focus: ['M128 118 Q 150 114 172 120', 'M228 110 Q 250 100 272 108'],
  tilt: ['M128 112 Q 150 104 172 112', 'M228 122 Q 250 120 272 126'],
  pout: ['M128 120 Q 148 113 170 117', 'M230 117 Q 250 113 272 120'],
};
const lines = {
  w: 'M184 224 Q 192 236 200 226 Q 208 236 216 224',
  small: 'M190 230 Q 200 237 210 230', flat: 'M192 236 Q 204 233 216 236',
  frown: 'M184 242 Q 200 228 216 242', wavy: 'M182 238 Q 191 231 200 238 Q 209 245 218 238',
  smirk: 'M184 230 Q 204 246 222 228',
  pout: 'M190 236 Q 200 231 210 236 M194 242 Q 200 245 206 242',
};
const fills: Record<NonNullable<Face['fill']>, [string, number]> = {
  smile: ['M176 226 Q 200 266 224 226 Q 200 234 176 226 Z', 240],
  laugh: ['M166 224 Q 200 286 234 224 Q 200 234 166 224 Z', 246],
  o: ['M188 229 a 12 15 0 1 0 24 0 a 12 15 0 1 0 -24 0 Z', 0],
  tiny: ['M194 233 a 6 7 0 1 0 12 0 a 6 7 0 1 0 -12 0 Z', 0],
};
const looks: Record<Emotion, Partial<Face>> = {
  neutral: {},
  listening: { brow: 'up', line: 'small', ear: [-8, 8], arm: [15, -150], extra: 'waves' },
  thinking: { lx: 8, ly: -10, brow: 'focus', line: 'flat', arm: [-35, -15], extra: 'dots' },
  happy: { eyes: 'happy', line: null, fill: 'smile', blush: .7, arm: [25, -25] },
  excited: { pupil: 12, brow: 'up', line: null, fill: 'laugh', arm: [150, -150], extra: 'sparkle', blush: .5 },
  laughing: { eyes: 'happy', line: null, fill: 'laugh', blush: .8, arm: [30, -30], ear: [6, -6] },
  love: { eyes: 'heart', line: null, fill: 'smile', blush: .9, arm: [-30, 30], extra: 'love' },
  curious: { lx: 10, brow: 'tilt', line: null, fill: 'tiny', ear: [-12, 4], extra: 'question' },
  surprised: { pupil: 9, wide: true, brow: 'up', line: null, fill: 'o', arm: [40, -40] },
  wink: { eyes: 'wink', line: 'smirk', arm: [15, -140], extra: 'sparkle', blush: .4 },
  shy: { eyes: 'happy', ly: 6, line: 'small', blush: 1, arm: [-35, 35], ear: [-10, 10] },
  confused: { lx: -6, ly: 4, brow: 'tilt', line: 'wavy', ear: [-20, 5], arm: [15, -160], extra: 'question' },
  sad: { ly: 8, brow: 'sad', line: 'frown', ear: [-30, 30], arm: [5, -5], extra: 'tear' },
  sulky: { lx: -8, ly: 3, brow: 'pout', line: 'pout', ear: [-10, 10], arm: [-65, 65], blush: .45, puff: 1 },
  sleepy: { eyes: 'closed', line: null, fill: 'tiny', ear: [-15, 15], arm: [8, -8], extra: 'zzz' },
};

function softenBrow(calm: string, target: string, strength: number) {
  if (strength >= 1) return target;
  const points = target.match(/-?\d+(?:\.\d+)?/g)!;
  let index = 0;
  return calm.replace(/-?\d+(?:\.\d+)?/g, value => {
    const start = Number(value);
    return String(Math.round((start + (Number(points[index++]) - start) * strength) * 100) / 100);
  });
}

export function getMiuPose(emotion: string, activity?: CatActivity, gaze?: { x: number; y: number }, intensity = 1) {
  const feeling = (emotions as readonly string[]).includes(emotion) ? emotion as Emotion : 'neutral';
  const base: Face = { eyes: 'open', lx: 0, ly: 0, pupil: 14, wide: false, brow: 'calm', line: 'w', fill: null, ear: [0, 0], arm: [15, -15], blush: 0, puff: 0, extra: null };
  const f = { ...base, ...looks[feeling] };
  if (activity === 'look') { f.lx = 9; f.ly = -3; f.ear = [-6, 5]; }
  if (activity === 'groom') { f.arm = [155, -15]; f.ear = [-8, 8]; }
  if (activity === 'stretch' || activity === 'wake') { f.arm = [155, -155]; f.eyes = 'closed'; f.line = 'small'; f.fill = null; }
  if (activity === 'play') { f.arm = [15, -60]; f.ear = [-5, 8]; }
  if (activity === 'purr') { f.arm = [-30, 30]; f.blush = .8; }
  if (activity === 'boop') { f.ear = [-14, 8]; f.arm = [20, -20]; }
  if (activity === 'tickle') { f.arm = [55, -55]; f.ear = [8, -8]; }
  if (activity === 'highfive') { f.arm = [15, -155]; f.ear = [-5, 5]; }
  if (activity === 'cuddle') { f.arm = [-42, 42]; f.ear = [-12, 12]; }
  if (activity === 'snack') { f.arm = [150, -15]; f.line = null; f.fill = 'tiny'; }
  const strength = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 1));
  const expressionScale = .15 + strength * .85;
  const keepClosed = activity === 'sleep' || activity === 'doze' || activity === 'stretch' || activity === 'wake';
  if (!keepClosed) {
    if (f.eyes === 'happy' && strength < .45) f.eyes = 'open';
    if (f.eyes === 'heart' && strength < .55) f.eyes = 'open';
    if (feeling === 'sleepy' && strength < .5) f.eyes = 'open';
  }
  if (feeling === 'happy' && strength < .4 && f.fill === 'smile') { f.fill = null; f.line = 'small'; }
  if ((feeling === 'excited' || feeling === 'laughing') && strength < .65 && f.fill === 'laugh') f.fill = 'smile';
  if (feeling === 'surprised' && strength < .4 && f.fill === 'o') f.fill = 'tiny';
  f.blush *= expressionScale;
  f.puff *= expressionScale;
  f.pupil = 14 + (f.pupil - 14) * expressionScale;
  // Touch gestures keep their full reach; emotional poses vary in strength.
  if (!activity || activity === 'settled' || activity === 'pout') {
    f.arm = [15 + (f.arm[0] - 15) * expressionScale, -15 + (f.arm[1] + 15) * expressionScale];
    f.ear = f.ear.map(angle => angle * expressionScale);
    f.lx *= expressionScale; f.ly *= expressionScale;
  }
  if (gaze) { f.lx = Math.max(-8, Math.min(8, gaze.x)); f.ly = Math.max(-6, Math.min(6, gaze.y)); }
  const fill = f.fill ? fills[f.fill] : null;
  const on = (yes: unknown) => yes ? 1 : 0;
  const irisY = 168 + f.ly;
  const eyeHeight = f.wide ? 38 + 6 * strength : feeling === 'sulky' ? 38 - 9 * strength : feeling === 'neutral' ? 38 - 7 * strength : feeling === 'sleepy' && f.eyes === 'open' ? 38 - 24 * strength : 38;
  const sadMouth = `M184 ${234 + 8 * strength} Q 200 ${234 - 6 * strength} 216 ${234 + 8 * strength}`;
  return {
    btnGlow: feeling === 'listening' ? .9 : .45,
    earL: `rotate(${f.ear[0]} 125 115)`, earR: `rotate(${f.ear[1]} 275 115)`,
    armL: `rotate(${f.arm[0]} 132 288)`, armR: `rotate(${f.arm[1]} 268 288)`,
    openL: on(f.eyes === 'open' || f.eyes === 'wink'), openR: on(f.eyes === 'open'),
    happyL: on(f.eyes === 'happy'), happyR: on(f.eyes === 'happy' || f.eyes === 'wink'),
    closed: on(f.eyes === 'closed'), heart: on(f.eyes === 'heart'),
    rx: f.wide ? 33 + 3 * strength : 33, ry: eyeHeight, pupil: f.pupil,
    irisLx: 152 + f.lx, irisRx: 248 + f.lx, irisY,
    hiLx: 160 + f.lx, hiRx: 256 + f.lx, hiY: irisY - 9,
    hi2Lx: 145 + f.lx, hi2Rx: 241 + f.lx, hi2Y: irisY + 8,
    browL: softenBrow(brows.calm[0], brows[f.brow][0], expressionScale), browR: softenBrow(brows.calm[1], brows[f.brow][1], expressionScale),
    mouthLine: feeling === 'sad' && f.line === 'frown' ? sadMouth : f.line ? lines[f.line] : 'M200 226 L200 226', lineOp: on(f.line),
    mouthFill: fill ? fill[0] : 'M200 226 Z', fillOp: on(fill),
    tongue: on(fill && fill[1]), tongueY: fill?.[1] || 240, blush: f.blush,
    puff: f.puff, cheekRx: 18 + 6 * f.puff, cheekRy: 10 + 4 * f.puff,
    mouthScale: .55 + strength * .45, mouthScaleX: .55 + strength * .45, mouthScaleY: .35 + strength * .65,
    sparkle: on(f.extra === 'sparkle') * strength, love: on(f.extra === 'love') * strength,
    question: on(f.extra === 'question') * expressionScale, zzz: on(f.extra === 'zzz' && (strength >= .5 || keepClosed)) * strength,
    dots: on(f.extra === 'dots') * strength, waves: on(f.extra === 'waves') * expressionScale, tear: on(f.extra === 'tear') * Math.max(0, (strength - .65) / .35),
  };
}
