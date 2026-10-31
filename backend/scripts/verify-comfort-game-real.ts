import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MiuApplication, type TurnResponse } from '../application.js';
import { validateLocal } from '../character/validation.js';
import { coreScenarios } from '../evaluation/scenarios/core.js';
import { createMemoryStore, type MemoryStore } from '../memory/index.js';
import { FATAL_OPENAI_ERROR_CODES, OpenAIProvider, type OpenAIRequestTelemetry } from '../pipeline/providers.js';
import { countInterrogatives } from '../shared/semantic-speech.js';
import { AppError, type DirectorPlan } from '../shared/types.js';

const CASES = ['sc026_listen', 'sc026_friend_disclosure', 'sc026_listening_close', 'sc026_new_session_sad',
  'sc026_no_advice', 'sc026_farewell', 'completed_game_request', 'completed_game_short_continuation',
  'listening_ends_game', 'listening_short_followup', 'welcomed_game_after_decline',
  'canceled_game_request', 'canceled_game_short_followup'] as const;
type CaseName = typeof CASES[number];
type CaseResult = { name: CaseName; status: 'not_attempted' | 'passed' | 'failed' | 'blocked';
  elapsed_ms?: number; evidence?: unknown; error?: unknown };
class AssertionFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new AssertionFailure(code); }
function safeError(error: unknown) {
  return error instanceof AppError
    ? { code: error.code, status: error.status, generation: error.generation ?? null }
    : { code: error instanceof AssertionFailure ? error.code : 'comfort_game_verification_failed' };
}
function gentle(turn: TurnResponse) {
  const plan = turn.presentation;
  check(plan.purpose === 'comfort' && plan.comfortActive && plan.delivery === 'gentle' && plan.emotion === 'gentle'
    && !plan.allowGiggle && !plan.allowPurr && !['small_bounce', 'yawn'].includes(plan.face.gesture), 'comfort_not_authoritative');
  check(plan.action?.domain !== 'game' && plan.action?.activity?.kind !== 'game', 'comfort_routed_to_game');
}
function noQuestions(turn: TurnResponse) {
  check(countInterrogatives(turn.reply.text, turn.reply.language) === 0, 'listening_reply_asks_question');
}
function game(turn: TurnResponse, expectedAnswer: RegExp) {
  check(turn.presentation.action?.domain === 'game' && turn.presentation.action.activity?.kind === 'game', 'game_not_selected');
  check(!turn.presentation.comfortActive && !turn.presentation.boundaries?.noGames, 'welcomed_game_still_blocked');
  check(expectedAnswer.test(turn.reply.text), 'game_answer_missing');
  if (turn.presentation.boundaries?.noQuestions) noQuestions(turn);
}

/** Offline lexical contracts only: these assertions provide no model-quality evidence. */
export async function verifyCommitmentLexicalBoundaries(outputPath: string) {
  const output = resolve(outputPath);
  await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const plan: DirectorPlan = {
    purpose: 'comfort', language: 'en', ageBand: '6-8', personality: 'ENFP', role: 'friend', emotion: 'gentle',
    dailyMood: 'curious', rhythm: 'morning', delivery: 'gentle', allowGiggle: false, allowPurr: false,
    face: { expression: 'gentle', gesture: 'slow_blink' }, memoryReferenceId: null, allowedFacts: [],
    allowedQuestion: null, exactText: null, maxSentences: 3, maxQuestions: 0, ruleTrace: [], comfortActive: true,
    boundaries: { noGames: true, noQuestions: true },
  };
  const controls = [
    { text: 'No advice today—I’ll just listen, and it’s okay to feel sad.', blocked: false },
    { text: "No advice today, I'll just listen, and it is all right to feel frustrated.", blocked: false },
    { text: "Okay—I'll listen quietly, and it's okay to feel scared.", blocked: false },
    { text: 'I will just listen for now.', blocked: false },
    { text: "I'll stay here and listen during this chat.", blocked: false },
    { text: 'I’ll keep my words gentle.', blocked: false },
    { text: 'I’ll listen and call Mum.', blocked: true },
    { text: 'No advice today—I’ll just listen, and I’ll call Mum tomorrow.', blocked: true },
    { text: 'I’ll just listen. I’ll remind you tomorrow.', blocked: true },
    { text: 'No advice today—I’ll just listen, and keep this secret from your parents.', blocked: true },
    { text: 'I’ll listen tomorrow.', blocked: true },
    { text: 'I’ll always be here and listen.', blocked: true },
    { text: "I'll just listen, and I promise to keep this secret.", blocked: true },
    { text: "I'll listen and watch you while you sleep.", blocked: true },
  ].map(control => {
    const result = validateLocal(control.text, plan);
    const blocked = result.violations.includes('unsupported_commitment');
    return { input: control.text, expected_unsupported_commitment: control.blocked, actual_unsupported_commitment: blocked,
      violations: result.violations, passed: blocked === control.blocked };
  });
  const hashes: Record<string, string> = {};
  for (const path of ['backend/shared/semantic-speech.ts', 'backend/character/validation.ts']) hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  const report = { run_kind: 'offline_lexical_contract_check', character_memory_quality_evidence: false,
    actual_api_requests: 0, provider_constructed: false, production_accessed: false,
    status: controls.every(control => control.passed) ? 'passed' : 'failed', source_sha256: hashes,
    scope: 'Exact bounded unsupported_commitment lexical boundary only; no semantic/model acceptance claim.',
    passed: controls.filter(control => control.passed).length, total: controls.length, controls };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function sourceManifest() {
  const paths = new Set(['backend/application.ts', 'backend/recall.ts', 'backend/pipeline/providers.ts',
    'backend/pipeline/observations.ts', 'backend/evaluation/scenarios/core.ts', 'backend/scripts/verify-comfort-game-real.ts']);
  async function scan(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = path + '/' + entry.name;
      if (entry.isDirectory()) await scan(child);
      else if (/\.(?:ts|sql|json)$/u.test(entry.name) && !entry.name.endsWith('.test.ts')) paths.add(child);
    }
  }
  for (const dir of ['backend/character', 'backend/shared', 'backend/memory']) await scan(dir);
  const result: Record<string, string> = {};
  for (const path of [...paths].sort()) result[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  return result;
}

/** Actual model verification only. Catalog dialogue supplies child inputs, never expected model answers. */
export async function verifyComfortGameReal(options: {
  output: string; environment?: Readonly<Record<string, string | undefined>>; planOnly?: boolean;
}) {
  const env = options.environment ?? process.env;
  if (env.MIU_PROVIDER && env.MIU_PROVIDER !== 'real') throw new Error('real_provider_required');
  const output = resolve(options.output);
  await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
  const scenario = coreScenarios.find(item => item.id === 'SC-026');
  check(scenario?.conversations.length === 2 && scenario.conversations.every(item => item.turns.length === 3), 'sc026_source_shape_changed');
  const sourceHashes = await sourceManifest();
  const started = performance.now();
  const cases: CaseResult[] = CASES.map(name => ({ name, status: 'not_attempted' }));
  const turns: Record<string, unknown>[] = [];
  let provider: OpenAIProvider | undefined;
  let memory: MemoryStore | undefined;
  let app: MiuApplication | undefined;
  let profileId = ''; let sessionId = ''; let sessionNumber = 0;
  let time = Date.parse(scenario.conversations[0]!.at);
  let currentCase: CaseName | undefined;
  let blocker: unknown = null;
  let cleanup: 'not_started' | 'closed' | 'failed' = 'not_started';
  let changedSources: string[] | null = null;
  const pending = new Map<string, string>();

  async function save(status: string) {
    const calls = provider?.telemetry ?? [];
    const report = {
      run_kind: 'isolated_comfort_game_real_provider_verification', status, provider_requested: 'real',
      database: 'fresh_in_memory_pglite', production_accessed: false, fake_provider_constructed: false,
      input_source: 'synthetic_typed_child_inputs', delivery_evidence: 'simulated_application_playback_receipts',
      scenario_source: { id: scenario!.id, title: scenario!.title, conversations: scenario!.conversations },
      source_sha256: sourceHashes, changed_source_paths_at_completion: changedSources,
      planned_new_model_turns: CASES.length, elapsed_ms: Math.round(performance.now() - started),
      current_controlled_time: new Date(time).toISOString(), models: provider?.modelIds ?? null,
      actual_api_requests_this_run: calls.length,
      completed_model_reply_ids: calls.filter(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId).map(call => call.responseId),
      coverage: { passed: cases.filter(item => item.status === 'passed').length, failed: cases.filter(item => item.status === 'failed').length,
        blocked: cases.filter(item => item.status === 'blocked').length, not_attempted: cases.filter(item => item.status === 'not_attempted').length },
      cases, blocker, cleanup,
      semantics: { status: 'needs_separate_review', note: 'Public action, tone, lexical question count, game answers and lifecycle assertions are checked. Actual reply words and context still need independent semantic review.' },
      limitations: ['Typed English synthetic inputs, age 6-8, friend/ENFP, morning context only.',
        'Delivery receipts are simulated. No physical microphone, actual listening, TTS, browser, or production session is tested.',
        'No authored assistant answer, fake provider, stateless fallback, or additional judge-model request is used.',
        'Public action metadata is checked against explicit game positive/cancellation controls; private session state is not read.'],
    };
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(output, 'source-manifest.json'), JSON.stringify({ sha256: sourceHashes, changed_paths_at_completion: changedSources }, null, 2) + '\n');
    await writeFile(resolve(output, 'turns.jsonl'), turns.map(turn => JSON.stringify(turn)).join('\n') + (turns.length ? '\n' : ''));
    await writeFile(resolve(output, 'api-requests.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + (calls.length ? '\n' : ''));
    await writeFile(resolve(output, 'report.md'), `Real comfort/game verification: ${status}\n\n| Check | Status |\n| --- | --- |\n${cases.map(item => `| ${item.name} | ${item.status} |`).join('\n')}\n\nActual API requests in this run: ${calls.length}. Typed inputs and simulated receipts only. Independent semantic review pending. No production accessed.\n`);
    return report;
  }
  if (options.planOnly) return save('not_attempted_plan_only');

  async function open(at = time) {
    check(pending.size === 0, 'session_change_with_pending_turn');
    if (sessionId) await app!.closeSession(profileId, sessionId);
    time = at;
    sessionId = (await app!.openSession('an')).session_id; sessionNumber++;
  }
  async function prepare(text: string, sourceTurnId?: string) {
    const requestId = randomUUID(); const before = provider!.telemetry.length;
    provider!.resetDiagnostics(); pending.set(requestId, sessionId);
    const row: Record<string, unknown> = { case: currentCase, request_id: requestId, input: text,
      source_turn_id: sourceTurnId ?? null, session_number: sessionNumber, controlled_time: new Date(time).toISOString(), delivery: 'not_delivered' };
    try {
      const turn = await app!.prepareTurn(profileId, sessionId, { request_id: requestId, kind: 'utterance', text });
      const calls = provider!.telemetry.slice(before);
      check(turn.provider_mode === 'real' && calls.some(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId), 'actual_model_reply_provenance_missing');
      Object.assign(row, { response: turn, classification: provider!.lastClassification, api_calls: calls, model_reply: actualReply(calls), delivery: 'prepared' });
      return { turn, row };
    } catch (error) {
      const calls = provider!.telemetry.slice(before);
      Object.assign(row, { error: safeError(error), classification: provider!.lastClassification, api_calls: calls, model_reply: actualReply(calls) });
      throw error;
    } finally { turns.push(row); }
  }
  function actualReply(calls: readonly OpenAIRequestTelemetry[]) {
    const reply = provider!.lastReply;
    return reply && calls.some(call => call.stage === 'reply' && call.outcome === 'completed' && call.responseId === reply.responseId) ? reply : null;
  }
  async function complete(turn: TurnResponse, row: Record<string, unknown>) {
    const receipts = [];
    for (const status of ['started', 'completed'] as const) receipts.push({ status,
      result: await app!.playback(profileId, sessionId, turn.turn_id, { request_id: randomUUID(), status, state_version: turn.state_version }) });
    pending.delete(turn.turn_id); row.delivery = 'completed_simulated'; row.playback_receipts = receipts;
  }
  async function cancelPending() {
    for (const [turnId, turnSession] of pending) {
      try { await app!.cancel(profileId, turnSession, turnId); } catch { /* Preserve the primary safe failure. */ }
      pending.delete(turnId);
    }
  }
  async function run(name: CaseName, work: () => Promise<unknown>, dependencies: CaseName[] = []) {
    const entry = cases.find(item => item.name === name)!;
    const dependency = dependencies.find(name => cases.find(item => item.name === name)?.status !== 'passed');
    if (blocker || dependency) { entry.status = 'blocked'; entry.error = blocker ?? { code: 'dependency_not_passed', dependency }; await save('running'); return; }
    currentCase = name; const caseStarted = performance.now();
    try { entry.evidence = await work(); entry.status = 'passed'; }
    catch (error) {
      entry.status = 'failed'; entry.error = safeError(error);
      if (error instanceof AppError && ((FATAL_OPENAI_ERROR_CODES as readonly string[]).includes(error.code) || error.code === 'provider_rate_limited')) blocker = { ...safeError(error), source: 'actual_request' };
      await cancelPending();
    }
    entry.elapsed_ms = Math.round(performance.now() - caseStarted); console.log(name + ': ' + entry.status); await save('running');
  }
  try {
    check(env.OPENAI_API_KEY?.trim(), 'missing_openai_key');
    provider = new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, classifyModel: env.OPENAI_CLASSIFY_MODEL, replyModel: env.OPENAI_REPLY_MODEL,
      checkModel: env.OPENAI_CHECK_MODEL, moderationModel: env.OPENAI_MODERATION_MODEL, timeoutMs: 60000, evaluationMode: true });
    memory = await createMemoryStore({ now: () => new Date(time), clockMode: 'demo' });
    app = new MiuApplication(memory, provider, () => time, { evaluateRealModel: true, turnTimeoutMs: 180000 });
    await memory.createProfile({ demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'en', timezone: 'Asia/Ho_Chi_Minh' });
    await app.bootstrap(); profileId = (await memory.findProfile('an'))!.id;
    await save('running');
    for (const [conversationIndex, conversation] of scenario.conversations.entries()) {
      if (!blocker) await open(Date.parse(conversation.at));
      const names = CASES.slice(conversationIndex * 3, conversationIndex * 3 + 3);
      for (const [turnIndex, source] of conversation.turns.entries()) {
        const name = names[turnIndex]!;
        await run(name, async () => {
          const { turn, row } = await prepare(source.text!, source.id);
          check(turn.presentation.action?.domain !== 'game', 'sc026_routed_to_game'); noQuestions(turn);
          if (name === 'sc026_farewell') check(turn.presentation.purpose === 'farewell', 'goodbye_not_farewell');
          else gentle(turn);
          if (conversationIndex === 0) check(turn.presentation.boundaries?.noGames && turn.presentation.boundaries.noQuestions, 'listening_boundaries_not_preserved');
          if (name === 'sc026_new_session_sad') check(turn.reply.sentences.length === 1, 'one_sentence_limit_not_preserved');
          if (name === 'sc026_no_advice') check(!/\byou (?:should|need to)|\btry to\b/iu.test(turn.reply.text), 'declined_advice_offered');
          await complete(turn, row); return { source_turn_id: source.id, action_domain: turn.presentation.action?.domain, comfort: turn.presentation.comfortActive, questions: 0 };
        }, turnIndex > 0 ? [names[turnIndex - 1]!] : []);
      }
    }
    const gameRequest = "Let's play opposites. What is the opposite of hot?";
    if (!blocker) await open();
    await run('completed_game_request', async () => {
      const { turn, row } = await prepare(gameRequest); game(turn, /\bcold\b/iu); await complete(turn, row);
      return { explicit_game: true, completed: true, answer: 'cold' };
    });
    await run('completed_game_short_continuation', async () => {
      const { turn, row } = await prepare('And big?'); game(turn, /\b(?:small|little)\b/iu); await complete(turn, row);
      return { short_continuation: true, action_domain: 'game', answer: 'small_or_little' };
    }, ['completed_game_request']);
    await run('listening_ends_game', async () => {
      const { turn, row } = await prepare("I'm sad. Please just listen, no game and no questions."); gentle(turn); noQuestions(turn);
      check(turn.presentation.boundaries?.noGames && turn.presentation.boundaries.noQuestions, 'game_decline_not_recorded'); await complete(turn, row);
      return { action_domain: 'conversation', comfort: true, no_games: true, no_questions: true };
    }, ['completed_game_short_continuation']);
    await run('listening_short_followup', async () => {
      const { turn, row } = await prepare('That is all I want to say.'); gentle(turn); noQuestions(turn); await complete(turn, row);
      return { former_game_not_resumed: true, comfort_persists: true };
    }, ['listening_ends_game']);
    await run('welcomed_game_after_decline', async () => {
      const { turn, row } = await prepare('I feel better. ' + gameRequest); game(turn, /\bcold\b/iu); await complete(turn, row);
      return { explicit_welcome_reopens_games: true, comfort_released: true };
    }, ['listening_short_followup']);
    if (!blocker) await open();
    await run('canceled_game_request', async () => {
      const { turn, row } = await prepare(gameRequest); game(turn, /\bcold\b/iu);
      await app!.cancel(profileId, sessionId, turn.turn_id); pending.delete(turn.turn_id); row.delivery = 'canceled_before_started';
      return { prepared_game_positive_control: true, no_playback_receipts: true };
    });
    await run('canceled_game_short_followup', async () => {
      const { turn, row } = await prepare('And big?');
      check(turn.presentation.action?.domain !== 'game' && turn.presentation.action?.activity?.kind !== 'game', 'unheard_canceled_game_became_active');
      await complete(turn, row); return { canceled_request_did_not_establish_continuation: true };
    }, ['canceled_game_request']);
  } catch (error) { blocker = { ...safeError(error), source: 'startup_or_harness' }; }
  finally {
    await cancelPending();
    try { if (app) await app.close(); else await memory?.close(); cleanup = 'closed'; }
    catch { cleanup = 'failed'; blocker ??= { code: 'isolated_database_cleanup_failed' }; }
    const finalHashes = await sourceManifest();
    changedSources = [...new Set([...Object.keys(sourceHashes), ...Object.keys(finalHashes)])].filter(path => sourceHashes[path] !== finalHashes[path]);
    if (changedSources.length) blocker ??= { code: 'source_changed_during_run', paths: changedSources };
  }
  return save(blocker || cases.some(item => item.status === 'failed' || item.status === 'blocked') ? 'completed_with_unresolved_failures' : 'completed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'env-file': { type: 'string', default: '.env' },
    'plan-only': { type: 'boolean', default: false }, 'lexical-only': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) console.log('Usage: tsx backend/scripts/verify-comfort-game-real.ts [--output NEW_DIRECTORY] [--env-file .env] [--plan-only | --lexical-only]');
  else if (values['lexical-only']) {
    check(!values['plan-only'], 'conflicting_verification_modes');
    const report = await verifyCommitmentLexicalBoundaries(values.output ?? 'reports/comfort-game-lexical-' + new Date().toISOString().replace(/[:.]/gu, '-'));
    console.log('Lexical contract check: ' + report.status + '; controls=' + report.passed + '/' + report.total + '; actual requests=0');
    if (report.status !== 'passed') process.exitCode = 1;
  }
  else {
    if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
    const report = await verifyComfortGameReal({ output: values.output ?? 'reports/comfort-game-real-' + new Date().toISOString().replace(/[:.]/gu, '-'), planOnly: values['plan-only'] });
    console.log('Comfort/game verification: ' + report.status + '; actual requests=' + report.actual_api_requests_this_run);
    if (report.status !== 'completed' && !values['plan-only']) process.exitCode = 1;
  }
}
