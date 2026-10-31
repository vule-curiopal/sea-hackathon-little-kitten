import { VoiceClientError, type SessionResponse } from '@miu/voice-client';
import type { AffectPresentation, AffectSnapshot } from './affect';

export const PERSONALITIES = ['ISTJ', 'ISFJ', 'INFJ', 'INTJ', 'ISTP', 'ISFP', 'INFP', 'INTP', 'ESTP', 'ESFP', 'ENFP', 'ENTP', 'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ'] as const;
export type Role = 'friend' | 'big_sibling' | 'teacher';
export type Presentation = {
  emotion?: string; purpose?: string; rhythm?: string; dailyMood?: string; delivery?: string;
  comfortActive?: boolean; allowPurr?: boolean; allowGiggle?: boolean;
  face?: { expression?: string; gesture?: string };
  affect?: AffectPresentation;
};
export type DemoContext = {
  affect?: AffectSnapshot;
  profile: { displayName: string; ageBand: string; timezone: string };
  config: { personality: string; role: string; voiceId: string };
  clock: { effectiveNow: string; localDate: string; timezone: string; version: number; mode: string };
  daily: { localDate: string; mood: string; growthDays: number; growthTheme: string; diary: { en: string; vi: string }; storyEpisode: { chapter: number; en: string; vi: string } };
  friendship: string;
  entities: { id: string; kind: string; name: string; species: string | null; aliases: string[]; expiresAt: string | null }[];
  preferences: { id: string; category: string; value: string; expiresAt: string | null }[];
  socialCircle: { id: string; name: string; relation: string; expiresAt: string | null }[];
  events: { id: string; subjectName: string | null; value: string; evidenceKind: string; localDate: string; expiresAt: string | null }[];
  stories: { id: string; title: string; summary: string; castNames: string[] }[];
  storyProgress: { title: { en: string; vi: string }; chapter: number; status: string } | null;
};
export type DemoPanelData = { memory_available: boolean; context?: DemoContext; clock_version: number; state_version: number; effective_now: string; provider_mode: string; engine_mode: string };
export async function engineRequest<T>(session: SessionResponse, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const base = (import.meta.env.VITE_VOICE_API_URL || '').replace(/\/$/, '');
  const response = await fetch(`${base}${path}`, {
    ...init, signal, cache: 'no-store', credentials: 'include',
    headers: { Authorization: `Bearer ${session.demo_token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new VoiceClientError(value?.error?.code ?? 'API_FAILED', 'The request could not be completed.', value?.error?.retryable === true, response.status);
  return value as T;
}
