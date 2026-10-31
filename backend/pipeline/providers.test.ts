import test from 'node:test';
import assert from 'node:assert/strict';
import type { DirectorPlan } from '../shared/types.js';
import { fallback } from '../character/index.js';
import { FakeProvider, OpenAIProvider, createProvider, type OpenAITransport } from './providers.js';
import { classifyLocal } from './observations.js';

function plan(overrides: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    purpose: 'chat', language: 'en', ageBand: '6-8', personality: 'ENFP', role: 'friend',
    emotion: 'curious', dailyMood: 'content', rhythm: 'daytime', delivery: 'gentle',
    allowGiggle: false, allowPurr: false, face: { expression: 'curious', gesture: 'head_tilt' },
    memoryReferenceId: null, allowedFacts: [], allowedQuestion: null, exactText: null,
    maxSentences: 3, maxQuestions: 1, ruleTrace: [], comfortActive: false, ...overrides,
  };
}
function client(response: unknown, flagged = false) {
  const calls: Array<{ body: Record<string, unknown>; signal?: AbortSignal }> = [];
  const transport: OpenAITransport = {
    responses: { create: async (body, options) => { calls.push({ body, signal: options?.signal }); return response; } },
    moderations: { create: async () => ({ results: [{ flagged }] }) },
  };
  return { transport, calls };
}
const completed = (value: unknown) => ({ status: 'completed', output_text: typeof value === 'string' ? value : JSON.stringify(value) });

test('default fake mode needs no key and emits only authored text', async () => {
  const provider = createProvider({});
  assert.ok(provider instanceof FakeProvider);
  const p = plan();
  const text = await provider.reply({ instructions: 'ignored', input: 'ignored' }, p);
  assert.equal(text, fallback(p));
  assert.equal((await provider.check(text, p)).approved, true);
  assert.equal((await provider.check('Completely different words.', p)).approved, false);
  assert.equal((await provider.classify('My dog Mochi fell in a puddle.', 'en')).candidates.length, 2);
});

test('real configuration fails closed instead of silently falling back', () => {
  assert.throws(() => createProvider({ MIU_PROVIDER: 'real' }), /missing_openai_key/);
  assert.throws(() => createProvider({ MIU_PROVIDER: 'surprise' }), /invalid_provider_mode/);
});

test('classification uses strict structured outputs, explicit context and store false', async () => {
  const input = 'I like dinosaurs.';
  const mock = client(completed(classifyLocal(input, 'en')));
  const provider = new OpenAIProvider({ client: mock.transport });
  const controller = new AbortController();
  const observed = await provider.classify(input, 'en', controller.signal);
  assert.equal(observed.candidates.length, 1);
  assert.equal(mock.calls[0]?.body.store, false);
  assert.equal(mock.calls[0]?.body.tools, undefined);
  const format = (mock.calls[0]?.body.text as { format: { type: string; strict: boolean } }).format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  assert.equal(mock.calls[0]?.signal, controller.signal);
});

test('moderation flag suppresses input learning and routes safely', async () => {
  const input = 'My friend is Lan.';
  const mock = client(completed(classifyLocal(input, 'en')), true);
  const result = await new OpenAIProvider({ client: mock.transport }).classify(input, 'en');
  assert.equal(result.intent, 'unsafe');
  assert.equal(result.suppressLearning, true);
  assert.deepEqual(result.candidates, []);
});

test('real reply rejects refusals and incomplete output and passes the cancellation signal', async () => {
  const incomplete = new OpenAIProvider({ client: client({ status: 'incomplete', output_text: 'unchecked' }).transport });
  await assert.rejects(() => incomplete.reply({ instructions: '', input: '' }, plan()), /provider_incomplete/);
  const refusal = new OpenAIProvider({ client: client({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'blocked' }] }] }).transport });
  await assert.rejects(() => refusal.reply({ instructions: '', input: '' }, plan()), /provider_refusal/);
  const mock = client(completed('Hello.'));
  const provider = new OpenAIProvider({ client: mock.transport });
  const controller = new AbortController();
  assert.equal(await provider.reply({ instructions: 'trusted', input: 'data' }, plan(), controller.signal), 'Hello.');
  assert.equal(mock.calls[0]?.body.store, false);
  assert.equal(mock.calls[0]?.signal, controller.signal);
  assert.equal(mock.calls[0]?.body.instructions, 'trusted');
});

test('contextual verdict and moderation must both approve', async () => {
  const p = plan();
  const text = fallback(p);
  const allowed = new OpenAIProvider({ client: client(completed({ approved: true, violations: [] })).transport });
  assert.equal((await allowed.check(text, p)).approved, true);
  const flagged = new OpenAIProvider({ client: client(completed({ approved: true, violations: [] }), true).transport });
  assert.equal((await flagged.check(text, p)).approved, false);
  const contradictory = new OpenAIProvider({ client: client(completed({ approved: true, violations: ['unsupported_fact'] })).transport });
  assert.equal((await contradictory.check(text, p)).approved, false);
});

test('invalid JSON and missing moderation results fail closed', async () => {
  const invalid = new OpenAIProvider({ client: client(completed('invalid json')).transport });
  await assert.rejects(() => invalid.classify('Hello', 'en'), /provider_invalid_json/);
  const noModeration = client(completed(classifyLocal('Hello', 'en')));
  noModeration.transport.moderations.create = async () => ({ results: [] });
  await assert.rejects(() => new OpenAIProvider({ client: noModeration.transport }).classify('Hello', 'en'), /provider_validation_unavailable/);
});

test('aborted operations never issue requests and exact authored text skips generation', async () => {
  const mock = client(completed('Hello.'));
  const provider = new OpenAIProvider({ client: mock.transport });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => provider.reply({ instructions: '', input: '' }, plan(), controller.signal));
  assert.equal(mock.calls.length, 0);
  assert.equal(await provider.reply({ instructions: '', input: '' }, plan({ exactText: 'Hello.' })), 'Hello.');
  assert.equal(mock.calls.length, 0);
});

test('offline request contract uses identical classification instructions and guards in serving and evaluation', async () => {
  const text = 'Did I tell you Mochi got a bath today?';
  const observed = { ...classifyLocal(text), intent: 'share', candidates: [{ kind: 'event', subjectName: 'Mochi', eventType: 'reported_event', value: 'Mochi got a bath today', evidence: 'Mochi got a bath today' }] };
  const serving = client(completed(observed)); const evaluation = client(completed(observed));
  const normal = new OpenAIProvider({ client: serving.transport });
  const diagnostic = new OpenAIProvider({ client: evaluation.transport, evaluationMode: true });
  assert.deepEqual(await normal.classify(text, 'en'), await diagnostic.classify(text, 'en'));
  assert.equal(serving.calls[0]?.body.instructions, evaluation.calls[0]?.body.instructions);
  assert.deepEqual(diagnostic.lastClassification?.accepted.candidates, []);
  assert.equal(diagnostic.lastClassification?.rejectedCandidates[0]?.reason, 'non_asserted_source');
});
test('offline checker request receives the exact bounded generation context', async () => {
  const mock = client(completed({ approved: true, violations: [] }));
  const provider = new OpenAIProvider({ client: mock.transport });
  const context = { instructions: 'trusted', input: JSON.stringify({ current_utterance: 'I did not say that.', allowed_facts: ['The dog is Mochi.'], memory_operation: { type: 'corrected' } }) };
  await provider.check('Thank you for correcting that.', plan(), undefined, context);
  assert.deepEqual(JSON.parse(mock.calls[0]!.body.input as string).dialogue_context, JSON.parse(context.input));
});

test('offline raw creative moderation flags require an independent positive contextual verdict', async () => {
  const text = 'Tên lửa mới mình nên dùng màu thích nhất nào mình đã kể?';
  for (const safeContext of [true, false]) {
    const mock = client(null, true);
    const names: string[] = [];
    mock.transport.responses.create = async body => {
      const name = (body.text as { format: { name: string } }).format.name;
      names.push(name);
      return completed(name === 'miu_input_context_safety' ? { safeContext, reason: safeContext ? 'A clearly benign drawing color question.' : 'The creative context is ambiguous.' } : classifyLocal(text, 'vi'));
    };
    const provider = new OpenAIProvider({ client: mock.transport, evaluationMode: true });
    const observed = await provider.classify(text, 'vi');
    assert.equal(observed.intent === 'unsafe', !safeContext);
    assert.deepEqual(names, ['miu_observation', 'miu_input_context_safety']);
    assert.equal(provider.lastClassification?.inputSafety?.rawModerationApproved, false);
    assert.equal(provider.lastClassification?.inputSafety?.contextualAdjudication?.safeContext, safeContext);
  }
});
