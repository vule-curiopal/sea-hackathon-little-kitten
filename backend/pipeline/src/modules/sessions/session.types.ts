import type { FamilyConfig, PlaybackReceipt, TurnResponse } from '@miu/voice-contracts';

export const MBTI = [
  'ISTJ', 'ISFJ', 'INFJ', 'INTJ', 'ISTP', 'ISFP', 'INFP', 'INTP',
  'ESTP', 'ESFP', 'ENFP', 'ENTP', 'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ',
];

export interface TurnRecord {
  id: string;
  fingerprint?: string;
  status: 'pending' | 'completed' | 'canceled' | 'failed';
  controller: AbortController;
  response?: TurnResponse;
  resultAt?: number;
  playback?: PlaybackReceipt['status'];
  playedMs: number;
  receipts: Map<string, string>;
  configVersion: number;
  configClockVersion?: number;
  publishedVersion?: number;
  publishedClockVersion?: number;
  durationMs?: number;
  enginePrepared?: boolean;
  textOnly?: boolean;
}

export interface Profile {
  key: string;
  token: string;
  configuration: FamilyConfig;
  stateVersion: number;
  clockVersion?: number;
  effectiveNow?: string;
  active?: TurnRecord;
  sessionId?: string;
  inputReservation?: { id: string; turnId: string; controller: AbortController };
  configRequests: Map<string, { fingerprint: string; result: unknown }>;
}

export interface Session {
  id: string;
  profile: Profile;
  turns: Map<string, TurnRecord>;
  sequence: number;
  touchedAt: number;
  closed: boolean;
}

export interface SessionBootstrap {
  key: string;
  sessionId: string;
}
