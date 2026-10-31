import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type { PersistentEngineBridge } from '../integration/engine-bridge.js';
import { PipelineError } from '../pipeline/src/errors.js';
import { bearerToken, object } from '../pipeline/src/http/request.js';
import type { SessionService } from '../pipeline/src/modules/sessions/session.service.js';
import { assertAuthRequestOrigin, authenticateRequest } from './http.js';
import type { AuthStore } from './store.js';

/** Resolve the owner on the server. Legacy public demo selectors create a new
 * guest profile, so they cannot reopen Sam's existing An profile. */
export function accountSessionResolver(auth: AuthStore, bridge: PersistentEngineBridge, allowedOrigins: string[] = []) {
  return async (request: Request): Promise<string> => {
    assertAuthRequestOrigin(request, allowedOrigins);
    const selector = object(request.body).demo_profile_key;
    if (selector !== undefined && !['account', 'guest', 'an', 'binh'].includes(String(selector))) {
      throw new PipelineError('invalid_demo_profile', 400);
    }
    const user = selector === 'guest' ? null : await authenticateRequest(request, auth);
    if (user) return user.profile_key;
    if (!['guest', 'an', 'binh'].includes(String(selector))) throw new PipelineError('unauthorized', 401);
    const key = 'guest_' + randomUUID();
    await bridge.application.memory.createProfile({ demoKey: key, displayName: 'Friend', ageBand: '6-8', languageMode: 'vi', timezone: 'Asia/Ho_Chi_Minh' });
    return key;
  };
}

/** An engine bearer identifies a conversation. Account cookies independently
 * authorize its owner, including after a logout or account switch. */
export function registerAccountSessionAccess(api: Express, auth: AuthStore, sessions: SessionService, allowedOrigins: string[] = []): void {
  api.use('/api', async (request, _response, next) => {
    const path = request.path.toLowerCase().replace(/\/+$/u, '');
    const protectedRoute = path.startsWith('/sessions/') || path === '/profiles/current/config'
      || path === '/demo/panel' || path === '/demo/next-day';
    if (!protectedRoute) return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertAuthRequestOrigin(request, allowedOrigins);
    const profile = sessions.profile(bearerToken(request));
    if (profile.key.startsWith('guest_')) return next();
    const user = await authenticateRequest(request, auth);
    if (!user) throw new PipelineError('unauthorized', 401);
    if (user.profile_key !== profile.key) throw new PipelineError('forbidden', 403);
    next();
  });
}
