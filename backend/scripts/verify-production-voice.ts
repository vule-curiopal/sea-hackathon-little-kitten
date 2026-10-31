import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runRemoteCommand, type SshEnvironment } from '../integration/ssh.js';

const marker = 'MIU_PRODUCTION_VOICE_REPORT=';

/** Real loopback HTTP on the deployed host; audio/script travel only on SSH stdin. */
export async function verifyProductionVoice(environment: SshEnvironment, options: {
  audioPath?: string; remoteEnv?: string; remotePort?: number;
} = {}): Promise<Record<string, any>> {
  const audioPath = resolve(options.audioPath ?? 'test-assets/voice-pipeline/audio/11_en_clean.wav');
  const input = await readFile(audioPath);
  if (input.length < 44 || input.length > 5 * 1024 * 1024 || input.subarray(0, 4).toString() !== 'RIFF'
    || input.subarray(8, 12).toString() !== 'WAVE') throw new Error('invalid_probe_wav');
  const port = options.remotePort ?? 4611;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid_remote_port');
  const remoteEnv = options.remoteEnv ?? '/etc/miu/api.env';
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(remoteEnv) || remoteEnv.split('/').includes('..')) throw new Error('invalid_remote_env_path');
  const payload = { audio: input.toString('base64'), sha256: createHash('sha256').update(input).digest('hex'), port };
  const program = 'const payload = ' + JSON.stringify(payload) + ';\n' + String.raw`
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const base = 'http://127.0.0.1:' + payload.port;
const report = { run_kind: 'production_real_voice_probe', status: 'running', started_at: new Date().toISOString(),
  input: { source: 'local_recorded_test_wav_uploaded_over_ssh_stdin', sha256: payload.sha256, bytes: Buffer.from(payload.audio, 'base64').length },
  configuration: { provider_mode: process.env.MIU_PROVIDER === 'real' ? 'real' : 'other',
    elevenlabs_enable_logging: process.env.ELEVENLABS_ENABLE_LOGGING === 'true',
    model: /^[A-Za-z0-9_.-]{1,100}$/.test(process.env.OPENAI_MODEL || '') ? process.env.OPENAI_MODEL : null,
    dns_ipv4first_configured: /(?:^|\s)--dns-result-order=ipv4first(?:\s|$)/.test(process.env.NODE_OPTIONS || '') },
  stages: [], completed_receipt_sent: false, playback_receipts_sent: 0,
  limitations: ['Actual service audio upload and generated audio are tested; physical microphone, playback and listening are not tested.',
    'No playback receipt is sent. No memory learning or story-progress claim is made.',
    'Upstream model request IDs are not exposed by the deployed voice contract; provider mode and actual live HTTP results are recorded.'] };
let token; let sessionId; let turnId; let temporary;
const check = (value, code) => { if (!value) { const failure = new Error(code); failure.code = code; throw failure; } };
const safe = error => typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : 'production_voice_probe_failed';
async function request(stage, method, path, body, authorized = true) {
  const started = performance.now();
  const row = { stage, method, path, http_status: null, elapsed_ms: null, error_code: null };
  report.stages.push(row);
  try {
    const form = body instanceof FormData;
    const response = await fetch(base + path, { method,
      headers: { ...(authorized && token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(stage === 'audio_turn' ? 120000 : 15000) });
    row.http_status = response.status;
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 9 * 1024 * 1024) { await reader.cancel(); check(false, 'http_response_too_large'); }
      chunks.push(Buffer.from(value)); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { check(false, 'invalid_http_json'); }
    if (!response.ok) { const failure = new Error('http_failure'); failure.code = /^[a-z0-9_]{1,80}$/.test(data?.error?.code || '') ? data.error.code : 'http_request_failed'; throw failure; }
    return data;
  } catch (error) { row.error_code = safe(error); throw error; }
  finally { row.elapsed_ms = Math.round(performance.now() - started); }
}
try {
  check(process.env.MIU_PROVIDER === 'real', 'real_provider_required');
  check(['true', 'false'].includes(process.env.ELEVENLABS_ENABLE_LOGGING), 'invalid_logging_configuration');
  const health = await request('health', 'GET', '/api/health', undefined, false);
  check(health.provider_mode === 'real', 'live_service_is_not_real');
  report.health = { status: health.status, provider_mode: health.provider_mode, engine_mode: health.engine_mode };
  const opened = await request('create_own_binh_session', 'POST', '/api/sessions', { demo_profile_key: 'binh', request_id: randomUUID() }, false);
  check(typeof opened.session_id === 'string' && typeof opened.demo_token === 'string', 'invalid_session_response');
  sessionId = opened.session_id; token = opened.demo_token;
  check(opened.provider_mode === 'real', 'session_is_not_real');
  const configured = await request('configure_english', 'PATCH', '/api/profiles/current/config', { request_id: randomUUID(), language_mode: 'en' });
  check(configured.configuration?.language_mode === 'en', 'english_configuration_not_applied');
  turnId = randomUUID();
  const form = new FormData(); form.set('request_id', turnId); form.set('kind', 'utterance'); form.set('language_hint', 'en');
  form.set('audio', new Blob([Buffer.from(payload.audio, 'base64')], { type: 'audio/wav' }), '11_en_clean.wav');
  const result = await request('audio_turn', 'POST', '/api/sessions/' + sessionId + '/turns', form);
  check(result.provider_mode === 'real' && result.turn_id === turnId, 'turn_is_not_real');
  check(typeof result.transcript?.text === 'string' && result.transcript.text.trim(), 'missing_actual_stt_transcript');
  check(result.transcript.language === 'en' && result.reply?.language === 'en', 'wrong_language');
  check(/tell[\s\S]*story[\s\S]*kitten/i.test(result.transcript.text), 'stt_did_not_recognize_expected_content');
  check(typeof result.reply.text === 'string' && result.reply.text.trim() && result.reply.text.length <= 1000, 'invalid_actual_reply');
  check(result.audio?.mime_type === 'audio/mpeg' && typeof result.audio.data_base64 === 'string'
    && result.audio.data_base64.length <= Math.ceil(5 * 1024 * 1024 / 3) * 4, 'missing_actual_tts_audio');
  const audio = Buffer.from(result.audio.data_base64, 'base64'); check(audio.length > 0, 'empty_tts_audio');
  temporary = await mkdtemp(join(tmpdir(), 'miu-production-voice-'));
  const file = join(temporary, 'actual-output.mp3'); await writeFile(file, audio, { mode: 0o600 });
  const probe = await promisify(execFile)(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 15000, maxBuffer: 65536 });
  const metadata = JSON.parse(probe.stdout);
  const stream = metadata.streams?.find(value => value.codec_type === 'audio');
  const duration = Number(metadata.format?.duration);
  check(stream && Number.isFinite(duration) && duration > 0, 'invalid_tts_ffprobe_result');
  report.transcript = { text: result.transcript.text.slice(0, 2000), language: result.transcript.language, expected_content_recognized: true };
  report.reply = { text: result.reply.text, language: result.reply.language };
  report.result = { provider_mode: result.provider_mode, engine_mode: result.engine_mode,
    audio: { mime_type: result.audio.mime_type, bytes: audio.length, duration_ms: Math.round(duration * 1000),
      codec: stream.codec_name, sample_rate: Number(stream.sample_rate), channels: Number(stream.channels), sha256: createHash('sha256').update(audio).digest('hex') },
    timings_ms: result.timings_ms };
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error_code = safe(error); }
finally {
  report.cleanup = { own_turn_canceled: false, own_session_closed: false, temporary_audio_removed: false };
  if (sessionId && turnId) {
    try { await request('cancel_own_unheard_turn', 'DELETE', '/api/sessions/' + sessionId + '/turns/' + turnId); report.cleanup.own_turn_canceled = true; }
    catch (error) { report.cleanup.cancel_error = safe(error); report.status = 'failed'; }
  }
  if (sessionId) {
    try { await request('close_own_session', 'DELETE', '/api/sessions/' + sessionId); report.cleanup.own_session_closed = true; }
    catch (error) { report.cleanup.close_error = safe(error); report.status = 'failed'; }
  }
  if (temporary) {
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporary_audio_removed = true; }
    catch { report.cleanup.temporary_cleanup_error = 'temporary_audio_cleanup_failed'; report.status = 'failed'; }
  }
  process.stdout.write('MIU_PRODUCTION_VOICE_REPORT=' + JSON.stringify(report) + '\n');
}
`;
  const encoded = Buffer.from(program).toString('base64');
  const script = 'set -eu\ncd /tmp\npython3 <<\'MIU_VOICE_PROBE_PY\'\n'
    + 'remote_env_path = ' + JSON.stringify(remoteEnv) + '\nprogram_base64 = ' + JSON.stringify(encoded) + '\n'
    + String.raw`
import os, re, shlex, base64, subprocess, json
prefix = 'MIU_PRODUCTION_VOICE_REPORT='
def fail(code, **details):
    print(prefix + json.dumps(dict(status='failed', error_code=code, **details)))
try:
    environment = os.environ.copy()
    with open(remote_env_path, encoding='utf-8') as source:
        for line in source:
            line = line.strip()
            if not line or line.startswith('#'): continue
            if line.startswith('export '): line = line[7:].lstrip()
            key, separator, raw = line.partition('=')
            if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key.strip()): continue
            values = shlex.split(raw, comments=True, posix=True)
            environment[key.strip()] = ' '.join(values)
except Exception:
    fail('remote_env_read_failed')
else:
    try:
        result = subprocess.run(['node', '--input-type=module'],
            input=base64.b64decode(program_base64).decode('utf-8'), env=environment,
            capture_output=True, text=True, timeout=210)
        report = next((line for line in result.stdout.splitlines() if line.startswith(prefix)), None)
        if report: print(report)
        else:
            category = 'remote_node_launch_failed'
            if 'SyntaxError' in result.stderr: category = 'remote_node_syntax_error'
            elif 'bad option' in result.stderr or 'NODE_OPTIONS' in result.stderr: category = 'remote_node_option_error'
            fail(category, remote_exit_code=result.returncode)
    except subprocess.TimeoutExpired: fail('remote_probe_timeout')
    except Exception: fail('remote_probe_launch_failed')
` + '\nMIU_VOICE_PROBE_PY\n';
  const result = await runRemoteCommand(environment, script, 240_000);
  const line = result.stdout.split('\n').find(value => value.startsWith(marker));
  if (!line) throw new Error('missing_safe_remote_probe_report');
  return JSON.parse(line.slice(marker.length));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string', default: '.env' },
    output: { type: 'string' }, 'remote-env': { type: 'string', default: '/etc/miu/api.env' },
    port: { type: 'string', default: '4611' }, audio: { type: 'string' }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log('Usage: tsx backend/scripts/verify-production-voice.ts [--env-file .env] [--output NEW_DIRECTORY] [--remote-env /etc/miu/api.env] [--port 4611] [--audio WAV]');
  } else {
    const output = resolve(values.output ?? 'reports/production-real-voice-' + new Date().toISOString().replace(/[:.]/gu, '-'));
    await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
    try {
      if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
      const report = await verifyProductionVoice({ ...process.env, MIU_ENV_FILE: resolve(values['env-file']) },
        { audioPath: values.audio, remoteEnv: values['remote-env'], remotePort: Number(values.port) });
      await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('Production voice probe ' + report.status + '; safe report: ' + output);
      if (report.status !== 'passed') process.exitCode = 1;
    } catch (error) {
      const candidate = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }).code ?? (error as Error).message : undefined;
      const failureCode = typeof candidate === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(candidate) ? candidate : 'production_voice_probe_failed';
      await writeFile(resolve(output, 'report.json'), JSON.stringify({ status: 'failed', error_code: failureCode }, null, 2) + '\n');
      console.log('Production voice probe failed (' + failureCode + '); safe report: ' + output); process.exitCode = 1;
    }
  }
}
