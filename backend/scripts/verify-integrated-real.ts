import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import pg from 'pg';
import { createIntegratedApp } from '../integration/server.js';
import { inspectSynthesizedAudio } from '../pipeline/src/audio.js';
import { loadConfig } from '../pipeline/src/config.js';
import { createElevenLabsTts } from '../pipeline/src/providers/elevenlabs/tts.provider.js';
import { createServer } from '../pipeline/src/server-runtime.js';
import { FATAL_OPENAI_ERROR_CODES, OpenAIProvider, type OpenAIRequestTelemetry } from '../pipeline/providers.js';
import { ensureDatabaseTunnel } from './database-tunnel.js';
import { verifyIntegratedBrowser } from './verify-integrated-browser.js';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'env-file': { type: 'string', default: '.env' },
  'preserve-schema': { type: 'boolean', default: false }, 'skip-voice': { type: 'boolean', default: false },
  'voice-followup': { type: 'boolean', default: false }, 'prior-report': { type: 'string' },
  'browser-only': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: tsx backend/scripts/verify-integrated-real.ts [--output NEW_DIRECTORY] [--env-file .env] [--preserve-schema] [--skip-voice] [--voice-followup|--browser-only] [--prior-report DIRECTORY]');
  process.exit(0);
}
if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY || !process.env.ELEVENLABS_API_KEY) {
  throw new Error('Real HTTP verification requires DATABASE_URL and server-side OpenAI/ElevenLabs credentials.');
}
if (process.env.MIU_PROVIDER && process.env.MIU_PROVIDER !== 'real') throw new Error('Real HTTP verification rejects a fake provider.');
const canonicalLogging = process.env.STT_LOGGING?.trim() || undefined;
const legacyLogging = process.env.ELEVENLABS_ENABLE_LOGGING?.trim() || undefined;
const elevenlabsLogging = loadConfig({ ...process.env, MIU_PROVIDER: 'real',
  ...(!canonicalLogging && !legacyLogging ? { STT_LOGGING: '0' } : {}),
}).enableLogging;
const elevenlabsLoggingSource = canonicalLogging && legacyLogging ? 'explicit_STT_LOGGING_and_ELEVENLABS_ENABLE_LOGGING'
  : canonicalLogging ? 'explicit_STT_LOGGING' : legacyLogging ? 'explicit_ELEVENLABS_ENABLE_LOGGING' : 'default_false';

type Json = Record<string, any>;
type Session = { id: string; token: string };
type Step = { name: string; status: 'passed' | 'failed' | 'blocked' | 'not_attempted'; elapsed_ms: number; evidence?: unknown; error_code?: string; error_location?: unknown };
type HttpRecord = { method: string; path: string; status: number; request_id?: string; input?: unknown; response: unknown; api_calls: readonly OpenAIRequestTelemetry[]; model_reply: unknown };
class CheckFailure extends Error { constructor(readonly code: string) { super(code); } }
class HttpFailure extends CheckFailure { constructor(code: string, readonly status: number) { super(code); } }
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new CheckFailure(code); }
function safeCode(error: unknown): string {
  if (error instanceof CheckFailure) return error.code;
  if (error instanceof Error && /^browser_[a-z0-9_]{1,72}$/u.test(error.message)) return error.message;
  if (error instanceof Error && error.name === 'TimeoutError') return 'browser_ui_timeout';
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-zA-Z0-9_]{1,80}$/u.test(code)) return code;
  }
  return 'verification_execution_failed';
}
function safeLocation(error: unknown): unknown {
  if (!(error instanceof Error)) return null;
  const operation = error.message.split(':', 1)[0] ?? '';
  const frames = [...(error.stack ?? '').matchAll(/(?:file:\/\/)?(\/[^()\n]*\/backend\/scripts\/[\w.-]+\.[cm]?tsx?):(\d+):(\d+)/gu)]
    .map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]) }));
  return { name: error.name, operation: /^[a-zA-Z][a-zA-Z.]{1,60}$/u.test(operation) ? operation : null, locations: frames };
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  const result: Json = {};
  for (const [key, child] of Object.entries(value)) {
    if (['demo_token', 'token', 'apiKey', 'api_key', 'authorization', 'data_base64'].includes(key)) continue;
    result[key] = clean(child);
  }
  return result;
}
const schema = `miu_integration_eval_${randomUUID().replaceAll('-', '')}`;
assert(/^miu_integration_eval_[a-f0-9]{32}$/u.test(schema), 'invalid_isolated_schema');
let sourceUrl: URL;
try { sourceUrl = new URL(process.env.DATABASE_URL); }
catch { throw new CheckFailure('invalid_database_url'); }
assert(['postgres:', 'postgresql:'].includes(sourceUrl.protocol), 'postgres_required');
const isolatedUrl = new URL(sourceUrl);
// No public fallback: an omitted evaluation table cannot resolve to public data.
isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
const output = resolve(values.output ?? `reports/integrated-real-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output, { recursive: false });
const startedAt = new Date().toISOString();
const started = performance.now();
const steps: Step[] = [];
const httpRecords: HttpRecord[] = [];
const pending = new Map<string, { session: Session; turnId: string }>();
let fatal: string | null = null;
let provider: OpenAIProvider | undefined;
let integrated: Awaited<ReturnType<typeof createIntegratedApp>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let base = '';
let schemaCreated = false;
let schemaRemoved = false;
let publicBefore: unknown = null;
let publicAfter: unknown = null;
let cleanupError: string | null = null;
const admin = new pg.Pool({ connectionString: sourceUrl.toString(), max: 1 });
const snapshots: Record<string, unknown> = {};

async function publicCounts() {
  const tables = (await admin.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
  )).rows;
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    // Quote identifiers rather than allowing database metadata to become SQL.
    const identifier = table.replaceAll('"', '""');
    counts[table] = Number((await admin.query(`SELECT count(*)::text AS count FROM public."${identifier}"`)).rows[0].count);
  }
  return counts;
}

async function save(status: string) {
  const telemetry = provider?.telemetry ?? [];
  const completed = telemetry.filter(event => event.outcome === 'completed');
  const report = {
    run_kind: 'integrated_real_http_verification', provider: 'real', status,
    scope: values['browser-only'] ? 'browser_only' : values['voice-followup'] ? 'voice_isolation_browser_followup' : 'full_focused_http_and_browser',
    prior_report: values['prior-report'] ? resolve(values['prior-report']) : null,
    provider_configuration: {
      elevenlabs_enable_logging: integrated?.config.enableLogging ?? elevenlabsLogging,
      elevenlabs_logging_source: elevenlabsLoggingSource,
    },
    started_at: startedAt, elapsed_ms: Math.round(performance.now() - started),
    database: { engine: 'postgresql', isolated_schema: schema, schema_removed: schemaRemoved,
      preserved_by_request: values['preserve-schema'], public_counts_before: publicBefore, public_counts_after: publicAfter },
    coverage: { attempted: steps.filter(item => ['passed', 'failed'].includes(item.status)).length,
      passed: steps.filter(item => item.status === 'passed').length,
      failed: steps.filter(item => item.status === 'failed').length,
      blocked: steps.filter(item => item.status === 'blocked').length,
      not_attempted: steps.filter(item => item.status === 'not_attempted').length },
    actual_api_requests: { total: telemetry.length, completed: completed.length,
      telemetry_scope: 'this_run_only', prior_report_counts_included: false,
      responses_with_ids: completed.filter(event => event.api === 'responses' && event.responseId).length,
      replies_with_ids: completed.filter(event => event.stage === 'reply' && event.responseId).length,
      models: provider?.modelIds ?? null },
    delivery_evidence: values['browser-only']
      ? 'Chrome exercised the actual Done reading control and HTML audio playback; resulting delivery receipts came from the real browser client. No physical iPad, microphone, speaker output, or child listening was verified.'
      : 'Direct HTTP scenarios use simulated delivery receipts. The browser section exercises the actual Done reading control and HTML audio playback with receipts from the real client. No physical iPad, microphone, speaker output, or child listening was verified.',
    voice_input: 'When attempted, a fictional utterance is synthesized through real ElevenLabs TTS, transcoded from MP3 to PCM WAV by ffmpeg, uploaded as actual WAV bytes, transcribed by real STT, answered by the real character engine, and synthesized by real TTS.',
    limitations: ['Focused integration coverage does not establish full character or memory quality.',
      'HTTP assertions use explicit fictional inputs and saved state; authored reference answers and fake providers are never used.',
      'A missing/failed real request is recorded as failed or blocked and is never replaced.',
      'Public table count comparison detects changes during this run; concurrent external writes could also change those counts.'],
    fatal_error: fatal, cleanup_error: cleanupError, steps, snapshots,
  };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(clean(report), null, 2) + '\n');
  await writeFile(resolve(output, 'http.jsonl'), httpRecords.map(item => JSON.stringify(clean(item))).join('\n') + (httpRecords.length ? '\n' : ''));
  await writeFile(resolve(output, 'api-requests.jsonl'), telemetry.map(item => JSON.stringify(item)).join('\n') + (telemetry.length ? '\n' : ''));
  const rows = steps.map(item => `| ${item.name} | ${item.status} | ${item.error_code ?? ''} |`).join('\n');
  await writeFile(resolve(output, 'report.md'), `Real integrated HTTP verification: ${status}\n\n| Check | Status | Error |\n| --- | --- | --- |\n${rows}\n\n${report.delivery_evidence}\n\nActual OpenAI requests: ${telemetry.length}; completed reply responses with IDs: ${report.actual_api_requests.replies_with_ids}.\n`);
}

async function request(method: string, path: string, session?: Session, body?: Json | FormData): Promise<Json> {
  const before = provider?.telemetry.length ?? 0;
  const isForm = body instanceof FormData;
  const response = await fetch(base + path, {
    method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(!isForm && body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000),
  });
  let data: Json;
  try { data = await response.json() as Json; } catch { throw new HttpFailure('invalid_http_response', response.status); }
  const calls = provider?.telemetry.slice(before) ?? [];
  const replyCall = calls.findLast(event => event.stage === 'reply' && event.outcome === 'completed' && event.responseId);
  const modelReply = provider?.lastReply;
  httpRecords.push({ method, path, status: response.status,
    ...(body && !isForm && typeof body.request_id === 'string' ? { request_id: body.request_id } : {}),
    input: isForm ? { encoding: 'multipart/form-data', contains_actual_audio: true, fixture_id: null } : clean(body),
    response: clean(data), api_calls: calls,
    model_reply: replyCall && modelReply?.responseId === replyCall.responseId ? modelReply : null });
  if (!response.ok) {
    const code = typeof data.error?.code === 'string' ? data.error.code : `http_${response.status}`;
    if ((FATAL_OPENAI_ERROR_CODES as readonly string[]).includes(code)) fatal = code;
    throw new HttpFailure(code, response.status);
  }
  return data;
}
async function panel(session: Session, label?: string) {
  const data = await request('GET', '/api/demo/panel', session);
  assert(Array.isArray(data.entities) && Array.isArray(data.preferences), 'panel_missing_persistent_context');
  if (label) snapshots[label] = clean(data);
  return data;
}
async function open(key: 'an' | 'binh'): Promise<Session> {
  const data = await request('POST', '/api/sessions', undefined, { request_id: randomUUID(), demo_profile_key: key });
  assert(data.provider_mode === 'real' && data.engine_mode === 'character_memory', 'session_is_not_real_integrated');
  assert(typeof data.session_id === 'string' && typeof data.demo_token === 'string', 'invalid_session_response');
  return { id: data.session_id, token: data.demo_token };
}
async function prepare(session: Session, text: string) {
  const data = await request('POST', `/api/sessions/${session.id}/turns`, session, {
    request_id: randomUUID(), kind: 'utterance', text, text_only: true, language_hint: 'en',
  });
  assert(data.provider_mode === 'real' && data.engine_mode === 'character_memory' && data.input_mode === 'text' && data.audio === null, 'typed_turn_is_not_real_integrated');
  assert(httpRecords.at(-1)?.api_calls.some(event => event.stage === 'reply' && event.outcome === 'completed' && event.responseId), 'typed_turn_has_no_actual_reply_request');
  assert(typeof data.turn_id === 'string' && data.presentation && data.memory, 'missing_engine_turn_metadata');
  pending.set(data.turn_id, { session, turnId: data.turn_id });
  return data;
}
async function receipt(session: Session, turn: Json, status: 'started' | 'completed' | 'interrupted', playedMs = 0, requestId = randomUUID()) {
  const body = { request_id: requestId, status, played_ms: playedMs, state_version: turn.state_version };
  const result = await request('POST', `/api/sessions/${session.id}/turns/${turn.turn_id}/playback`, session, body);
  if (status !== 'started') pending.delete(turn.turn_id);
  return { result, body };
}
async function delivered(session: Session, turn: Json, playedMs = 0) {
  await receipt(session, turn, 'started');
  return receipt(session, turn, 'completed', playedMs);
}
async function cancelPending() {
  for (const [id, turn] of pending) {
    try { await request('DELETE', `/api/sessions/${turn.session.id}/turns/${id}`, turn.session); } catch { /* Original failure remains recorded. */ }
    pending.delete(id);
  }
}
async function step(name: string, run: () => Promise<unknown>, dependencies: string[] = []) {
  const blocked = fatal ?? dependencies.find(dependency => steps.find(item => item.name === dependency)?.status !== 'passed');
  if (blocked) { steps.push({ name, status: 'blocked', elapsed_ms: 0, error_code: fatal ? 'blocked_by_provider_failure' : `dependency_${blocked}` }); return; }
  const time = performance.now();
  try {
    const evidence = await run();
    steps.push({ name, status: 'passed', elapsed_ms: Math.round(performance.now() - time), evidence: clean(evidence) });
    console.log(`${name}: passed`);
  } catch (error) {
    const code = safeCode(error);
    if ((FATAL_OPENAI_ERROR_CODES as readonly string[]).includes(code)) fatal = code;
    steps.push({ name, status: 'failed', elapsed_ms: Math.round(performance.now() - time), error_code: code, error_location: safeLocation(error) });
    console.log(`${name}: failed (${code})`);
    await cancelPending();
  }
  await save('running');
}
let an: Session | undefined;
let binh: Session | undefined;
let dogId = '';
let firstTurn: Json | undefined;
let firstCompletedBody: Json | undefined;
let priorDay: Json | undefined;
try {
  await step('startup', async () => {
    await ensureDatabaseTunnel(process.env);
    publicBefore = await publicCounts();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    integrated = await createIntegratedApp({ ...process.env, DATABASE_URL: isolatedUrl.toString(), MIU_PROVIDER: 'real',
      HOST: '127.0.0.1', PORT: '3001' });
    assert(integrated.bridge.mode === 'real' && integrated.bridge.application.provider instanceof OpenAIProvider, 'real_provider_required');
    provider = integrated.bridge.application.provider;
    server = createServer(integrated.app);
    base = await server.listen({ host: '127.0.0.1', port: 0 });
    const searchPath = (await integrated.bridge.application.memory.db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema;
    assert(searchPath === schema, 'database_schema_isolation_failed');
    const health = await request('GET', '/api/health');
    assert(health.provider_mode === 'real' && health.engine_mode === 'character_memory', 'health_is_not_real_integrated');
    return { current_schema: searchPath, health };
  });
  await step('an_session_config', async () => {
    an = await open('an');
    await request('PATCH', '/api/profiles/current/config', an, { request_id: randomUUID(), language_mode: 'en', personality: 'ENFP', role: 'friend' });
    const current = await panel(an, 'an_initial');
    assert(current.entities.length === 0 && current.preferences.length === 0, 'isolated_profile_not_empty');
    assert(current.configuration.language_mode === 'en', 'english_configuration_not_applied');
    return { entities: current.entities.length, preferences: current.preferences.length, state_version: current.state_version };
  }, ['startup']);
  if (!values['browser-only']) {
  if (!values['voice-followup']) {
  await step('prepare_does_not_learn', async () => {
    firstTurn = await prepare(an!, 'My dog is named Moki.');
    const before = await panel(an!, 'before_first_delivery');
    assert(before.entities.length === 0, 'memory_learned_before_delivery');
    await receipt(an!, firstTurn, 'started');
    const started = await panel(an!, 'after_started_before_completed');
    assert(started.entities.length === 0, 'memory_learned_on_started');
    return { turn_id: firstTurn.turn_id, reply: firstTurn.reply, before_entities: before.entities.length };
  }, ['an_session_config']);
  await step('completed_delivery_learns_once', async () => {
    const completed = await receipt(an!, firstTurn!, 'completed');
    firstCompletedBody = completed.body;
    const after = await panel(an!, 'after_first_completed');
    const pets = after.entities.filter((entity: Json) => entity.kind === 'pet' && entity.name === 'Moki');
    assert(pets.length === 1, 'explicit_pet_not_learned_once');
    dogId = pets[0].id;
    return { entity_id: dogId, receipt: completed.result };
  }, ['prepare_does_not_learn']);
  await step('receipt_retry_is_idempotent', async () => {
    await request('POST', `/api/sessions/${an!.id}/turns/${firstTurn!.turn_id}/playback`, an!, firstCompletedBody!);
    const after = await panel(an!, 'after_duplicate_receipt');
    assert(after.entities.filter((entity: Json) => entity.name === 'Moki').length === 1 && after.entities.some((entity: Json) => entity.id === dogId), 'duplicate_receipt_duplicated_entity');
    const count = (await integrated!.bridge.application.memory.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM turn_learning WHERE turn_id=$1', [firstTurn!.turn_id],
    )).rows[0]?.count;
    assert(count === '1', 'duplicate_learning_ledger_entry');
    return { entity_id: dogId, learning_ledger_rows: Number(count) };
  }, ['completed_delivery_learns_once']);
  await step('rename_preserves_entity_identity', async () => {
    const turn = await prepare(an!, 'I said the name wrong. My dog is Mochi, not Moki. Please correct it.');
    const after = await panel(an!, 'after_name_correction');
    const pets = after.entities.filter((entity: Json) => entity.kind === 'pet');
    assert(pets.length === 1 && pets[0].id === dogId && pets[0].name === 'Mochi', 'correction_did_not_preserve_entity_identity');
    assert(turn.memory.invalidate_replay === true, 'correction_missing_replay_invalidation');
    await delivered(an!, turn);
    priorDay = await panel(an!);
    return { entity_id: dogId, canonical_name: pets[0].name, reply: turn.reply };
  }, ['completed_delivery_learns_once']);
  await step('next_day_reopen_recall', async () => {
    await request('POST', '/api/demo/next-day', an!, { request_id: randomUUID(), expected_clock_version: priorDay!.clock_version });
    an = await open('an');
    const after = await panel(an, 'next_day_before_recall');
    assert(after.clock.localDate > priorDay!.clock.localDate && after.daily.growthDays === priorDay!.daily.growthDays + 1, 'daily_growth_not_advanced_once');
    assert(after.entities.some((entity: Json) => entity.id === dogId && entity.name === 'Mochi'), 'canonical_pet_not_retained_next_day');
    const turn = await prepare(an, "What is my dog's name?");
    assert(/\bMochi\b/u.test(turn.reply.text) && !/\bMoki\b/u.test(turn.reply.text), 'next_day_recall_wrong_name');
    await delivered(an, turn);
    return { local_date: after.clock.localDate, growth_days: after.daily.growthDays, reply: turn.reply };
  }, ['rename_preserves_entity_identity']);
  await step('cancel_unheard_preference', async () => {
    const before = await panel(an!);
    assert(!before.preferences.some((preference: Json) => /painting/iu.test(preference.value)), 'cancel_test_precondition_preference_exists');
    const turn = await prepare(an!, 'I like painting.');
    await request('DELETE', `/api/sessions/${an!.id}/turns/${turn.turn_id}`, an!);
    pending.delete(turn.turn_id);
    const after = await panel(an!, 'after_unheard_cancel');
    assert(!after.preferences.some((preference: Json) => /painting/iu.test(preference.value)), 'canceled_unheard_preference_was_saved');
    return { turn_id: turn.turn_id, saved: false };
  }, ['an_session_config']);
  await step('no_save_suppresses_capture', async () => {
    const before = await panel(an!);
    const turn = await prepare(an!, "Don't remember this. I like skating.");
    await delivered(an!, turn);
    const after = await panel(an!, 'after_no_save');
    assert(!after.preferences.some((preference: Json) => /skating/iu.test(preference.value)), 'no_save_preference_was_saved');
    assert(JSON.stringify(after.entities.map((entity: Json) => [entity.id, entity.name])) === JSON.stringify(before.entities.map((entity: Json) => [entity.id, entity.name])), 'no_save_deleted_existing_entities');
    return { saved: false, preserved_existing_entities: true, reply: turn.reply };
  }, ['rename_preserves_entity_identity']);
  } else {
    await step('seed_pet_for_followup_isolation', async () => {
      const turn = await prepare(an!, 'My dog is named Mochi.');
      const before = await panel(an!);
      assert(before.entities.length === 0, 'followup_seed_learned_before_delivery');
      await delivered(an!, turn);
      const after = await panel(an!, 'followup_an_seeded');
      const pets = after.entities.filter((entity: Json) => entity.kind === 'pet' && entity.name === 'Mochi');
      assert(pets.length === 1, 'followup_pet_not_saved');
      dogId = pets[0].id;
      return { entity_id: dogId, reply: turn.reply };
    }, ['an_session_config']);
  }
  await step('binh_profile_isolation', async () => {
    binh = await open('binh');
    await request('PATCH', '/api/profiles/current/config', binh, { request_id: randomUUID(), language_mode: 'en' });
    const before = await panel(binh, 'binh_initial');
    assert(before.entities.length === 0 && before.preferences.length === 0, 'binh_inherited_an_memory');
    const turn = await prepare(binh, "What is my dog's name?");
    assert(!/\b(?:Mochi|Moki)\b/u.test(turn.reply.text), 'cross_profile_name_leak');
    await delivered(binh, turn);
    const after = await panel(binh, 'binh_after_recall');
    assert(after.entities.length === 0, 'binh_invented_an_pet');
    return { reply: turn.reply, entities: after.entities.length };
  }, [values['voice-followup'] ? 'seed_pet_for_followup_isolation' : 'rename_preserves_entity_identity']);
  if (values['skip-voice']) steps.push({ name: 'real_audio_stt_engine_tts', status: 'not_attempted', elapsed_ms: 0, error_code: 'explicit_skip_voice' });
  else await step('real_audio_stt_engine_tts', async () => {
    const signal = AbortSignal.timeout(240_000);
    const config = integrated!.config;
    const spokenInput = 'I like drawing.';
    const inputAudio = await createElevenLabsTts(config, fetch)(spokenInput, config.defaultVoices.en, 'en', signal);
    const directory = await mkdtemp(resolve(tmpdir(), 'miu-real-voice-'));
    let inputBytes: Buffer;
    try {
      const source = resolve(directory, 'actual-tts.mp3');
      const target = resolve(directory, 'actual-upload.wav');
      await writeFile(source, inputAudio.bytes);
      await promisify(execFile)('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target], { timeout: 30_000, maxBuffer: 8192 });
      inputBytes = await readFile(target);
    } finally { await rm(directory, { recursive: true, force: true }); }
    assert(inputBytes.subarray(0, 4).toString() === 'RIFF' && inputBytes.subarray(8, 12).toString() === 'WAVE', 'transcoded_input_is_not_wav');
    const form = new FormData();
    const requestId = randomUUID();
    form.set('request_id', requestId); form.set('kind', 'utterance'); form.set('language_hint', 'en');
    form.set('audio', new Blob([new Uint8Array(inputBytes)], { type: 'audio/wav' }), 'fictional-utterance.wav');
    const turn = await request('POST', `/api/sessions/${an!.id}/turns`, an!, form);
    pending.set(turn.turn_id, { session: an!, turnId: turn.turn_id });
    assert(httpRecords.at(-1)?.api_calls.some(event => event.stage === 'reply' && event.outcome === 'completed' && event.responseId), 'audio_turn_has_no_actual_reply_request');
    assert(turn.provider_mode === 'real' && turn.engine_mode === 'character_memory' && turn.input_mode === 'audio', 'audio_turn_is_not_real_integrated');
    assert(typeof turn.transcript?.text === 'string' && /drawing/iu.test(turn.transcript.text), 'real_stt_did_not_recognize_drawing');
    assert(turn.audio?.mime_type === 'audio/mpeg' && typeof turn.audio.data_base64 === 'string', 'missing_actual_synthesized_audio');
    const replyBytes = Buffer.from(turn.audio.data_base64, 'base64');
    const inspected = await inspectSynthesizedAudio(replyBytes, turn.audio.mime_type, signal, config.ffprobePath);
    assert(replyBytes.length > 0 && inspected.durationMs > 0, 'invalid_actual_tts_audio');
    const before = await panel(an!);
    assert(!before.preferences.some((preference: Json) => /drawing/iu.test(preference.value)), 'audio_preference_saved_before_delivery');
    await delivered(an!, turn, Math.round(turn.audio.duration_ms));
    const after = await panel(an!, 'after_audio_completed');
    assert(after.preferences.some((preference: Json) => /drawing/iu.test(preference.value)), 'heard_audio_preference_not_saved');
    return { source: 'real_tts_fictional_utterance', transcript: turn.transcript, reply: turn.reply,
      input_audio: { bytes: inputAudio.bytes.length, mime_type: inputAudio.mimeType, duration_ms: inputAudio.durationMs, sha256: createHash('sha256').update(inputAudio.bytes).digest('hex') },
      uploaded_audio: { bytes: inputBytes.length, mime_type: 'audio/wav', sha256: createHash('sha256').update(inputBytes).digest('hex'), conversion: 'ffmpeg PCM signed 16-bit 16000 Hz mono' },
      reply_audio: { bytes: replyBytes.length, mime_type: inspected.mimeType, duration_ms: inspected.durationMs, sha256: createHash('sha256').update(replyBytes).digest('hex') },
      receipt_evidence: 'simulated HTTP delivery, not physical playback' };
  }, ['an_session_config']);
  }
  await step('real_browser_ui', () => verifyIntegratedBrowser(base, resolve(output, 'browser')), ['startup']);
  await step('actual_openai_request_provenance', async () => {
    const calls = provider!.telemetry;
    const replies = calls.filter(event => event.stage === 'reply' && event.outcome === 'completed' && event.responseId);
    assert(replies.length > 0, 'no_actual_model_reply_response_ids');
    assert(calls.some(event => event.stage === 'classify' && event.outcome === 'completed' && event.responseId), 'no_actual_classification_response_ids');
    assert(calls.some(event => event.stage === 'check' && event.outcome === 'completed' && event.responseId), 'no_actual_check_response_ids');
    return { actual_requests: calls.length, completed_reply_response_ids: replies.map(event => event.responseId), models: provider!.modelIds };
  }, ['startup']);
} catch (error) {
  steps.push({ name: 'unhandled_execution', status: 'failed', elapsed_ms: 0, error_code: safeCode(error) });
} finally {
  await cancelPending();
  try { await server?.close(); } catch (error) { cleanupError = safeCode(error); }
  try { await integrated?.close(); } catch (error) { cleanupError ??= safeCode(error); }
  try {
    publicAfter = await publicCounts();
    if (publicBefore && JSON.stringify(publicBefore) !== JSON.stringify(publicAfter)) {
      steps.push({ name: 'public_database_preserved', status: 'failed', elapsed_ms: 0, error_code: 'public_table_counts_changed' });
    } else if (publicBefore) steps.push({ name: 'public_database_preserved', status: 'passed', elapsed_ms: 0 });
  } catch (error) { cleanupError ??= safeCode(error); }
  try {
    if (schemaCreated && !values['preserve-schema']) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = true;
    }
  } catch (error) { cleanupError ??= safeCode(error); }
  await admin.end();
  const failed = steps.some(item => item.status === 'failed' || item.status === 'blocked') || cleanupError;
  await save(failed ? 'completed_with_unresolved_failures' : 'completed');
  console.log(`Saved real HTTP verification to ${output}`);
  if (failed) process.exitCode = 1;
}
