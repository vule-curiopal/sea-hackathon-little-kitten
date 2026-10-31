import type { Express } from 'express';
import { PipelineError } from '../../errors.js';
import { bearerToken, identifier, object } from '../../http/request.js';
import { logEvent } from '../../logger.js';
import type { SessionService } from '../sessions/session.service.js';

const knownCodes = new Set(['MIC_PERMISSION_DENIED', 'MIC_UNAVAILABLE', 'MIC_NOT_FOUND', 'INSECURE_CONTEXT',
  'UNSUPPORTED_AUDIO', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE', 'PLAYBACK_FAILED', 'INVALID_AUDIO',
  'CAPTURE_INTERRUPTED', 'ANALYSIS_GAP', 'PAGE_HIDDEN', 'NO_SIGNAL', 'NO_AUDIO', 'RECORDING_LIMIT',
  'unclear_audio', 'recording_limit', 'speech_stream_failed', 'speech_stream_closed', 'speech_drain_timeout',
  'provider_quota_exceeded', 'provider_rate_limited', 'provider_unavailable', 'provider_configuration', 'provider_timeout',
  'session_closed', 'session_not_found', 'unauthorized', 'stale_state', 'model_output_rejected', 'model_safety_rejected']);

export function registerClientEvents(app: Express, sessions: SessionService): void {
  const counts = new WeakMap<object, { at: number; count: number }>();
  app.post('/api/client-events', (request, response) => {
    const body = object(request.body);
    if (Object.keys(body).some(k => !['session_id', 'code'].includes(k)) || typeof body.code !== 'string') throw new PipelineError('invalid_request', 400);
    const session = sessions.session(identifier(body.session_id), bearerToken(request));
    const now = Date.now();
    const count = counts.get(session);
    const bucket = count && now - count.at < 60_000 ? count : { at: now, count: 0 };
    counts.set(session, bucket);
    if (++bucket.count > 10) throw new PipelineError('rate_limited', 429, true);
    logEvent('client.error', { session_id: session.id, code: knownCodes.has(body.code) ? body.code : 'unknown_client_error' });
    response.status(204).end();
  });
}
