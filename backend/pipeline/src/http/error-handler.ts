import type { ErrorRequestHandler, Express, Request } from 'express';
import type { Language } from '@miu/voice-contracts';
import { PipelineError } from '../errors.js';
import type { SessionService } from '../modules/sessions/session.service.js';
import { bearerToken } from './request.js';

export type RequestContexts = WeakMap<Request, { language: Language; turnId?: string }>;

/** Register after routes so only stable public errors cross the HTTP boundary. */
export function registerErrorHandler(app: Express, sessions: SessionService, contexts: RequestContexts): void {
  const handler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    let code = 'internal_error';
    let status = 500;
    let retryable = false;
    const framework = error && typeof error === 'object'
      ? error as { statusCode?: unknown; status?: unknown; code?: unknown }
      : {};
    const rawStatus = framework.statusCode ?? framework.status;
    const frameworkStatus = typeof rawStatus === 'number' && Number.isSafeInteger(rawStatus) ? rawStatus : undefined;
    const frameworkCode = typeof framework.code === 'string' ? framework.code : undefined;
    if (error instanceof PipelineError) {
      code = error.code;
      status = error.status;
      retryable = error.retryable;
    } else if (frameworkStatus === 413 || frameworkCode === 'LIMIT_FILE_SIZE') {
      code = 'recording_too_large';
      status = 413;
    } else if (frameworkStatus === 429) {
      code = 'rate_limited';
      status = 429;
      retryable = true;
    } else if ((frameworkStatus && frameworkStatus < 500) || frameworkCode?.startsWith('LIMIT_')) {
      code = 'invalid_request';
      status = 400;
    }
    const context = contexts.get(request);
    let language = context?.language ?? 'vi';
    if (!context) {
      try {
        language = sessions.profile(bearerToken(request)).configuration.language_mode;
      } catch {
        // The request may not yet have an authenticated profile/language.
      }
    }
    response.status(status).json({
      error: { code, message: language === 'en' ? 'Please try again.' : 'Bạn thử lại nhé.', retryable },
      ...(context?.turnId ? { turn_id: context.turnId } : {}),
    });
  };
  app.use(handler);
}
