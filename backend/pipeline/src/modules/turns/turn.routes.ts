import { Router, type Express } from 'express';
import { createTurnUploadMiddleware } from '../../http/multipart.js';
import type { TurnController } from './turn.controller.js';

export function registerTurnRoutes(app: Express, controller: TurnController): void {
  const router = Router();
  router.post('/sessions/:session_id/turns', controller.authorize, createTurnUploadMiddleware(), controller.submit);
  router.delete('/sessions/:session_id/turns/:turn_id', controller.cancel);
  router.post('/sessions/:session_id/turns/:turn_id/playback', controller.playback);
  app.use('/api', router);
}
