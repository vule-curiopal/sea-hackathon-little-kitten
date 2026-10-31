import { useCallback, useEffect, useState } from 'react';
import type { Phase } from './conversation';
import { createIdleRoutine, idleMoment, idleMotionIntensity, presentedActivity, reactionDuration, type CatActivity, type CatReaction } from './miu-behavior';
import type { IdleAffect } from './affect';

export function useMiuBehavior({ phase, visible, suspended, comfort, affect }: { phase: Phase; visible: boolean; suspended: boolean; comfort: boolean; affect?: IdleAffect }) {
  const [revision, setRevision] = useState(0);
  const [idle, setIdle] = useState<CatActivity>('settled');
  const [reaction, setReaction] = useState<{ activity: CatActivity; duration: number } | null>(null);
  const reset = useCallback(() => { setReaction(null); setIdle('settled'); setRevision(value => value + 1); }, []);
  const react = useCallback((activity: CatReaction) => {
    setReaction({ activity, duration: reactionDuration[activity] });
    setRevision(value => value + 1);
  }, []);

  useEffect(() => {
    if (!visible || suspended || phase !== 'answered') {
      setIdle('settled'); setReaction(null);
      return;
    }
    if (reaction) {
      const timer = setTimeout(() => { setReaction(null); setRevision(value => value + 1); }, reaction.duration);
      return () => clearTimeout(timer);
    }
    const started = performance.now();
    // This RNG changes cosmetic gestures only; mood always comes from the server.
    const routine = createIdleRoutine(Math.random, affect);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const moment = idleMoment(routine, performance.now() - started, comfort);
      setIdle(moment.activity);
      if (moment.nextIn !== null) timer = setTimeout(step, Math.max(1, moment.nextIn));
    };
    step();
    return () => clearTimeout(timer);
  }, [phase, visible, suspended, comfort, revision, reaction, affect?.mood, affect?.energy]);

  return { activity: presentedActivity(phase, visible, suspended, reaction?.activity ?? idle), intensity: idleMotionIntensity(affect, comfort), reset, react };
}
