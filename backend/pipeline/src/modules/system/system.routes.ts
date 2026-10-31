import { Router, type Express } from 'express';
import { VOICES } from '@miu/voice-contracts';
import type { VoiceConfig } from '../../config.js';
import { bearerToken } from '../../http/request.js';
import type { SessionService } from '../sessions/session.service.js';

/** Small read-only diagnostics; no pipeline or provider work runs in these routes. */
export function registerSystemRoutes(app: Express, config: VoiceConfig, sessions: SessionService): void {
  const router = Router();
  router.get('/health', (_request, response) => response.json({
    status: 'ok', provider_mode: config.mode, engine_mode: sessions.engineBridge ? 'character_memory' : 'voice_stub',
    capabilities: { text: true, audio: true, memory: !!sessions.engineBridge },
    retention: 'not_verified_by_this_service',
  }));
  router.get('/voices', (_request, response) => response.json({ voices: VOICES, defaults: config.defaultVoices }));
  router.get('/demo/panel', async (request, response) => {
    const profile = sessions.profile(bearerToken(request));
    if (sessions.engineBridge) sessions.applySnapshot(profile, await sessions.engineBridge.context(profile.token));
    return response.json({
      provider_mode: config.mode, engine_mode: sessions.engineBridge ? 'character_memory' : 'voice_stub', configuration: profile.configuration,
      state_version: profile.stateVersion, clock_version: profile.clockVersion ?? 1, active_turn: profile.active?.id ?? null,
      memory_available: !!sessions.engineBridge, character_engine_available: !!sessions.engineBridge,
    });
  });
  app.use('/api', router);
}
