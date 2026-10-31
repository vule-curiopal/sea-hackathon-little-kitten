import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { buildApp } from '../backend/pipeline/src/app.js';
import { loadConfig } from '../backend/pipeline/src/config.js';
import { createServer } from '../backend/pipeline/src/server-runtime.js';
import { createRealProviders } from '../backend/pipeline/src/providers/real.js';
import { inspectSynthesizedAudio } from '../backend/pipeline/src/audio.js';
import { VoiceApiClient } from '../packages/voice-client/src/api.js';
import { Pcm16Encoder } from '../packages/voice-client/src/realtime/pcm.js';

if (!process.argv.includes('--real')) throw new Error('Pass --real to allow billable realtime STT/GPT/TTS requests.');
const config = loadConfig({ ...process.env, MIU_PROVIDER: 'real', VOICE_INPUT_MODE: 'elevenlabs_realtime' });
const root = new URL('../test-assets/voice-pipeline/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const selected = process.argv.find(a => a.startsWith('--ids='))?.slice(6).split(',');
if (selected?.some(id => !manifest.assets.some((a: any) => a.id === id))) throw new Error('Unknown audio case');
const calls = new Map<string, string[]>();
const providers = createRealProviders(config, fetch);
const generate = providers.response.generate;
providers.response.generate = async (input, signal) => {
  const seen = calls.get(input.turnId) ?? []; seen.push(input.text); calls.set(input.turnId, seen);
  return generate(input, signal);
};
let batchCalls = 0;
const transcribe = providers.transcribe;
providers.transcribe = (...args) => { batchCalls++; return transcribe(...args); };
const runtime = createServer(await buildApp({ config, providers }));
const baseUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
const client = new VoiceApiClient({ baseUrl });
const results: Record<string, any>[] = [];

function pcmWave(bytes: Buffer): Buffer {
  const encoder = new Pcm16Encoder(bytes.readUInt32LE(24));
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(offset + 8 + i * 2) / 32768;
      const chunks = encoder.push(samples); const last = encoder.flush(); if (last) chunks.push(last);
      return Buffer.concat(chunks);
    }
    offset += 8 + size + size % 2;
  }
  throw new Error('Invalid corpus WAV');
}

async function run(asset: any): Promise<void> {
  const language = asset.language ?? (asset.id.startsWith('10_') ? 'vi' : 'en');
  let session = await client.createSession(language === 'vi' ? 'an' : 'binh');
  session = { ...session, ...await client.configure(session, language) };
  const requestId = randomUUID();
  const original = pcmWave(await readFile(new URL(asset.file, root)));
  // Extend only existing speech-free tail, with the same noise, to allow a 3s endpoint.
  const room = Math.min(64_000, Math.max(0, 960_000 - original.length));
  const tail = original.subarray(Math.max(0, original.length - 32_000));
  const padded = Buffer.concat([original, Buffer.from(Array.from({ length: room }, (_, i) => tail[i % tail.length]!))]);
  const record: Record<string, any> = { id: asset.id, speech_present: asset.speech_present, language,
    original_duration_ms: asset.duration_ms, added_background_tail_ms: room / 32, events: [] };
  results.push(record);
  let socket: WebSocket | undefined;
  let done = false, ending = false, sequence = 0;
  const start = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/sessions/${session.session_id}/speech-stream`, { origin: baseUrl });
      const timeout = setTimeout(() => reject(new Error('verification_timeout')), 150_000);
      const settle = (error?: Error) => { done = true; clearTimeout(timeout); error ? reject(error) : resolve(); };
      socket.on('error', () => settle(new Error('transport_error')));
      socket.on('close', () => { if (!done) settle(new Error('premature_socket_close')); });
      socket.on('open', () => socket!.send(JSON.stringify({ type: 'stream.start', token: session.demo_token, request_id: requestId, language })));
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        record.events.push({ type: message.type, at_ms: Math.round(performance.now() - start), ...(message.text !== undefined ? { text: message.text } : {}) });
        if (message.type === 'stream.ready') {
          const tick = performance.now();
          void (async () => {
            for (let i = 0; i < padded.length && !ending && !done; i += 6400) {
              const data = padded.subarray(i, i + 6400), packet = Buffer.alloc(data.length + 4);
              packet.writeUInt32LE(sequence++); data.copy(packet, 4); socket!.send(packet);
              await delay(Math.max(0, tick + sequence * 200 - performance.now()));
            }
          })().catch(error => settle(error));
        } else if (message.type === 'turn.end_candidate') {
          ending = true; record.endpoint_media_ms = Math.min(sequence * 200, padded.length / 32);
          record.remaining_reference_speech = asset.segments.some((s: any) => s.end_ms > record.endpoint_media_ms);
          socket!.send(JSON.stringify({ type: 'audio.end', last_seq: sequence - 1 }));
        } else if (message.type === 'transcript.final') record.transcript = message.text;
        else if (message.type === 'stream.error') { record.error_code = message.code; settle(); }
        else if (message.type === 'turn.result') {
          record.response = message.response; settle();
        }
      });
    });
    record.engine_dispatches = calls.get(requestId)?.length ?? 0;
    record.engine_received_full_transcript = record.engine_dispatches ? calls.get(requestId)?.[0] === record.transcript : null;
    if (record.response) {
      const response = record.response;
      const audio = Buffer.from(response.audio.data_base64, 'base64');
      const checked = await inspectSynthesizedAudio(audio, response.audio.mime_type, new AbortController().signal);
      record.reply = response.reply.text;
      record.returned_audio = { mime_type: response.audio.mime_type, bytes: audio.length, duration_ms: checked.durationMs };
      record.status = 'real_pipeline_completed';
      delete record.response;
    } else record.status = 'rejected_before_engine';
    record.total_ms = Math.round(performance.now() - start);
    if (record.engine_dispatches > 1 || (record.engine_dispatches > 0 && !record.engine_received_full_transcript)) throw new Error('Invalid engine dispatch');
  } catch (error) {
    record.status = 'verification_failed'; record.error_code = error instanceof Error ? error.message : 'unknown';
    process.exitCode = 1;
  } finally {
    done = true; socket?.terminate();
    await client.cancelTurn(session, requestId); await client.endSession(session);
    console.log(JSON.stringify({ id: asset.id, status: record.status, error_code: record.error_code,
      engine_dispatches: record.engine_dispatches, full_transcript: record.engine_received_full_transcript,
      endpoint_media_ms: record.endpoint_media_ms, remaining_speech: record.remaining_reference_speech }));
    await writeReport();
  }
}
async function writeReport() {
  await writeFile(new URL('realtime-validation.json', root), JSON.stringify({ tested_at: new Date().toISOString(),
    scope: 'Paced PCM over real localhost WebSocket -> ElevenLabs realtime VAD/filtering -> one stateless real GPT dispatch -> real TTS. No character/memory evaluation, production session or physical microphone test.',
    config: { model: 'scribe_v2_realtime', filter_background_audio: true, vad_silence_threshold_secs: config.realtimeSilenceMs / 1000,
      sensitivity: 'provider default', logging: config.enableLogging },
    batch_stt_calls: batchCalls, summary: { total: results.length,
      completed: results.filter(r => r.status === 'real_pipeline_completed').length,
      rejected: results.filter(r => r.status === 'rejected_before_engine').length,
      failed: results.filter(r => r.status === 'verification_failed').length,
      early_endpoints: results.filter(r => r.remaining_reference_speech).length,
      noise_dispatched_to_engine: results.filter(r => !r.speech_present && r.engine_dispatches > 0).length }, assets: results,
  }, null, 2) + '\n');
}
try { for (const asset of manifest.assets) if (!selected || selected.includes(asset.id)) await run(asset); }
finally { await runtime.close(); await writeReport(); }
