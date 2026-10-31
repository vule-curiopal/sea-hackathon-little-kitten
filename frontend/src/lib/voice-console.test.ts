import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionResponse, TurnResponse, VoiceControllerEvent } from '@miu/voice-client';
import { createVoiceConsole, VOICE_CONSOLE_PREFIX } from './voice-console.ts';

function setup() {
  let time = 0;
  const rows: { level: string; prefix: unknown; name: unknown; data: unknown }[] = [];
  const write = (level: string) => (...[prefix, name, data]: unknown[]) => { rows.push({ level, prefix, name, data }); };
  const logger = createVoiceConsole({ log: write('log'), warn: write('warn'), error: write('error') }, () => time);
  return { logger, rows, advance: (ms: number) => { time += ms; } };
}
function turn(): TurnResponse {
  return {
    session_id: 'test-session', turn_id: 'test-turn', sequence: 1, clock_version: 1, state_version: 2, provider_mode: 'real', engine_mode: 'character_memory', input_mode: 'audio',
    transcript: { text: 'Private spoken words', language: 'en', uncertain_spans: [] },
    reply: { text: 'Private reply words', sentences: [], language: 'en' },
    audio: { mime_type: 'audio/mpeg', duration_ms: 1500, data_base64: 'SECRET_AUDIO_PAYLOAD' },
    presentation: null, face: null, memory: { privateValue: 'Private memory words' },
    timings_ms: { stt: 80, reply: 400, validation: 5, tts: 120, server_total: 605 },
  };
}

test('voice logs record lifecycle order and elapsed time with a searchable prefix', () => {
  const { logger, rows, advance } = setup();
  logger.action('hold.start', { state: 'idle' });
  logger.event({ type: 'capture', event: { type: 'state', state: 'recording' } });
  advance(300);
  logger.action('hold.release');
  logger.event({ type: 'state', state: 'processing' });
  logger.request('POST', '/api/sessions/test/turns?token=SECRET_QUERY', 200, 604.8);
  logger.event({ type: 'turn', response: turn() });
  logger.event({ type: 'playback', event: { type: 'state', state: 'speaking' } });
  logger.event({ type: 'playback', event: { type: 'state', state: 'idle' } });
  assert.deepEqual(rows.map(row => row.name), ['hold.start', 'capture.state', 'hold.release', 'state', 'request', 'turn.received', 'playback.state', 'playback.state']);
  assert.ok(rows.every(row => row.prefix === VOICE_CONSOLE_PREFIX));
  assert.deepEqual(rows[4].data, { elapsedMs: 300, method: 'POST', path: '/api/sessions/test/turns', status: 200, durationMs: 605 });
});

test('console data includes technical summaries without audio, tokens, user words, memory, or error bodies', () => {
  const { logger, rows } = setup();
  logger.session({ provider_mode: 'real', engine_mode: 'character_memory', demo_token: 'SECRET_TOKEN', configuration: { language_mode: 'en' } } as SessionResponse);
  logger.event({ type: 'turn', response: turn() });
  logger.error({ code: 'NETWORK_ERROR', status: 503, retryable: true, message: 'SECRET_ERROR_BODY', secret: 'SECRET_KEY' });
  const text = JSON.stringify(rows);
  for (const forbidden of ['SECRET_AUDIO_PAYLOAD', 'SECRET_TOKEN', 'Private spoken words', 'Private reply words', 'Private memory words', 'SECRET_ERROR_BODY', 'SECRET_KEY']) assert.ok(!text.includes(forbidden), forbidden);
  assert.ok(text.includes('transcriptAvailable'));
  assert.ok(text.includes('audio/mpeg'));
  assert.ok(text.includes('serverTotal'));
  assert.ok(text.includes('NETWORK_ERROR'));
});

test('meter messages are limited to once per second and reset on a new recording', () => {
  const { logger, rows, advance } = setup();
  const meter = { type: 'capture', event: { type: 'meter', snapshot: { elapsedMs: 50, levelDbfs: -31.7, hasSignal: true } } } as VoiceControllerEvent;
  logger.event(meter);
  advance(20); logger.event(meter);
  advance(979); logger.event(meter);
  assert.equal(rows.length, 1);
  advance(1); logger.event(meter);
  assert.equal(rows.length, 2);
  logger.event({ type: 'capture', event: { type: 'state', state: 'requesting_permission' } });
  logger.event(meter);
  assert.equal(rows.filter(row => row.name === 'capture.level').length, 3);
});

test('final recording diagnostics distinguish quiet input from container and duration issues', () => {
  const { logger, rows } = setup();
  logger.event({ type: 'capture', event: { type: 'complete', mimeType: 'audio/mp4', bytes: 79818, durationMs: 6182.9,
    reason: 'manual', peakLevelDbfs: -29.6, sampleRate: 48000, channelCount: 1 } });
  logger.event({ type: 'capture', event: { type: 'complete', mimeType: 'audio/webm', bytes: 1000, durationMs: 200,
    reason: 'manual', peakLevelDbfs: null, sampleRate: null, channelCount: null } });
  assert.equal(rows[0].name, 'capture.complete');
  assert.deepEqual(rows[0].data, { elapsedMs: 0, mimeType: 'audio/mp4', bytes: 79818, recordingMs: 6183,
    reason: 'manual', peakLevelDbfs: -30, sampleRate: 48000, channelCount: 1 });
  assert.equal((rows[1].data as Record<string, unknown>).peakLevelDbfs, null);
});

test('errors are deduplicated and normal cancellation is informational', () => {
  const { logger, rows } = setup();
  const failure = { code: 'MIC_PERMISSION_DENIED', retryable: true };
  logger.error(failure, 'capture.error'); logger.error(failure);
  logger.error({ code: 'CANCELED' });
  logger.event({ type: 'turn', response: { ...turn(), transcript: null, audio: null } });
  assert.deepEqual(rows.map(row => row.level), ['error', 'log', 'log']);
  assert.ok(JSON.stringify(rows.at(-1)).includes('"audioAvailable":false'));
});

test('unavailable console tooling cannot break a voice turn', () => {
  const fail = () => { throw new Error('Console unavailable'); };
  const logger = createVoiceConsole({ log: fail, warn: fail, error: fail });
  assert.doesNotThrow(() => {
    logger.action('hold.start');
    logger.event({ type: 'turn', response: turn() });
    logger.error({ code: 'PLAYBACK_FAILED' });
  });
});
