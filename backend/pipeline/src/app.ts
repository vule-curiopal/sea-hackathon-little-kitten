import express, { type Express } from 'express';
import { loadConfig, type VoiceConfig } from './config.js';
import { PipelineError } from './errors.js';
import { registerErrorHandler, type RequestContexts } from './http/error-handler.js';
import { registerHttpMiddleware } from './http/middleware.js';
import { SessionController } from './modules/sessions/session.controller.js';
import { registerSessionRoutes } from './modules/sessions/session.routes.js';
import { SessionService } from './modules/sessions/session.service.js';
import { registerSystemRoutes } from './modules/system/system.routes.js';
import { TurnController } from './modules/turns/turn.controller.js';
import { registerTurnRoutes } from './modules/turns/turn.routes.js';
import { TurnService } from './modules/turns/turn.service.js';
import { registerSpeechStreams } from './modules/speech-streams/speech-stream.routes.js';
import type { RealtimeSttFactory } from './providers/elevenlabs/realtime-stt.provider.js';
import type { EngineBridge, PipelineProviders } from './ports.js';
import { createProviders } from './providers/index.js';
import { registerClientEvents } from './modules/system/client-events.routes.js';

export interface BuildAppOptions {
  config?: VoiceConfig;
  providers?: PipelineProviders;
  realtimeStt?: RealtimeSttFactory;
  /** Retained name for existing callers; this is RAM-only session/protocol state. */
  state?: SessionService;
  engineBridge?: EngineBridge;
  registerRoutes?: (app: Express, sessions: SessionService) => void | Promise<void>;
}

const disposers = new WeakMap<Express, () => void>();

/** Abort work and clear timers before the HTTP server closes its sockets. */
export function disposeApp(app: Express): void {
  const dispose = disposers.get(app);
  disposers.delete(app);
  dispose?.();
}

/** Composition root: build dependencies, register HTTP modules and own shutdown. */
export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const providers = options.providers ?? await createProviders(config);
  if (providers.mode !== config.mode) throw new Error('Provider mode must match server configuration');
  if (options.engineBridge && options.engineBridge.mode !== providers.mode) throw new Error('Engine and voice provider modes must match');

  const sessions = options.state ?? new SessionService(config.defaultVoices);
  if (options.engineBridge) sessions.attachEngine(options.engineBridge);
  const turns = new TurnService({ config, providers, sessions });
  const contexts: RequestContexts = new WeakMap();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyLoopback ? 'loopback' : false);

  registerHttpMiddleware(app, config);
  await options.registerRoutes?.(app, sessions);
  registerSystemRoutes(app, config, sessions);
  registerClientEvents(app, sessions);
  registerSessionRoutes(app, new SessionController(sessions, providers.mode));
  registerTurnRoutes(app, new TurnController(sessions, turns, contexts));
  const disposeStreams = registerSpeechStreams(app, config, sessions, turns, options.realtimeStt);
  app.use(() => { throw new PipelineError('not_found', 404); });
  registerErrorHandler(app, sessions, contexts);

  const expiry = setInterval(() => sessions.sweep(), 60_000);
  expiry.unref();
  disposers.set(app, () => {
    clearInterval(expiry);
    disposeStreams();
    sessions.dispose();
  });

  return app;
}
