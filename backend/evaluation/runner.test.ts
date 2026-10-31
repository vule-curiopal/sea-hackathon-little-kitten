import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarios, validateScenarios } from './catalog.js';
import { loadHistoricalSessions, runEvaluation } from './runner.js';
import { FakeProvider } from '../pipeline/providers.js';
import { AppError } from '../shared/types.js';
import type { Scenario, TurnLog } from './types.js';

const turn = (id: string, text: string) => ({
  id, text,
  assertions: [{ requirement: 'VOICE-02', description: 'Approved speech exists', target: 'response.reply.text', op: 'exists' as const }],
  rubric: ['Answer the current child utterance without inventing physical access.'],
});

test('catalog has 102 distinct multi-conversation scenarios including memory regressions', () => {
  validateScenarios(scenarios);
  assert.equal(scenarios.length, 102);
  assert.equal(new Set(scenarios.map(item => item.id)).size, 102);
  assert.ok(scenarios.every(item => item.conversations.length >= 2 && item.conversations.every(conversation => conversation.turns.length >= 2)));
  assert.ok(scenarios.filter(item => item.history_dates.length).length >= 5);
  assert.deepEqual(new Set(scenarios.flatMap(item => item.conversations.flatMap(conversation => conversation.config?.personality ? [conversation.config.personality] : []))).size, 16);
});

test('catalog rejects single-conversation scenarios, duplicate IDs and invalid regexes', () => {
  const item = structuredClone(scenarios[0]!);
  item.conversations = item.conversations.slice(0, 1);
  assert.throws(() => validateScenarios([item], 1), /at least two conversations/);
  assert.throws(() => validateScenarios([scenarios[0]!, scenarios[0]!], 2), /duplicate scenario ID/);
  const badRegex = structuredClone(scenarios[0]!);
  badRegex.conversations[0]!.turns[0]!.assertions[0] = { requirement: 'SAFE-01', description: 'Invalid test', target: 'response.reply.text', op: 'matches', value: '[' };
  assert.throws(() => validateScenarios([badRegex], 1), /Invalid regular expression/);
});

test('historical fixture has only synthetic data and all 365 sessions can be selected', async () => {
  const history = await loadHistoricalSessions();
  assert.equal(history.length, 365);
  assert.ok(history.every(session => session.synthetic && session.messages[0]?.role === 'user'));
});

test('offline harness self-test verifies journaling, delivery, clock and scenario isolation without claiming model quality', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-evaluation-'));
  const first: Scenario = {
    id: 'SC-901', title: 'Harness delivery and rollover', category: 'harness', requirements: ['MEM-01', 'TIME-01'], history_dates: [],
    conversations: [
      { id: 'c1', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [
        turn('pet', 'My dog is Mochi'),
        { ...turn('interrupted', 'My hobby is painting'), delivery: 'interrupted' },
      ] },
      { id: 'c2', profile: 'an', at: '2026-11-02T09:00:00+07:00', transition: 'next_day_retry', turns: [
        turn('recall', "What is my dog's name?"), turn('finish', 'Goodbye'),
      ] },
      { id: 'c3', profile: 'binh', at: '2026-11-02T09:05:00+07:00', turns: [turn('switch', 'Hello'), turn('end-switch', 'Goodbye')] },
    ],
  };
  const second: Scenario = {
    id: 'SC-902', title: 'Harness isolation', category: 'harness', requirements: ['DATA-01'], history_dates: [],
    conversations: [
      { id: 'c1', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [turn('fresh', "What is my dog's name?"), turn('hello', 'Hello')] },
      { id: 'c2', profile: 'binh', at: '2026-11-02T09:00:00+07:00', turns: [turn('other', 'Hello'), turn('bye', 'Goodbye')] },
    ],
  };
  const result = await runEvaluation({ scenarios: [first, second], history: 'none', outputDir: join(parent, 'run'), runKind: 'harness_self_test', providerInstance: new FakeProvider() });
  const logs = (await readFile(join(result.outputDir, 'turns.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as TurnLog);
  assert.equal(logs.length, 10);
  assert.ok(logs.every(log => !log.error && log.response && log.provider_mode === 'fake'));
  assert.ok(logs.every(log => log.run_kind === 'harness_self_test' && log.reply_origin === 'test_double'));
  assert.equal(logs[1]!.delivery?.status, 'interrupted');
  assert.equal(logs[1]!.after.preferences.some(preference => preference.value === 'painting'), false);
  assert.match(logs[2]!.response!.reply.text, /Mochi/u);
  assert.equal(logs[2]!.before.clock.localDate, '2026-11-02');
  assert.equal(logs[2]!.transition?.first?.clock.version, logs[2]!.transition?.retry?.clock.version);
  assert.equal(logs[2]!.transition?.retry?.applied, false);
  assert.equal(logs[4]!.profile_key, 'binh');
  assert.equal(logs[4]!.before.clock.localDate, '2026-11-02');
  assert.equal(logs[6]!.before.entities.length, 0);
  assert.doesNotMatch(logs[6]!.response!.reply.text, /Mochi/u);
  assert.ok((await readdir(result.outputDir)).includes('report.md'));
  assert.equal(JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8')).status, 'complete');
  await assert.rejects(() => runEvaluation({ scenarios: [second], history: 'none', outputDir: result.outputDir, runKind: 'harness_self_test', providerInstance: new FakeProvider() }), /EEXIST/u);
});

test('character and memory evaluation rejects fake or merely relabeled providers before making requests', async () => {
  await assert.rejects(() => runEvaluation({ scenarios: [scenarios[0]!], provider: 'fake', outputDir: '/unused' }), /requires a real provider/u);
  await assert.rejects(() => runEvaluation({ scenarios: [scenarios[0]!], providerInstance: new FakeProvider(), outputDir: '/unused' }), /requires an OpenAIProvider/u);
  const relabeled = new FakeProvider();
  Object.defineProperty(relabeled, 'mode', { value: 'real' });
  await assert.rejects(() => runEvaluation({ scenarios: [scenarios[0]!], providerInstance: relabeled, outputDir: '/unused' }), /requires an OpenAIProvider/u);
});

test('offline harness records a legacy repair precondition without counting authored state as learning evidence', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-legacy-harness-'));
  const selected = scenarios.find(scenario => scenario.id === 'SC-102')!;
  const result = await runEvaluation({ scenarios: [selected], history: 'none', outputDir: join(parent, 'run'), runKind: 'harness_self_test', providerInstance: new FakeProvider() });
  const logs = (await readFile(join(result.outputDir, 'turns.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as TurnLog);
  assert.equal(logs[0]!.before.events[0]!.value, 'Mochi got a bath today');
  assert.equal(logs[0]!.before.events[0]!.source, undefined);
  assert.equal(logs[2]!.after.events.length, 0);
  assert.equal(logs[2]!.after.entities[0]!.name, 'Mochi');
  const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.fixture_preconditions[0].provenance, 'synthetic_legacy_fixture_not_learning_evidence');
  assert.equal(manifest.character_memory_quality_evidence, false);
});

test('harness preserves a blocking provider failure and leaves subsequent turns unattempted', async () => {
  class FailingTransportDouble extends FakeProvider {
    calls = 0;
    override async classify(): Promise<never> { this.calls++; throw new AppError('provider_quota_exceeded', 429); }
  }
  const parent = await mkdtemp(join(tmpdir(), 'miu-blocked-harness-'));
  const provider = new FailingTransportDouble();
  const result = await runEvaluation({ scenarios: [scenarios[0]!], history: 'none', outputDir: join(parent, 'run'), runKind: 'harness_self_test', providerInstance: provider });
  assert.equal(provider.calls, 1);
  assert.equal(result.logCount, 1);
  assert.equal(result.blocked?.code, 'provider_quota_exceeded');
  const manifest = JSON.parse(await readFile(join(result.outputDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.character_memory_quality_evidence, false);
  const record = JSON.parse((await readFile(join(result.outputDir, 'turns.jsonl'), 'utf8')).trim());
  assert.equal(record.response, null);
  assert.equal(record.error.code, 'provider_quota_exceeded');
  assert.equal(result.report.validity.character_memory_quality_evidence, false);
});
