import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { createEngineBridge } from './engine-bridge.js';
import { ensureDatabaseTunnel } from '../scripts/database-tunnel.js';
import { buildApp, disposeApp } from '../pipeline/src/app.js';
import { loadConfig } from '../pipeline/src/config.js';
import { PipelineError } from '../pipeline/src/errors.js';
import { bearerToken, identifier, object } from '../pipeline/src/http/request.js';
import { createServer } from '../pipeline/src/server-runtime.js';

/** Single composition: real STT/TTS, persistent character engine, and React UI. */
export async function createIntegratedApp(environment: Record<string, string | undefined> = process.env) {
  const hasLoggingChoice = !!(environment.STT_LOGGING?.trim() || environment.ELEVENLABS_ENABLE_LOGGING?.trim());
  const env: Record<string, string | undefined> = { ...environment, MIU_PROVIDER: 'real',
    // Preserve either explicit spelling, including conflicts for loadConfig to reject.
    ...(!hasLoggingChoice ? { STT_LOGGING: '0' } : {}),
    TURN_PROCESSING_TIMEOUT_MS: environment.TURN_PROCESSING_TIMEOUT_MS ?? '90000',
    STT_TIMEOUT_MS: environment.STT_TIMEOUT_MS ?? '30000',
    TTS_TIMEOUT_MS: environment.TTS_TIMEOUT_MS ?? '30000' };
  await ensureDatabaseTunnel(env);
  const config = loadConfig(env);
  const bridge = await createEngineBridge({ env, defaultVoices: config.defaultVoices });
  const dayReceipts = new Map<string, { expected: number; work: Promise<unknown> }>();
  let maintenance: ReturnType<typeof setInterval> | undefined;
  try {
    const app = await buildApp({ config, engineBridge: bridge, registerRoutes: (api, sessions) => {
      api.get('/api/demo/panel', async (request, response) => {
        const token = bearerToken(request);
        const profile = sessions.profile(token);
        const panel = await bridge.demoPanel(profile.token);
        sessions.applySnapshot(profile, panel);
        return response.json({ ...panel, context: panel, memory_available: true,
          character_engine_available: true, active_turn: profile.active?.id ?? null,
          storage: env.DATABASE_URL ? 'postgresql' : 'pglite' });
      });
      api.post('/api/demo/next-day', async (request, response) => {
        const profile = sessions.profile(bearerToken(request));
        const body = object(request.body);
        if (Object.keys(body).some(key => !['request_id', 'expected_clock_version'].includes(key))
          || !Number.isSafeInteger(body.expected_clock_version) || Number(body.expected_clock_version) < 0) throw new PipelineError('invalid_request', 400);
        const id = identifier(body.request_id);
        const key = profile.key + ':' + id;
        const old = dayReceipts.get(key);
        if (old && old.expected !== body.expected_clock_version) throw new PipelineError('idempotency_conflict', 409);
        if (old) return response.json(await old.work);
        if (profile.active) throw new PipelineError('turn_in_progress', 409);
        const work = bridge.nextDay(profile.token, id, Number(body.expected_clock_version)).then(async result => {
          sessions.applySnapshot(profile, await bridge.context(profile.token));
          return { ...result, effective_now: result.clock.effectiveNow, local_date: result.clock.localDate,
            clock_version: result.clock.version, state_version: result.stateVersion, previous_session_closed: true };
        });
        dayReceipts.set(key, { expected: Number(body.expected_clock_version), work });
        if (dayReceipts.size > 1000) dayReceipts.delete(dayReceipts.keys().next().value!);
        try { return response.json(await work); }
        catch (error) { dayReceipts.delete(key); throw error; }
      });
      const frontend = resolve(env.MIU_FRONTEND_DIR ?? 'frontend/dist');
      if (existsSync(resolve(frontend, 'index.html'))) {
        api.use(express.static(frontend, { index: false }));
        api.get(/^(?!\/api(?:\/|$)).*$/u, (request, response, next) => {
          if (!request.accepts('html')) return next();
          return response.sendFile(resolve(frontend, 'index.html'));
        });
      }
    } });
    let maintenanceRunning = false;
    maintenance = setInterval(() => {
      if (maintenanceRunning) return;
      maintenanceRunning = true;
      void bridge.maintain().catch(() => undefined).finally(() => { maintenanceRunning = false; });
    }, 60_000);
    maintenance.unref();
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async () => {
      if (maintenance) clearInterval(maintenance);
      disposeApp(app);
      await bridge.close();
    })();
    return { app, bridge, config, close };
  } catch (error) {
    if (maintenance) clearInterval(maintenance);
    await bridge.close();
    throw error;
  }
}

export async function startIntegratedServer(environment?: Record<string, string | undefined>) {
  if (!environment && existsSync('.env')) loadEnvFile('.env');
  const integrated = await createIntegratedApp(environment ?? process.env);
  const server = createServer(integrated.app);
  try {
    const url = await server.listen({ host: integrated.config.host, port: integrated.config.port });
    return { ...integrated, server, url, close: async () => { await server.close(); await integrated.close(); } };
  } catch (error) { await integrated.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startIntegratedServer().then(runtime => {
    process.stdout.write(`Miu integrated app listening at ${runtime.url}\n`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void runtime.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch(() => {
    process.stderr.write('Miu integrated app could not start. Check PostgreSQL, the SSH tunnel, and real-provider configuration.\n');
    process.exitCode = 1;
  });
}
