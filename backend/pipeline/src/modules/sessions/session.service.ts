import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_VOICE, VOICES } from '@miu/voice-contracts';
import type { FamilyConfig, Language, PlaybackReceipt, TurnResponse } from '@miu/voice-contracts';
import { PipelineError } from '../../errors.js';
import type { EngineBridge, EngineProfileSnapshot } from '../../ports.js';
import { InMemorySessionRepository, type SessionRepository } from './session.repository.js';
import { MBTI, type Profile, type Session, type TurnRecord } from './session.types.js';
import { fingerprint } from './session.utils.js';

const SESSION_TTL = 30 * 60_000;
const CACHE_TTL = 5 * 60_000;
const MAX_RECORDS = 100;

/** Session/configuration, turn ownership and playback rules; independent of HTTP. */
export class SessionService {
  private bridge?: EngineBridge;
  private readonly lifecycleQueues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly voices: Record<Language, string> = DEFAULT_VOICE,
    private readonly now = Date.now,
    private readonly repository: SessionRepository = new InMemorySessionRepository(),
  ) {
    for (const key of ['an', 'binh']) {
      if (this.repository.profiles.has(key)) continue;
      this.repository.profiles.set(key, {
        key,
        token: randomBytes(32).toString('hex'),
        configuration: {
          personality: 'ENFP',
          role: 'friend',
          language_mode: 'vi',
          voice_id: voices.vi,
        },
        stateVersion: 1,
        configRequests: new Map(),
      });
    }
  }

  get profiles(): Map<string, Profile> {
    return this.repository.profiles;
  }

  get engineBridge(): EngineBridge | undefined { return this.bridge; }

  attachEngine(bridge: EngineBridge): void {
    if (this.bridge && this.bridge !== bridge) throw new Error('Engine bridge already configured');
    this.bridge = bridge;
  }

  private lifecycle<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.lifecycleQueues.set(key, current);
    void current.finally(() => {
      if (this.lifecycleQueues.get(key) === current) this.lifecycleQueues.delete(key);
    }).catch(() => {});
    return current;
  }

  applySnapshot(profile: Profile, snapshot: EngineProfileSnapshot): void {
    if (profile.stateVersion !== snapshot.state_version || profile.clockVersion !== snapshot.clock_version) {
      for (const session of this.repository.allSessions()) {
        if (session.profile === profile) for (const turn of session.turns.values()) turn.response = undefined;
      }
    }
    profile.configuration = { ...snapshot.configuration };
    profile.stateVersion = snapshot.state_version;
    profile.clockVersion = snapshot.clock_version;
    profile.effectiveNow = snapshot.effective_now;
  }

  async reconcile(session: Session): Promise<void> {
    if (!this.bridge) return;
    this.applySnapshot(session.profile, await this.bridge.context(session.profile.token));
  }

  async createSession(key: string, requestId: string): Promise<Session> {
    if (!this.bridge) return this.create(key, requestId);
    if (!['an', 'binh'].includes(key)) throw new PipelineError('invalid_demo_profile', 400);
    return this.lifecycle('bootstrap', async () => {
      this.sweep();
      const existing = this.repository.getBootstrap(requestId);
      if (existing) {
        if (existing.key !== key) throw new PipelineError('idempotency_conflict', 409);
        const session = this.repository.getSession(existing.sessionId);
        if (!session || session.closed) throw new PipelineError('session_closed', 409);
        await this.reconcile(session);
        return session;
      }
      const oldProfile = this.profiles.get(key);
      if (oldProfile?.active) throw new PipelineError('turn_in_progress', 409);
      const snapshot = await this.bridge!.openSession(key);
      if (oldProfile?.sessionId) {
        const previous = this.repository.getSession(oldProfile.sessionId);
        if (previous) this.close(previous);
      }
      const profile: Profile = {
        key, token: snapshot.demo_token, configuration: { ...snapshot.configuration },
        stateVersion: snapshot.state_version, clockVersion: snapshot.clock_version,
        effectiveNow: snapshot.effective_now, configRequests: new Map(), sessionId: snapshot.session_id,
      };
      const session: Session = { id: snapshot.session_id, profile, turns: new Map(), sequence: 0,
        touchedAt: this.now(), closed: false };
      this.profiles.set(key, profile);
      this.repository.saveSession(session);
      this.repository.saveBootstrap(requestId, { key, sessionId: session.id }, MAX_RECORDS);
      this.repository.removeClosedSessions();
      return session;
    });
  }

  async configureProfile(profile: Profile, requestId: string, patch: Record<string, unknown>): Promise<unknown> {
    if (!this.bridge) return this.configure(profile, requestId, patch);
    return this.lifecycle(profile.key, async () => {
      const bodyFingerprint = fingerprint(patch);
      const old = profile.configRequests.get(requestId);
      if (old) {
        if (old.fingerprint !== bodyFingerprint) throw new PipelineError('idempotency_conflict', 409);
        return old.result;
      }
      this.applySnapshot(profile, await this.bridge!.context(profile.token));
      if (profile.active) throw new PipelineError('turn_in_progress', 409);
      // Reuse the same allowlist against an isolated validation copy.
      const validationProfile = { ...profile, configuration: { ...profile.configuration }, configRequests: new Map() };
      this.configure(validationProfile, requestId, patch);
      const snapshot = await this.bridge!.configure(profile.token, validationProfile.configuration);
      this.applySnapshot(profile, snapshot);
      const result = { ...snapshot };
      profile.configRequests.set(requestId, { fingerprint: bodyFingerprint, result });
      while (profile.configRequests.size > MAX_RECORDS) profile.configRequests.delete(profile.configRequests.keys().next().value!);
      return result;
    });
  }

  async closeSession(session: Session): Promise<void> {
    this.close(session);
    if (this.bridge) await this.bridge.closeSession(session.profile.token, session.id);
  }

  async cancelTurn(session: Session, turnId: string): Promise<void> {
    this.cancel(session, turnId);
    if (this.bridge) await this.bridge.cancel(session.profile.token, session.id, turnId);
  }

  async playback(session: Session, id: string, receipt: PlaybackReceipt): Promise<unknown> {
    if (!this.bridge) return this.receipt(session, id, receipt);
    return this.lifecycle(session.profile.key, async () => {
      const turn = session.turns.get(id);
      if (!turn) throw new PipelineError('turn_not_found', 404);
      const old = turn.receipts.get(receipt.request_id);
      if (old) {
        if (old !== fingerprint(receipt)) throw new PipelineError('idempotency_conflict', 409);
        return this.bridge!.playback(session.profile.token, session.id, id, receipt);
      }
      await this.reconcile(session);
      const previous = { playback: turn.playback, playedMs: turn.playedMs };
      this.receipt(session, id, receipt);
      let result: unknown;
      try {
        result = await this.bridge!.playback(session.profile.token, session.id, id, receipt);
      } catch (error) {
        turn.playback = previous.playback;
        turn.playedMs = previous.playedMs;
        turn.receipts.delete(receipt.request_id);
        throw error;
      }
      if (receipt.status !== 'started' && session.profile.active === turn) session.profile.active = undefined;
      // A failed read after a committed receipt cannot undo learning or its receipt.
      try { await this.reconcile(session); } catch { /* The next operation reconciles again. */ }
      return result;
    });
  }

  sweep(): void {
    for (const session of this.repository.allSessions()) {
      if (!session.closed && this.now() - session.touchedAt > SESSION_TTL) void this.closeSession(session).catch(() => {});
      for (const turn of session.turns.values()) {
        if (turn.resultAt && this.now() - turn.resultAt > CACHE_TTL) {
          turn.response = undefined;
        }
      }
    }
  }

  profile(token: string | undefined): Profile {
    this.sweep();
    const profile = [...this.profiles.values()].find(item => token && item.token === token);
    if (!profile) throw new PipelineError('unauthorized', 401);
    return profile;
  }

  create(key: string, requestId: string): Session {
    this.sweep();
    const profile = this.profiles.get(key);
    if (!profile) throw new PipelineError('invalid_demo_profile', 400);

    const existing = this.repository.getBootstrap(requestId);
    if (existing) {
      if (existing.key !== key) throw new PipelineError('idempotency_conflict', 409);
      const session = this.repository.getSession(existing.sessionId);
      if (!session || session.closed) throw new PipelineError('session_closed', 409);
      return session;
    }

    if (profile.active) throw new PipelineError('turn_in_progress', 409);
    if (profile.sessionId) {
      const previous = this.repository.getSession(profile.sessionId);
      if (previous) this.close(previous);
    }

    const session: Session = {
      id: randomUUID(),
      profile,
      turns: new Map(),
      sequence: 0,
      touchedAt: this.now(),
      closed: false,
    };
    this.repository.saveSession(session);
    profile.sessionId = session.id;
    this.repository.saveBootstrap(requestId, { key, sessionId: session.id }, MAX_RECORDS);
    this.repository.removeClosedSessions();
    return session;
  }

  session(id: string, token: string | undefined): Session {
    const profile = this.profile(token);
    const session = this.repository.getSession(id);
    if (!session || session.profile !== profile) {
      throw new PipelineError('session_not_found', 404);
    }
    if (session.closed) throw new PipelineError('session_closed', 409);
    session.touchedAt = this.now();
    return session;
  }

  close(session: Session): void {
    session.closed = true;
    for (const turn of session.turns.values()) {
      turn.controller.abort();
      turn.response = undefined;
    }
    session.turns.clear();
    if (session.profile.sessionId === session.id) {
      session.profile.active = undefined;
      session.profile.sessionId = undefined;
    }
  }

  cancel(session: Session, turnId: string): void {
    let turn = session.turns.get(turnId);
    if (!turn) {
      if (session.turns.size >= MAX_RECORDS) {
        throw new PipelineError('session_turn_limit', 429);
      }
      turn = this.newRecord(session, turnId);
    }
    if (turn.playback === 'completed') return;
    turn.status = 'canceled';
    turn.controller.abort();
    turn.response = undefined;
    if (session.profile.active === turn) session.profile.active = undefined;
  }

  begin(session: Session, id: string, bodyFingerprint: string): { turn: TurnRecord; cached?: TurnResponse } {
    const existing = session.turns.get(id);
    if (existing) {
      if (existing.fingerprint && existing.fingerprint !== bodyFingerprint) {
        throw new PipelineError('idempotency_conflict', 409);
      }
      if (existing.status === 'canceled') throw new PipelineError('turn_canceled', 409);
      if (existing.status === 'pending') throw new PipelineError('turn_in_progress', 409);
      if (existing.status === 'failed') throw new PipelineError('turn_failed', 409);
      if (!existing.response) throw new PipelineError('turn_already_completed', 409);
      if (existing.response.state_version !== session.profile.stateVersion) {
        throw new PipelineError('stale_state', 409);
      }
      return { turn: existing, cached: existing.response };
    }
    if (session.profile.active) throw new PipelineError('turn_in_progress', 409);
    if (session.turns.size >= MAX_RECORDS) {
      throw new PipelineError('session_turn_limit', 429);
    }

    // Older results keep only bounded idempotency metadata, never GPT history.
    for (const turn of session.turns.values()) turn.response = undefined;
    const turn = this.newRecord(session, id);
    turn.fingerprint = bodyFingerprint;
    session.profile.active = turn;
    return { turn };
  }

  configure(profile: Profile, requestId: string, patch: Record<string, unknown>): unknown {
    const allowed = ['request_id', 'language_mode', 'voice_id', 'personality', 'role'];
    if (Object.keys(patch).some(key => !allowed.includes(key))) {
      throw new PipelineError('invalid_request', 400);
    }
    const bodyFingerprint = fingerprint(patch);
    const previous = profile.configRequests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== bodyFingerprint) {
        throw new PipelineError('idempotency_conflict', 409);
      }
      return previous.result;
    }
    if (profile.active) throw new PipelineError('turn_in_progress', 409);

    const next = { ...profile.configuration };
    if (patch.language_mode !== undefined) {
      if (patch.language_mode !== 'vi' && patch.language_mode !== 'en') {
        throw new PipelineError('invalid_language', 400);
      }
      next.language_mode = patch.language_mode;
      if (patch.voice_id === undefined) next.voice_id = this.voices[next.language_mode];
    }
    if (patch.voice_id !== undefined) {
      if (typeof patch.voice_id !== 'string') throw new PipelineError('invalid_voice', 400);
      next.voice_id = patch.voice_id;
    }
    if (!VOICES.some(voice => voice.id === next.voice_id && voice.language === next.language_mode)) {
      throw new PipelineError('invalid_voice', 400);
    }
    if (patch.personality !== undefined) {
      if (typeof patch.personality !== 'string' || !MBTI.includes(patch.personality)) {
        throw new PipelineError('invalid_personality', 400);
      }
      next.personality = patch.personality;
    }
    if (patch.role !== undefined) {
      if (typeof patch.role !== 'string' || !['friend', 'big_sibling', 'teacher'].includes(patch.role)) {
        throw new PipelineError('invalid_role', 400);
      }
      next.role = patch.role as FamilyConfig['role'];
    }

    profile.configuration = next;
    profile.stateVersion++;
    const result = { configuration: { ...next }, clock_version: 1, state_version: profile.stateVersion };
    profile.configRequests.set(requestId, { fingerprint: bodyFingerprint, result });
    while (profile.configRequests.size > MAX_RECORDS) {
      profile.configRequests.delete(profile.configRequests.keys().next().value!);
    }
    return result;
  }

  receipt(session: Session, id: string, receipt: PlaybackReceipt): unknown {
    const turn = session.turns.get(id);
    if (!turn) throw new PipelineError('turn_not_found', 404);
    const bodyFingerprint = fingerprint(receipt);
    const old = turn.receipts.get(receipt.request_id);
    if (old) {
      if (old !== bodyFingerprint) throw new PipelineError('idempotency_conflict', 409);
      return { turn_id: id, status: turn.playback, learning_status: 'disabled' };
    }
    const interruptedCanceled = turn.status === 'canceled'
      && turn.playback === 'started' && receipt.status === 'interrupted';
    if ((turn.status !== 'completed' && !interruptedCanceled)
      || receipt.state_version !== turn.publishedVersion
      || receipt.state_version !== session.profile.stateVersion) {
      throw new PipelineError('stale_state', 409);
    }
    if ((turn.playback && turn.playback !== 'started')
      || (!turn.playback && receipt.status !== 'started')
      || (turn.playback === 'started' && receipt.status === 'started')) {
      throw new PipelineError('invalid_playback_transition', 409);
    }
    if (receipt.played_ms < turn.playedMs || receipt.played_ms > (turn.durationMs ?? 0) + 500
      || (turn.textOnly && receipt.played_ms !== 0)) {
      throw new PipelineError('invalid_playback_position', 400);
    }
    turn.playback = receipt.status;
    turn.playedMs = receipt.played_ms;
    turn.receipts.set(receipt.request_id, bodyFingerprint);
    return { turn_id: id, status: turn.playback, learning_status: 'disabled' };
  }

  dispose(): void {
    for (const session of this.repository.allSessions()) void this.closeSession(session).catch(() => {});
    this.repository.clear();
  }

  private newRecord(session: Session, id: string): TurnRecord {
    const record: TurnRecord = {
      id,
      status: 'pending',
      controller: new AbortController(),
      playedMs: 0,
      receipts: new Map(),
      configVersion: session.profile.stateVersion,
      configClockVersion: session.profile.clockVersion,
    };
    session.turns.set(id, record);
    return record;
  }
}
