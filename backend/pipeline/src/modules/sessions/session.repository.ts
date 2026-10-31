import type { Profile, Session, SessionBootstrap } from './session.types.js';

/** Storage port for bounded, short-lived protocol state, never dialogue history. */
export interface SessionRepository {
  readonly profiles: Map<string, Profile>;
  getSession(id: string): Session | undefined;
  saveSession(session: Session): void;
  allSessions(): Iterable<Session>;
  removeClosedSessions(): void;
  getBootstrap(requestId: string): SessionBootstrap | undefined;
  saveBootstrap(requestId: string, bootstrap: SessionBootstrap, limit: number): void;
  clear(): void;
}

/** Restarting discards protocol caches; persistent engine state is bridge-owned. */
export class InMemorySessionRepository implements SessionRepository {
  readonly profiles = new Map<string, Profile>();
  private readonly sessions = new Map<string, Session>();
  private readonly bootstraps = new Map<string, SessionBootstrap>();

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  saveSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  allSessions(): Iterable<Session> {
    return this.sessions.values();
  }

  removeClosedSessions(): void {
    for (const [id, session] of this.sessions) {
      if (session.closed) this.sessions.delete(id);
    }
  }

  getBootstrap(requestId: string): SessionBootstrap | undefined {
    return this.bootstraps.get(requestId);
  }

  saveBootstrap(requestId: string, bootstrap: SessionBootstrap, limit: number): void {
    this.bootstraps.set(requestId, bootstrap);
    while (this.bootstraps.size > limit) {
      this.bootstraps.delete(this.bootstraps.keys().next().value!);
    }
  }

  clear(): void {
    this.sessions.clear();
    this.bootstraps.clear();
  }
}
