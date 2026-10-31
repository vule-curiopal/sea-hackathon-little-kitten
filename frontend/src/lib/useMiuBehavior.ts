import { useCallback, useEffect, useState } from 'react';
import type { Phase } from './conversation';
import { createIdleRoutine, idleMoment, presentedActivity, reactionDuration, type CatActivity, type CatReaction } from './miu-behavior';

export function useMiuBehavior({ phase, visible, suspended, comfort, energy = .6, poutChance = .25 }: { phase: Phase; visible: boolean; suspended: boolean; comfort: boolean; energy?: number; poutChance?: number }) {
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
    const routine = createIdleRoutine(Math.random, { energy: comfort ? .25 : energy, poutChance: comfort ? 0 : poutChance });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const moment = idleMoment(routine, performance.now() - started, comfort);
      setIdle(moment.activity);
      if (moment.nextIn !== null) timer = setTimeout(step, Math.max(1, moment.nextIn));
    };
    step();
    return () => clearTimeout(timer);
  }, [phase, visible, suspended, comfort, energy, poutChance, revision, reaction]);

  return { activity: presentedActivity(phase, visible, suspended, reaction?.activity ?? idle, comfort), reset, react };
}
