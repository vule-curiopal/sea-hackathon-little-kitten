import MiuArtwork from './MiuArtwork';
import type { Emotion } from '../lib/miu-pose';
import type { CatActivity } from '../lib/miu-behavior';
import type { Point } from '../lib/miu-touch';
import type { CSSProperties } from 'react';
import { emotionLevel } from '../lib/daily-mood';

const headLean: Partial<Record<Emotion, number>> = { listening: 4, thinking: -5, happy: 3, laughing: -3, love: -4, curious: 9, surprised: 2, wink: 5, shy: -7, confused: -11, sad: -5, sulky: -8, sleepy: -6 };

export default function Miu({ emotion = 'happy', className = '', alive = false, speaking = false, activity, gaze, intensity = 1, mouthLevel, label = 'Miu' }: { emotion?: Emotion; className?: string; alive?: boolean; speaking?: boolean; activity?: CatActivity; gaze?: Point; intensity?: number; mouthLevel?: number; label?: string }) {
  const strength = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 1));
  const lively = ['happy', 'excited', 'laughing', 'love', 'curious', 'surprised', 'wink'].includes(emotion);
  const energy = lively ? strength : .4 - strength * .25;
  const expressionOnly = !activity || activity === 'settled' || activity === 'pout';
  const motion = {
    '--miu-breath-period': `${4.8 - energy * 2.5}s`,
    '--miu-tail-period': `${5 - energy * 3}s`,
    '--miu-tail-swing': `${1.5 + energy * 14}deg`,
    '--miu-head-lean': `${(headLean[emotion] ?? 0) * strength}deg`,
    '--miu-pout-shift': `${-3 * strength}px`,
    '--miu-bob-y': `${-(.5 + energy * 6)}px`,
    '--miu-body-stretch': 1 + energy * .018,
  } as CSSProperties;
  return <div className={`miu ${alive ? 'is-alive' : ''} ${speaking ? 'is-speaking' : ''} ${mouthLevel !== undefined ? 'has-audio-mouth' : ''} ${className}`} data-emotion={emotion} data-activity={activity} data-emotion-level={emotionLevel(strength)} data-expression-only={expressionOnly ? true : undefined} style={motion}><MiuArtwork emotion={emotion} activity={activity} gaze={gaze} intensity={strength} mouthLevel={mouthLevel} label={label} /></div>;
}
