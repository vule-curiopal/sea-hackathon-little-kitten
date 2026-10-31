import { Router, type Express } from 'express';
import { VOICES } from '@miu/voice-contracts';
import type { VoiceConfig } from '../../config.js';
import { bearerToken } from '../../http/request.js';
import type { SessionService } from '../sessions/session.service.js';

/** Small read-only diagnostics; no pipeline or provider work runs in these routes. */
export function registerSystemRoutes(app: Express, config: VoiceConfig, sessions: SessionService): void {
  const router = Router();
  router.get('/health', (_request, response) => response.json({
    status: 'ok', provider_mode: config.mode, engine_mode: 'voice_stub',
    retention: 'not_verified_by_this_service',
  }));
  router.get('/voices', (_request, response) => response.json({ voices: VOICES, defaults: config.defaultVoices }));
  router.get('/demo/panel', (request, response) => {
    const profile = sessions.profile(bearerToken(request));
    return response.json({
      provider_mode: config.mode, engine_mode: 'voice_stub', configuration: profile.configuration,
      state_version: profile.stateVersion, clock_version: 1, active_turn: profile.active?.id ?? null,
      memory_available: false, character_engine_available: false,
    });
  });
  app.use('/api', router);
}
