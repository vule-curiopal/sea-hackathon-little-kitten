import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MiuApplication } from './application.js';
import { createMemoryStore } from './memory/index.js';
import { createProvider } from './pipeline/providers.js';
import { AppError, PERSONALITIES } from './shared/types.js';

const BODY_LIMIT = 16 * 1_024;
const PREFIX = '/api/engine';
const Id = z.uuid();
const SessionRequest = z.object({ demo_profile_key: z.enum(['an', 'binh']) }).strict();
const TurnRequest = z.object({
  request_id: Id,
  kind: z.enum(['utterance', 'greeting']),
  text: z.string().trim().min(1).max(2_000).optional(),
}).strict().refine(value => value.kind === 'greeting' ? value.text === undefined : value.text !== undefined);
const PlaybackRequest = z.object({ request_id: Id, status: z.enum(['started', 'completed', 'interrupted']), state_version: z.number().int().nonnegative() }).strict();
const NextDayRequest = z.object({ request_id: Id, expected_clock_version: z.number().int().nonnegative() }).strict();
const ConfigRequest = z.object({
  request_id: Id.optional(),
  personality: z.enum(PERSONALITIES).optional(),
  role: z.enum(['friend', 'big_sibling', 'teacher']).optional(),
  language_mode: z.enum(['en', 'vi', 'follow_child']).optional(),
  voice_id: z.literal('miu-default').optional(),
}).strict().refine(value => value.personality !== undefined || value.role !== undefined || value.language_mode !== undefined || value.voice_id !== undefined);

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
    request.resume();
    throw new AppError('unsupported_media_type', 415);
  }
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT) { request.resume(); throw new AppError('request_too_large', 413); }
  return new Promise((resolveBody, reject) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    request.on('data', (value: Buffer | string) => {
      if (rejected) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        rejected = true; chunks = [];
        reject(new AppError('request_too_large', 413));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      if (rejected) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        resolveBody(JSON.parse(text));
      } catch { reject(new AppError('invalid_json', 400)); }
    });
    request.once('error', () => reject(new AppError('invalid_request', 400)));
    request.once('aborted', () => reject(new AppError('invalid_request', 400)));
  });
}
function token(request: IncomingMessage): string | undefined {
  return /^Bearer ([A-Za-z0-9._-]+)$/iu.exec(request.headers.authorization ?? '')?.[1];
}

export interface EngineServerOptions { demoMode?: boolean; sweepIntervalMs?: number }

/** A local JSON integration API. Audio capture, STT, TTS and playback are owned
 * by the separate voice pipeline; receipts here are explicit text-harness events. */
export function createEngineHandler(app: MiuApplication, options: EngineServerOptions = {}) {
  let bootstrap: Promise<void> | undefined;
  const configReceipts = new Map<string, { signature: string; promise: Promise<unknown>; at: number }>();
  const ensureProfiles = () => bootstrap ??= app.bootstrap().catch(error => { bootstrap = undefined; throw error; });
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const method = request.method ?? 'GET';
      if (method === 'GET' && pathname === '/health') {
        json(response, 200, { status: 'ok', provider_mode: app.provider.mode, capabilities: { text: true, audio: false }, demo_mode: options.demoMode ?? true });
        return;
      }
      if (options.demoMode === false || !pathname.startsWith(PREFIX + '/')) throw new AppError('not_found', 404);
      if (method === 'POST' && pathname === PREFIX + '/sessions') {
        const body = SessionRequest.parse(await readJson(request));
        await ensureProfiles();
        json(response, 201, await app.openSession(body.demo_profile_key));
        return;
      }
      const profileId = app.profileForToken(token(request));
      if (method === 'GET' && pathname === PREFIX + '/profile') {
        json(response, 200, await app.getContext(profileId));
        return;
      }
      if (method === 'PATCH' && pathname === PREFIX + '/config') {
        const body = ConfigRequest.parse(await readJson(request));
        const { request_id, ...configuration } = body;
        const receiptKey = request_id ? profileId + ':' + request_id : null;
        const signature = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
        const old = receiptKey && configReceipts.get(receiptKey);
        if (old && Date.now() - old.at < 30 * 60_000) {
          if (old.signature !== signature) throw new AppError('idempotency_conflict', 409);
          json(response, 200, await old.promise);
          return;
        }
        const work = app.updateConfig(profileId, {
          personality: body.personality, role: body.role, languageMode: body.language_mode, voiceId: body.voice_id,
        }).then(context => ({ config: context.config, language_mode: context.profile.languageMode, state_version: context.profile.stateVersion }));
        // Config receipts deliberately contain no personal memories or child name.
        if (receiptKey) {
          if (configReceipts.size >= 1_000) configReceipts.delete(configReceipts.keys().next().value!);
          configReceipts.set(receiptKey, { signature, promise: work, at: Date.now() });
        }
        let result: unknown;
        try { result = await work; }
        catch (error) { if (receiptKey) configReceipts.delete(receiptKey); throw error; }
        json(response, 200, result);
        return;
      }
      if (method === 'POST' && pathname === PREFIX + '/next-day') {
        const body = NextDayRequest.parse(await readJson(request));
        json(response, 200, await app.nextDay(profileId, body.request_id, body.expected_clock_version));
        return;
      }
      const playback = /^\/api\/engine\/sessions\/([^/]+)\/turns\/([^/]+)\/playback$/u.exec(pathname);
      if (playback && method === 'POST') {
        const body = PlaybackRequest.parse(await readJson(request));
        json(response, 200, await app.playback(profileId, Id.parse(playback[1]), Id.parse(playback[2]), body));
        return;
      }
      const turn = /^\/api\/engine\/sessions\/([^/]+)\/turns\/([^/]+)$/u.exec(pathname);
      if (turn && method === 'DELETE') {
        json(response, 200, await app.cancel(profileId, Id.parse(turn[1]), Id.parse(turn[2])));
        return;
      }
      const turns = /^\/api\/engine\/sessions\/([^/]+)\/turns$/u.exec(pathname);
      if (turns && method === 'POST') {
        const body = TurnRequest.parse(await readJson(request));
        json(response, 200, await app.prepareTurn(profileId, Id.parse(turns[1]), body));
        return;
      }
      const session = /^\/api\/engine\/sessions\/([^/]+)$/u.exec(pathname);
      if (session && method === 'DELETE') {
        json(response, 200, await app.closeSession(profileId, Id.parse(session[1])));
        return;
      }
      throw new AppError('not_found', 404);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 503;
      const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? 'invalid_request' : 'internal_error';
      json(response, status, { error: { code }, ...(error instanceof AppError ? error.invalidation : undefined) });
    }
  };
}

export function createEngineServer(app: MiuApplication, options: EngineServerOptions = {}) {
  const handler = createEngineHandler(app, options);
  const server = createServer((request, response) => { void handler(request, response); });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  let maintenanceRunning = false;
  const interval = setInterval(() => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    void app.maintain().catch(() => undefined).finally(() => { maintenanceRunning = false; });
  }, options.sweepIntervalMs ?? 60_000);
  interval.unref();
  server.once('close', () => clearInterval(interval));
  return server;
}

/** Supplying an environment object makes startup hermetic and skips .env reads. */
export async function startEngineServer(environment?: Record<string, string | undefined>) {
  if (!environment) {
    try { loadEnvFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('invalid_environment', 503); }
  }
  const env = environment ?? process.env;
  if (env.DEMO_MODE === 'false') throw new AppError('demo_mode_required', 503);
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new AppError('loopback_host_required', 503);
  const port = z.coerce.number().int().min(1).max(65_535).parse(env.PORT ?? '3001');
  const provider = createProvider(env);
  const memory = await createMemoryStore({ databaseUrl: env.DATABASE_URL, dataDir: env.DATABASE_URL ? undefined : env.MIU_DATA_DIR ?? resolve('.miu-data'), clockMode: 'demo' });
  const app = new MiuApplication(memory, provider);
  const server = createEngineServer(app, { demoMode: true });
  try {
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolveListening(); });
    });
  } catch (error) { server.close(); await app.close(); throw error; }
  return { server, app, host, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startEngineServer().then(({ server, app, host, port }) => {
    process.stdout.write('Miu text engine listening at http://' + host + ':' + port + '\n');
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.close(() => { void app.close().finally(() => { process.exitCode = 0; }); });
      server.closeIdleConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch(() => {
    process.stderr.write('Miu text engine failed to start. Check the local configuration.\n');
    process.exitCode = 1;
  });
}
