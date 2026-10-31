import { Router, type Express } from 'express';
import type { SessionController } from './session.controller.js';

export function registerSessionRoutes(app: Express, controller: SessionController): void {
  const router = Router();
  router.post('/sessions', controller.create);
  router.patch('/profiles/current/config', controller.configure);
  router.delete('/sessions/:session_id', controller.close);
  app.use('/api', router);
}
