import MiuArtwork from './MiuArtwork';
import type { Emotion } from '../lib/miu-pose';
import type { CatActivity } from '../lib/miu-behavior';
import type { Point } from '../lib/miu-touch';

export default function Miu({ emotion = 'happy', className = '', alive = false, speaking = false, activity, gaze, label = 'Miu' }: { emotion?: Emotion; className?: string; alive?: boolean; speaking?: boolean; activity?: CatActivity; gaze?: Point; label?: string }) {
  return <div className={`miu ${alive ? 'is-alive' : ''} ${speaking ? 'is-speaking' : ''} ${className}`} data-emotion={emotion} data-activity={activity}><MiuArtwork emotion={emotion} activity={activity} gaze={gaze} label={label} /></div>;
}
