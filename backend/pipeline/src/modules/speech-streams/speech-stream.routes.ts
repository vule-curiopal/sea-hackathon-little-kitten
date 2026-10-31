import type { Server, IncomingMessage } from 'node:http';
import type { Express } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';
import { identifier } from '../../http/request.js';
import { createRealtimeSttFactory, type RealtimeSttFactory } from '../../providers/elevenlabs/realtime-stt.provider.js';
import type { SessionService } from '../sessions/session.service.js';
import type { TurnService } from '../turns/turn.service.js';
import { SpeechStreamService } from './speech-stream.service.js';

const modules = new WeakMap<Express, { attach(server: Server): void; dispose(): void }>();
export function attachSpeechStreams(app: Express, server: Server): void { modules.get(app)?.attach(server); }

export function registerSpeechStreams(app: Express, config: VoiceConfig, sessions: SessionService, turns: TurnService,
  factory: RealtimeSttFactory = createRealtimeSttFactory(config)): () => void {
  app.get('/api/voice/capabilities', (_request, response) => response.json({
    input_mode: config.speechInputMode, realtime_available: config.mode === 'real',
    silence_ms: config.realtimeSilenceMs, filter_background_audio: true, max_recording_ms: 30000,
  }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const pending = new Map<string, number>();
  let attached: Server | undefined;
  const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const path = request.url?.split('?')[0] ?? '';
    const match = /^\/api\/sessions\/([a-f0-9-]{36})\/speech-stream$/.exec(path);
    if (!match || request.url?.includes('?') || config.mode !== 'real' || wss.clients.size >= 16) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
    }
    const origin = request.headers.origin;
    const host = request.headers.host;
    const sameOrigin = origin && host && (origin === `https://${host}` || origin === `http://${host}`);
    if (!origin || (!config.allowedOrigins.includes(origin) && !sameOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const address = request.socket.remoteAddress ?? '';
    if ((pending.get(address) ?? 0) >= 4) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return;
    }
    pending.set(address, (pending.get(address) ?? 0) + 1);
    wss.handleUpgrade(request, socket, head, ws => {
      let service: SpeechStreamService | undefined;
      let started = false, done = false, failing = false;
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) { ws.terminate(); return; }
        alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 20_000);
      heartbeat.unref();
      const emit = (message: Record<string, unknown>) => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 2 * 1024 * 1024) throw new PipelineError('speech_backpressure', 503);
        ws.send(JSON.stringify(message));
      };
      const fail = (error: unknown) => {
        if (failing || done) return;
        failing = true;
        const failure = publicSpeechError(error);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stream.error', ...failure }));
        service?.cancel();
        ws.close(1008, 'Speech stream stopped');
      };
      const authenticate = setTimeout(() => fail(new PipelineError('unauthorized', 401)), 5000);
      const onMessage = async (raw: import('ws').RawData, binary: boolean) => {
        if (failing || done) return;
        if (binary) {
          const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          if (!service || bytes.length < 6) throw new PipelineError('invalid_audio_sequence', 400);
          service.audio(bytes.readUInt32LE(0), bytes.subarray(4)); return;
        }
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!started) {
          started = true;
          if (data.type !== 'stream.start' || typeof data.token !== 'string' || data.token.length > 512) throw new PipelineError('unauthorized', 401);
          const session = sessions.session(identifier(match[1]), data.token);
          const turnId = identifier(data.request_id);
          if (data.language !== session.profile.configuration.language_mode) throw new PipelineError('language_mismatch', 400);
          service = new SpeechStreamService({ config, sessions, turns, session, turnId, factory, emit, fail });
          clearTimeout(authenticate);
          await service.start(); return;
        }
        if (!service) throw new PipelineError('invalid_request', 400);
        if (data.type === 'stream.cancel') { fail(new PipelineError('turn_canceled', 409)); return; }
        if (data.type !== 'audio.end' || !Number.isSafeInteger(data.last_seq)) throw new PipelineError('invalid_request', 400);
        const response = await service.end(Number(data.last_seq));
        if (failing) return;
        emit({ type: 'turn.result', response }); done = true; ws.close(1000);
      };
      ws.on('message', (raw, binary) => { void onMessage(raw, binary).catch(fail); });
      ws.on('error', fail);
      ws.on('close', () => {
        clearTimeout(authenticate);
        clearInterval(heartbeat);
        pending.set(address, Math.max(0, (pending.get(address) ?? 1) - 1));
        if (!pending.get(address)) pending.delete(address);
        if (!done) service?.cancel();
      });
    });
  };
  const dispose = () => {
    attached?.removeListener('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  modules.set(app, { attach(server) { attached = server; server.on('upgrade', upgrade); }, dispose });
  return dispose;
}

/** Match HTTP's stable engine error boundary; never expose provider messages or payloads. */
export function publicSpeechError(error: unknown): { code: string; status: number; retryable: boolean } {
  if (error instanceof PipelineError) return { code: error.code, status: error.status, retryable: error.retryable };
  if (error instanceof Error) {
    const engine = error as Error & { code?: unknown; status?: unknown };
    if ((engine.name === 'AppError' || engine.constructor.name === 'AppError')
      && typeof engine.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(engine.code)
      && typeof engine.status === 'number' && Number.isSafeInteger(engine.status) && engine.status >= 400 && engine.status <= 599) {
      return { code: engine.code, status: engine.status, retryable: [429, 503, 504].includes(engine.status) };
    }
  }
  return { code: 'speech_stream_failed', status: 500, retryable: false };
}
