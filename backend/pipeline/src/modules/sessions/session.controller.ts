import type { Request, Response } from 'express';
import type { ProviderMode, SessionResponse } from '@miu/voice-contracts';
import { PipelineError } from '../../errors.js';
import { bearerToken, identifier, object } from '../../http/request.js';
import type { SessionService } from './session.service.js';

/** Translate HTTP input/output; session rules live in SessionService. */
export class SessionController {
  constructor(private readonly sessions: SessionService, private readonly providerMode: ProviderMode,
    private readonly resolveProfile?: (request: Request) => Promise<string>) {}

  readonly create = async (request: Request, response: Response) => {
    const body = object(request.body);
    if (Object.keys(body).some(key => !['demo_profile_key', 'request_id'].includes(key))
      || (body.demo_profile_key !== undefined && typeof body.demo_profile_key !== 'string')
      || (!this.resolveProfile && typeof body.demo_profile_key !== 'string')) {
      throw new PipelineError('invalid_request', 400);
    }
    const requestId = identifier(body.request_id);
    const key = this.resolveProfile ? await this.resolveProfile(request) : body.demo_profile_key as string;
    const session = await this.sessions.createSession(key, requestId, !!this.resolveProfile);
    const result: SessionResponse = {
      session_id: session.id,
      demo_token: session.profile.token,
      configuration: { ...session.profile.configuration },
      clock_version: session.profile.clockVersion ?? 1,
      state_version: session.profile.stateVersion,
      effective_now: session.profile.effectiveNow ?? new Date().toISOString(),
      provider_mode: this.providerMode,
      engine_mode: this.sessions.engineBridge ? 'character_memory' : 'voice_stub',
    };
    return response.json(result);
  };

  readonly configure = async (request: Request, response: Response) => {
    const body = object(request.body);
    const result = await this.sessions.configureProfile(
      this.sessions.profile(bearerToken(request)), identifier(body.request_id), body,
    );
    return response.json(result);
  };

  readonly close = async (request: Request, response: Response) => {
    const session = this.sessions.session(
      identifier(object(request.params).session_id), bearerToken(request),
    );
    await this.sessions.closeSession(session);
    return response.json({ session_id: session.id, closed: true });
  };
}
