import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../backend/pipeline/src/app.js';
import { inspectSynthesizedAudio } from '../backend/pipeline/src/audio.js';
import { loadConfig } from '../backend/pipeline/src/config.js';
import { createServer } from '../backend/pipeline/src/server-runtime.js';
import { createRealProviders } from '../backend/pipeline/src/providers/real.js';
import { VoiceApiClient } from '../packages/voice-client/src/api.js';

// Real speech providers and stateless GPT, isolated from production sessions and character memory.
// Run check-voice-test-audio.ts first. --real explicitly allows billable API calls.
if (!process.argv.includes('--real')) throw new Error('Pass --real to run billable provider requests.');
const root = new URL('../test-assets/voice-pipeline/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const offline = JSON.parse(await readFile(new URL('validation.json', root), 'utf8'));
const normalLoggingOverride = process.argv.includes('--normal-logging');
const config = loadConfig({ ...process.env, MIU_PROVIDER: 'real',
  ...(normalLoggingOverride ? { STT_LOGGING: '1', ELEVENLABS_ENABLE_LOGGING: 'true' } : {}),
});
let providerRequests: Record<string, unknown>[] = [];
const tracedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const entry: Record<string, unknown> = { host: url.host, path: url.pathname, enable_logging: url.searchParams.get('enable_logging') };
  providerRequests.push(entry);
  try {
    const response = await fetch(input, init);
    entry.status = response.status;
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({})) as any;
      const code = body.detail?.status ?? body.error?.code ?? body.error?.type;
      if (typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(code)) entry.error_code = code;
    }
    return response;
  } catch (error) {
    entry.transport_error = error instanceof Error ? error.name : 'unknown';
    throw error;
  }
};
const server = createServer(await buildApp({ config, providers: createRealProviders(config, tracedFetch) }));
const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
const client = new VoiceApiClient({ baseUrl, requestTimeoutMs: 125_000 });
const results: Record<string, any>[] = [];

function prefixWav(source: Buffer, endMs: number): Buffer {
  let offset = 12;
  while (offset + 8 <= source.length) {
    const size = source.readUInt32LE(offset + 4);
    if (source.toString('ascii', offset, offset + 4) === 'data') {
      const length = Math.min(size, Math.floor(endMs * 24) * 2);
      const output = Buffer.from(source.subarray(0, offset + 8 + length));
      output.writeUInt32LE(output.length - 8, 4);
      output.writeUInt32LE(length, offset + 4);
      return output;
    }
    offset += 8 + size + size % 2;
  }
  throw new Error('WAV data chunk missing.');
}

function tokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
}
function tokenErrorRate(reference: string, actual: string): number | null {
  const expected = tokens(reference), found = tokens(actual);
  if (!expected.length) return null;
  let row = Array.from({ length: found.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    const next = [i];
    for (let j = 1; j <= found.length; j++) {
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (expected[i - 1] === found[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return Math.round(row[found.length]! / expected.length * 1000) / 1000;
}

try {
  for (const language of ['vi', 'en'] as const) {
    let session = await client.createSession(language === 'vi' ? 'an' : 'binh');
    session = { ...session, ...await client.configure(session, language) };
    try {
      const assets = manifest.assets.filter((a: any) => a.language === language || a.id.startsWith(language === 'vi' ? '10_' : '20_'));
      for (const asset of assets) {
        const selected = process.argv.find(arg => arg.startsWith('--ids='))?.slice(6).split(',');
        if (selected && !selected.includes(asset.id)) continue;
        const checked = offline.assets.find((a: any) => a.id === asset.id);
        if (!checked) throw new Error(`Offline result missing for ${asset.id}`);
        const result: Record<string, any> = {
          id: asset.id, language, condition: asset.condition, speech_present: asset.speech_present,
          detector: checked.detector, full_reference: asset.reference_text,
        };
        results.push(result);
        providerRequests = [];
        result.provider_requests = providerRequests;
        if (checked.detector.first_decision?.action !== 'submit') {
          result.status = 'not_uploaded_detector_cancel';
          console.log(JSON.stringify({ id: asset.id, status: result.status }));
          continue;
        }
        const endMs = checked.detector.decision_at_ms;
        const reference = asset.segments.filter((s: any) => s.start_ms < endMs).map((s: any) => s.text).join(' ');
        result.submitted_reference = reference;
        result.submitted_duration_ms = endMs;
        const source = await readFile(new URL(asset.file, root));
        const bytes = prefixWav(source, endMs);
        const requestId = randomUUID();
        const start = performance.now();
        try {
          const turn = await client.submitTurn(session, {
            requestId, audio: new Blob([Uint8Array.from(bytes)], { type: 'audio/wav' }),
          });
          if (turn.provider_mode !== 'real' || turn.engine_mode !== 'voice_stub' || turn.memory !== null || !turn.audio) {
            throw new Error('Expected isolated real speech providers with stateless GPT.');
          }
          const audio = Buffer.from(turn.audio.data_base64, 'base64');
          const inspected = await inspectSynthesizedAudio(audio, turn.audio.mime_type, new AbortController().signal);
          Object.assign(result, {
            status: 'real_pipeline_completed', transcript: turn.transcript?.text ?? '', reply: turn.reply.text,
            normalized_token_error_rate: tokenErrorRate(reference, turn.transcript?.text ?? ''),
            transcript_on_noise_only: !asset.speech_present && Boolean(turn.transcript?.text?.trim()),
            returned_audio: { mime_type: turn.audio.mime_type, bytes: audio.length, duration_ms: inspected.durationMs },
            timings_ms: turn.timings_ms, http_total_ms: Math.round(performance.now() - start),
          });
          session = { ...session, state_version: turn.state_version, clock_version: turn.clock_version };
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
          Object.assign(result, {
            status: !asset.speech_present && code === 'unclear_audio' ? 'noise_rejected_as_unclear' : 'real_request_failed',
            error_code: code, http_total_ms: Math.round(performance.now() - start),
          });
        } finally {
          // No playback is claimed: discard the prepared reply and free the turn.
          await client.cancelTurn(session, requestId);
        }
        console.log(JSON.stringify({ id: asset.id, status: result.status, error_code: result.error_code,
          token_error_rate: result.normalized_token_error_rate, http_total_ms: result.http_total_ms, provider_requests: providerRequests }));
        await writeReport();
      }
    } finally { await client.endSession(session); }
  }
} finally {
  await server.close();
  await writeReport();
}
if (results.some(result => result.status === 'real_request_failed')) process.exitCode = 1;

async function writeReport() {
  const report = {
    tested_at: new Date().toISOString(),
    scope: 'Offline RMS endpoint decisions followed by real local Express HTTP STT -> stateless GPT -> TTS on submitted WAV prefixes. No browser capture, physical microphone, playback, production session or character/memory evaluation.',
    reference_scope: 'Fictional TTS input annotations; whitespace token edit distance after punctuation/case normalization, not human-verified alignment.',
    providers: { mode: 'real', stt: config.sttModel, reply: config.replyModel, tts: config.ttsModel, stt_logging: config.enableLogging },
    normal_logging_explicit_override: normalLoggingOverride,
    detector_config: offline.detector_config,
    summary: {
      tested_files: results.length,
      detector_cancel: results.filter(r => r.status === 'not_uploaded_detector_cancel').length,
      pipeline_completed: results.filter(r => r.status === 'real_pipeline_completed').length,
      request_failed: results.filter(r => r.status === 'real_request_failed').length,
      noise_rejected_as_unclear: results.filter(r => r.status === 'noise_rejected_as_unclear').length,
      premature_endpoints: results.filter(r => r.detector.premature_endpoint).length,
      transcript_on_noise_only: results.filter(r => r.transcript_on_noise_only).length,
    },
    assets: results,
  };
  await writeFile(new URL('real-validation.json', root), JSON.stringify(report, null, 2) + '\n');
}
