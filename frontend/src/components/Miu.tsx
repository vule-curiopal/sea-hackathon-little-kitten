import MiuArtwork from './MiuArtwork';
import type { Emotion } from '../lib/miu-pose';
import type { CatActivity } from '../lib/miu-behavior';
import type { Point } from '../lib/miu-touch';

export default function Miu({ emotion = 'happy', className = '', alive = false, speaking = false, activity, gaze, mouthLevel, label = 'Miu' }: { emotion?: Emotion; className?: string; alive?: boolean; speaking?: boolean; activity?: CatActivity; gaze?: Point; mouthLevel?: number; label?: string }) {
  return <div className={`miu ${alive ? 'is-alive' : ''} ${speaking ? 'is-speaking' : ''} ${mouthLevel !== undefined ? 'has-audio-mouth' : ''} ${className}`} data-emotion={emotion} data-activity={activity}><MiuArtwork emotion={emotion} activity={activity} gaze={gaze} mouthLevel={mouthLevel} label={label} /></div>;
}
