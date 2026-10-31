import express, { type Express } from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { LIMITS } from '@miu/voice-contracts';
import type { VoiceConfig } from '../config.js';
import { PipelineError } from '../errors.js';
import { registerMultipartLimit } from '../multipart-limit.js';

/** Install transport policy before feature routers; uploads remain route-scoped. */
export function registerHttpMiddleware(app: Express, config: VoiceConfig): void {
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || config.allowedOrigins.includes(origin)) }));
  app.use(rateLimit({
    limit: 60, windowMs: 60_000, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_request, _response, next) => next(new PipelineError('rate_limited', 429, true)),
  }));
  registerMultipartLimit(app);
  app.use(express.json({ limit: LIMITS.requestBytes }));
}
