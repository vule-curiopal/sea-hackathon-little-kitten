import { useCallback, useEffect, useMemo, useState } from 'react';
import { readPreference, savePreference } from './i18n';
import { conversationMood, localDay, restoreDailyMood, type TurnMood } from './daily-mood';
import type { Emotion } from './miu-pose';
import type { Phase } from './conversation';

export function useDailyMood(profile: string, phase: Phase) {
  const [now, setNow] = useState(() => new Date());
  const date = localDay(now);
  const daily = useMemo(() => restoreDailyMood(profile, date, readPreference(`miu.daily-mood.${profile}`, 'null')), [profile, date]);
  const [turn, setTurn] = useState<(TurnMood & { expires: number }) | null>(null);
  const current = turn?.profile === daily.profile && turn.date === daily.date ? turn : null;

  useEffect(() => setTurn(null), [profile, date]);

  useEffect(() => { savePreference(`miu.daily-mood.${profile}`, JSON.stringify(daily)); }, [profile, daily]);
  useEffect(() => {
    const next = new Date(); next.setHours(24, 0, 0, 30);
    const timer = setTimeout(() => setNow(new Date()), Math.max(1, next.getTime() - Date.now()));
    const refresh = () => { if (!document.hidden) setNow(new Date()); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [date]);
  useEffect(() => {
    if (!current || current.comfort || ['speaking', 'listening', 'thinking'].includes(phase)) return;
    const timer = setTimeout(() => setTurn(previous => previous === current ? null : previous), Math.max(0, current.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [current, phase]);

  const assess = useCallback((text: string, fallback: Emotion = 'neutral') => conversationMood(daily, text, fallback, current), [daily, current]);
  const commit = useCallback((value: TurnMood) => {
    if (value.profile !== daily.profile || value.date !== daily.date) return;
    setTurn({ ...value, expires: Date.now() + (value.emotion === 'sulky' ? 2400 : 18000) });
  }, [daily]);
  const clearConversation = useCallback(() => setTurn(null), []);
  return { daily, turn: current, assess, commit, clearConversation };
}
