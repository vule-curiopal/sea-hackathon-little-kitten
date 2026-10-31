import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../backend/pipeline/src/app.js';
import { loadConfig } from '../backend/pipeline/src/config.js';
import { createServer } from '../backend/pipeline/src/server-runtime.js';
import { createRealProviders } from '../backend/pipeline/src/providers/real.js';
import { createRealtimeSttFactory } from '../backend/pipeline/src/providers/elevenlabs/realtime-stt.provider.js';
import { createEngineBridge } from '../backend/integration/engine-bridge.js';
import { ensureDatabaseTunnel } from '../backend/scripts/database-tunnel.js';
import { OpenAIProvider } from '../backend/pipeline/providers.js';
import { VoiceApiClient } from '../packages/voice-client/src/api.js';
import { Pcm16Encoder } from '../packages/voice-client/src/realtime/pcm.js';

const { values } = parseArgs({ options: { real: { type: 'boolean' }, ids: { type: 'string' }, output: { type: 'string' } } });
if (!values.real) throw new Error('Pass --real to allow billable STT, character engine and TTS requests.');
const corpus = new URL('../test-assets/voice-pipeline/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', corpus), 'utf8'));
const ids = values.ids?.split(',');
if (ids?.some(id => !manifest.assets.some((a: any) => a.id === id))) throw new Error('Unknown corpus ID');
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' })
  .format(new Date()).replace(/[ :]/g, '-');
const output = resolve(values.output ?? `reports/voice-latency-${stamp}`);
await mkdir(output, { recursive: true });
const schema = `miu_voice_latency_${randomUUID().replaceAll('-', '')}`;
if (!/^miu_voice_latency_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid test schema');
const target = new URL(process.env.DATABASE_URL!);
target.searchParams.set('options', `-c search_path=${schema}`);
const config = loadConfig({ ...process.env, MIU_PROVIDER: 'real', VOICE_INPUT_MODE: 'elevenlabs_realtime' });
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let bridge: Awaited<ReturnType<typeof createEngineBridge>> | undefined;
let runtime: ReturnType<typeof createServer> | undefined;
let madeSchema = false, removedSchema = false;
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
let current: any;
const results: any[] = [];
const safeCode = (error: any) => typeof error?.code === 'string' && /^[a-zA-Z_0-9]{1,80}$/.test(error.code) ? error.code : 'measurement_failed';
const ms = (value: number) => Math.round(value * 10) / 10;
const point = () => ms(performance.now());

function union(intervals: number[][]): number {
  let total = 0, end = -Infinity;
  for (const [a, b] of intervals.sort((x, y) => x[0]! - y[0]!)) {
    if (b! <= end) continue;
    total += b! - Math.max(a!, end); end = b!;
  }
  return total;
}
function decode(bytes: Buffer): Buffer {
  const encoder = new Pcm16Encoder(bytes.readUInt32LE(24)); let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(offset + 8 + i * 2) / 32768;
      const chunks = encoder.push(samples), last = encoder.flush(); if (last) chunks.push(last);
      return Buffer.concat(chunks);
    }
    offset += 8 + size + size % 2;
  }
  throw new Error('Invalid WAV');
}
async function save(): Promise<void> {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    measured_at: new Date().toISOString(), timezone: 'Asia/Ho_Chi_Minh', schema, schema_removed: removedSchema,
    performance_time_origin_ms: performance.timeOrigin,
    database_instrumentation: 'Queries and exec inside/outside transactions, plus transaction wall spans. Individual transaction queries include sequential queue wait; use union spans, not summed durations.',
    scope: 'Real paced PCM -> realtime STT -> current real character/memory engine on an isolated PostgreSQL schema -> real TTS. Last-speech timing uses TTS clip segment bounds, not human word alignment. Result latency ends at MP3 receipt, not physical playback.',
    config: { silence_ms: config.realtimeSilenceMs, filter_background_audio: true,
      engine_models: bridge?.application.provider instanceof OpenAIProvider ? bridge.application.provider.modelIds : null,
      tts_model: config.ttsModel, sample_rate: 16000, chunk_ms: 200 },
    summary: { attempted: results.length, completed: results.filter(r => r.status === 'completed').length,
      rejected: results.filter(r => r.status === 'rejected').length, failed: results.filter(r => r.status === 'failed').length },
    assets: results,
  }, null, 2) + '\n');
}

try {
  await ensureDatabaseTunnel(process.env);
  await admin.query(`CREATE SCHEMA "${schema}"`); madeSchema = true;
  bridge = await createEngineBridge({ env: { ...process.env, DATABASE_URL: target.toString() }, defaultVoices: config.defaultVoices });
  if (!(bridge.application.provider instanceof OpenAIProvider)) throw new Error('Real engine provider required');
  const provider = bridge.application.provider;
  const db = bridge.application.memory.db;
  const actualSchema = (await db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema;
  if (actualSchema !== schema) throw new Error('Schema isolation failed');
  const originalQuery = db.query.bind(db);
  (db as any).query = async (...args: any[]) => {
    const row = current, start = point();
    try { return await (originalQuery as any)(...args); }
    finally { if (row) row.database.push({ start_ms: start, end_ms: point(), operation: typeof args[0] === 'string' ? args[0].trim().split(/\s+/, 1)[0]?.toUpperCase() : 'QUERY' }); }
  };
  const originalTransaction = db.transaction.bind(db);
  (db as any).transaction = async (work: any) => {
    const row = current, start = point();
    try {
      return await originalTransaction(async tx => {
        const query = tx.query.bind(tx), exec = tx.exec.bind(tx);
        const timed = async (operation: string, action: () => Promise<any>) => {
          const start = point();
          try { return await action(); }
          finally { if (row) row.database.push({ start_ms: start, end_ms: point(), operation, inside_transaction: true }); }
        };
        return work({
          query: (sql: string, params?: unknown[]) => timed(sql.trim().split(/\s+/, 1)[0]!.toUpperCase(), () => query(sql, params)),
          exec: (sql: string) => timed('EXEC', () => exec(sql)),
        });
      });
    } finally { if (row) row.transactions.push({ start_ms: start, end_ms: point() }); }
  };
  const originalPrepare = bridge.prepare.bind(bridge);
  bridge.prepare = async (...args) => {
    const row = current; row.engine_start_ms = point(); row.engine_dispatches++;
    try { return await originalPrepare(...args); }
    catch (error) {
      row.engine_error_code = safeCode(error);
      const reply = provider.lastReply;
      if (reply && provider.telemetry.slice().reverse().find(r => r.stage === 'reply')?.responseId === reply.responseId) row.rejected_model_reply = reply.text;
      throw error;
    }
    finally { row.engine_end_ms = point(); }
  };
  const speechFetch: typeof fetch = async (...args) => {
    const row = current, start = point(), response = await fetch(...args);
    if (row) {
      row.tts_http = { start_ms: start, headers_ms: point(), status: response.status };
      const observed = response.clone().arrayBuffer().then(bytes => { row.tts_http.body_end_ms = point(); row.tts_http.bytes = bytes.byteLength; }).catch(() => {});
      row.observations.push(observed);
    }
    return response;
  };
  const voices = createRealProviders(config, speechFetch);
  const originalTts = voices.synthesize;
  voices.synthesize = async (...args) => {
    const row = current; row.tts_start_ms = point();
    try { return await originalTts(...args); } finally { row.tts_end_ms = point(); }
  };
  const baseFactory = createRealtimeSttFactory(config);
  runtime = createServer(await buildApp({ config, providers: voices, engineBridge: bridge,
    realtimeStt: (language, emit) => {
      const row = current; row.upstream_connect_start_ms = point();
      const connection = baseFactory(language, event => {
        if (event.type === 'committed') row.commits.push({ at_ms: point(), text_chars: event.text.length });
        emit(event);
      });
      return { ...connection, commit: () => { row.manual_commit_ms = point(); connection.commit(); } };
    },
  }));
  const baseUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
  const client = new VoiceApiClient({ baseUrl, requestTimeoutMs: 120000 });
  for (const asset of manifest.assets) {
    if (stopping) break;
    if (ids && !ids.includes(asset.id)) continue;
    current = { id: asset.id, language: asset.language ?? (asset.id.startsWith('10_') ? 'vi' : 'en'),
      speech_present: asset.speech_present, reference_last_speech_ms: asset.segments.at(-1)?.end_ms ?? null,
      events: [], database: [], transactions: [], commits: [], engine_dispatches: 0, observations: [] };
    const row = current; results.push(row);
    const beforeTelemetry = provider.telemetry.length;
    let session: any, socket: WebSocket | undefined, done = false, ending = false, sequence = 0;
    const requestId = randomUUID(); row.case_start_ms = point();
    try {
      session = await client.createSession(row.language === 'vi' ? 'an' : 'binh');
      session = { ...session, ...await client.configure(session, row.language) };
      row.profile_ready_ms = point();
      const original = decode(await readFile(new URL(asset.file, corpus)));
      const room = Math.min(96_000, Math.max(0, 960_000 - original.length));
      const tail = original.subarray(Math.max(0, original.length - 32_000));
      const padding = Buffer.from(Array.from({ length: room }, (_, i) => tail[i % tail.length]!));
      const pcm = Buffer.concat([original, padding]); row.added_background_tail_ms = room / 32;
      row.ws_start_ms = point();
      await new Promise<void>((resolveCase, rejectCase) => {
        socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/sessions/${session.session_id}/speech-stream`, { origin: baseUrl });
        const timeout = setTimeout(() => settle(new Error('timeout')), 180000);
        const settle = (error?: Error) => { if (done) return; done = true; clearTimeout(timeout); error ? rejectCase(error) : resolveCase(); };
        socket.on('error', () => settle(new Error('transport_error')));
        socket.on('close', () => { if (!done) settle(new Error('premature_close')); });
        socket.on('open', () => socket!.send(JSON.stringify({ type: 'stream.start', token: session.demo_token, request_id: requestId, language: row.language })));
        socket.on('message', raw => {
          const message = JSON.parse(raw.toString()), at = point(); row.events.push({ type: message.type, at_ms: at });
          if (message.type === 'stream.ready') {
            row.stream_ready_ms = at;
            row.reference_last_speech_clock_ms = row.reference_last_speech_ms === null ? null : at + row.reference_last_speech_ms;
            void (async () => {
              for (let offset = 0; offset < pcm.length && !done && !ending; offset += 6400) {
                const bytes = pcm.subarray(offset, offset + 6400);
                await delay(Math.max(0, at + (offset + bytes.length) / 32 - performance.now()));
                if (done || ending) break;
                const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(sequence++); bytes.copy(frame, 4); socket!.send(frame);
              }
            })().catch(settle);
          } else if (message.type === 'turn.end_candidate') {
            row.end_candidate_ms = at; ending = true;
            row.remaining_reference_speech = sequence * 200 < row.reference_last_speech_ms;
            row.audio_end_sent_ms = point(); socket!.send(JSON.stringify({ type: 'audio.end', last_seq: sequence - 1 }));
          } else if (message.type === 'transcript.final') { row.transcript_final_ms = at; row.transcript = message.text; }
          else if (message.type === 'stream.error') { row.error_code = message.code; row.error_at_ms = at; settle(); }
          else if (message.type === 'turn.result') {
            row.result_ms = at; row.api_timings_ms = message.response.timings_ms;
            row.reply_chars = message.response.reply.text.length; row.reply = message.response.reply.text;
            row.audio_bytes = Buffer.byteLength(message.response.audio.data_base64, 'base64');
            row.audio_duration_ms = message.response.audio.duration_ms; settle();
          }
        });
      });
      row.status = row.result_ms ? 'completed' : row.engine_dispatches > 0 ? 'failed' : 'rejected';
      if (row.status === 'failed') { row.failure_phase = 'engine'; process.exitCode = 1; }
      row.model_requests = provider.telemetry.slice(beforeTelemetry);
      row.metrics = {
        profile_setup_ms: ms(row.profile_ready_ms - row.case_start_ms),
        stream_connect_ms: ms(row.stream_ready_ms - row.ws_start_ms),
        endpoint_after_speech_ms: row.end_candidate_ms ? ms(row.end_candidate_ms - row.reference_last_speech_clock_ms) : null,
        finalize_drain_ms: row.transcript_final_ms ? ms(row.transcript_final_ms - row.audio_end_sent_ms) : null,
        engine_ms: row.engine_end_ms ? ms(row.engine_end_ms - row.engine_start_ms) : null,
        tts_adapter_ms: row.tts_end_ms ? ms(row.tts_end_ms - row.tts_start_ms) : null,
        after_final_other_ms: row.result_ms ? ms(row.result_ms - row.transcript_final_ms - (row.engine_end_ms - row.engine_start_ms) - (row.tts_end_ms - row.tts_start_ms)) : null,
        speech_end_to_mp3_received_ms: row.result_ms ? ms(row.result_ms - row.reference_last_speech_clock_ms) : null,
      };
      if (row.result_ms) {
        const a = row.engine_start_ms, b = row.engine_end_ms;
        const modelSpans = row.model_requests.map((r: any) => [Date.parse(r.startedAt) - performance.timeOrigin, Date.parse(r.startedAt) - performance.timeOrigin + r.elapsedMs]);
        const clip = (spans: number[][]) => spans.map(([x, y]) => [Math.max(a, x!), Math.min(b, y!)]).filter(([x, y]) => y! > x!);
        const dbSpans = row.database.map((q: any) => [q.start_ms, q.end_ms]);
        row.engine_detail = { model_union_ms: ms(union(clip(modelSpans))),
          database_union_ms: ms(union(clip(dbSpans))),
          model_and_database_union_ms: ms(union(clip([...modelSpans, ...dbSpans]))),
          database_queries: row.database.filter((q: any) => q.start_ms >= a && q.end_ms <= b).length,
          model_requests: row.model_requests.length };
        const beforeEngine = row.database.filter((q: any) => q.start_ms >= row.transcript_final_ms && q.end_ms <= a);
        const afterEngine = row.database.filter((q: any) => q.start_ms >= b && q.end_ms <= row.result_ms);
        row.pipeline_database_detail = {
          before_engine_queries: beforeEngine.length, after_engine_queries: afterEngine.length,
          before_engine_union_ms: ms(union(beforeEngine.map((q: any) => [q.start_ms, q.end_ms]))),
          after_engine_union_ms: ms(union(afterEngine.map((q: any) => [q.start_ms, q.end_ms]))),
        };
      }
    } catch (error) { row.status = 'failed'; row.error_code = safeCode(error); process.exitCode = 1; }
    finally {
      done = true; socket?.terminate();
      if (session) { await client.cancelTurn(session, requestId).catch(() => {}); await client.endSession(session).catch(() => {}); }
      await Promise.allSettled(row.observations); delete row.observations;
      current = undefined;
      console.log(JSON.stringify({ id: row.id, status: row.status, error: row.error_code, metrics: row.metrics,
        engine_models: row.model_requests?.map((r: any) => ({ stage: r.stage, ms: r.elapsedMs })) }));
      await save();
    }
  }
} catch (error) { console.log(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1; }
finally {
  current = undefined;
  await runtime?.close(); await bridge?.close();
  if (madeSchema) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); removedSchema = true; }
  await admin.end(); await save();
  console.log(JSON.stringify({ report: resolve(output, 'report.json'), schema_removed: removedSchema }));
}
