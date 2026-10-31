import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarios, validateScenarios } from './catalog.js';
import { loadHistoricalSessions, runEvaluation } from './runner.js';
import { FakeProvider } from '../pipeline/providers.js';
import { AppError } from '../shared/types.js';
import { MiuApplication, type TurnRequest } from '../application.js';
import { randomUUID } from 'node:crypto';
import type { Scenario, TurnLog } from './types.js';

const turn = (id: string, text: string) => ({
  id, text,
  assertions: [{ requirement: 'VOICE-02', description: 'Approved speech exists', target: 'response.reply.text', op: 'exists' as const }],
  rubric: ['Answer the current child utterance without inventing physical access.'],
});

test('catalog has 203 distinct multi-conversation scenarios including memory regressions', () => {
  validateScenarios(scenarios);
  assert.equal(scenarios.length, 203);
  assert.equal(new Set(scenarios.map(item => item.id)).size, 203);
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
  assert.ok(logs[2]!.response!.presentation.allowedFacts.some(fact => fact.includes('Mochi')));
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

// These integration checks exercise request journaling and lifecycle evidence
// with an explicitly injected offline double. They are not model-quality runs.
async function operationalHarness(selected: Scenario[], prefix: string) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const result = await runEvaluation({ scenarios: selected, history: 'none', outputDir: join(parent, 'run'), runKind: 'harness_self_test', providerInstance: new FakeProvider() });
  const logs = (await readFile(join(result.outputDir, 'turns.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as TurnLog);
  assert.equal(result.report.validity.character_memory_quality_evidence, false);
  return { result, logs };
}

test('offline SC095 harness records original and retry identities without duplicate provider work or learning', async () => {
  const { logs } = await operationalHarness([scenarios.find(item => item.id === 'SC-095')!], 'miu-retry-evidence-');
  const request = logs.find(log => log.turn_spec_id === 'pet-request-retry')!;
  assert.equal(request.error, null);
  assert.equal(request.operational!.request.request_id, request.response!.turn_id);
  assert.deepEqual(request.operational!.original_response, request.operational!.retry_response);
  assert.equal((request.retry as { turn_id: string }).turn_id, request.operational!.original_response!.turn_id);
  assert.equal(request.provider_events.filter(event => event.stage === 'classify').length, 1);
  assert.equal(request.provider_events.filter(event => event.stage === 'reply').length, 1);
  assert.equal(request.after.entities.filter(entity => entity.name === 'Mochi').length, 1);
  const receipt = logs.find(log => log.turn_spec_id === 'preference-receipt-retry')!;
  assert.ok(receipt.operational!.receipt!.request_id);
  assert.deepEqual(receipt.operational!.receipt!.result, receipt.retry);
  assert.equal(receipt.after.preferences.filter(preference => preference.value === 'folding paper boats').length, 1);
});

test('offline SC098 harness proves zero-call invalid input and recovery in the same actual session', async () => {
  const { logs } = await operationalHarness([scenarios.find(item => item.id === 'SC-098')!], 'miu-invalid-evidence-');
  for (const [invalidId, validId, code] of [['too-long', 'valid-after-long', 'text_too_long'], ['empty', 'valid-question', 'missing_text']]) {
    const invalid = logs.find(log => log.turn_spec_id === invalidId)!;
    const valid = logs.find(log => log.turn_spec_id === validId)!;
    assert.equal(invalid.error!.code, code);
    assert.deepEqual(invalid.api_calls, []);
    assert.deepEqual(invalid.provider_events, []);
    assert.equal(invalid.operational!.original_response, null);
    assert.deepEqual(invalid.before, invalid.after);
    assert.equal(valid.error, null);
    assert.ok(valid.response);
    assert.equal(invalid.operational!.request.session_id, valid.operational!.request.session_id);
    assert.equal(valid.response!.session_id, invalid.operational!.request.session_id);
  }
});

test('offline SC100 harness measures interrupted confirmation, same-session Yes and a rejected stale replay', async () => {
  const { logs } = await operationalHarness([scenarios.find(item => item.id === 'SC-100')!], 'miu-deletion-evidence-');
  const interrupted = logs.find(log => log.turn_spec_id === 'unheard-confirmation')!;
  const yes = logs.find(log => log.turn_spec_id === 'same-session-yes')!;
  assert.equal(interrupted.delivery!.status, 'interrupted');
  assert.equal(interrupted.operational!.session_after!.pending_forget_all, false);
  assert.equal(yes.operational!.session_before!.pending_forget_all, false);
  assert.equal(yes.operational!.request.session_id, interrupted.operational!.request.session_id);
  assert.equal(yes.after.profile.deletionEpoch, yes.before.profile.deletionEpoch);
  assert.ok(yes.after.entities.some(entity => entity.name === 'Mochi'));
  const source = logs.find(log => log.turn_spec_id === 'replay-seed')!;
  const confirm = logs.find(log => log.turn_spec_id === 'confirm')!;
  assert.equal(confirm.operational!.session_before!.pending_forget_all, true);
  assert.equal(confirm.after.entities.length, 0);
  assert.equal(confirm.after.profile.deletionEpoch, confirm.before.profile.deletionEpoch + 1);
  const probe = confirm.operational!.stale_replay!;
  assert.equal(probe.request_id, source.operational!.request.request_id);
  assert.equal(probe.session_id, source.operational!.request.session_id);
  assert.equal(probe.error_code, 'stale_state');
  assert.equal(probe.response, null);
  assert.equal(probe.api_call_count, 0);
  assert.deepEqual(probe.provider_events, []);
  assert.equal(confirm.operational!.session_after!.pending_forget_all, false);
  assert.deepEqual(confirm.operational!.session_after!.last_learned_ids, []);
  assert.equal(confirm.operational!.session_after!.last_reference_id, null);
  assert.ok(!confirm.operational!.session_after!.replay_request_ids.includes(probe.request_id));
  assert.ok(confirm.operational!.session_after!.retired_request_ids.includes(probe.request_id));
  assert.equal(confirm.operational!.original_response!.turn_id, confirm.response!.turn_id);
});

test('offline harness snapshots retain session-only address permission only inside its actual session', async () => {
  const selected: Scenario = {
    id: 'SC-903', title: 'Harness session-scoped diagnostics', category: 'harness', requirements: ['REL-01'], history_dates: [],
    conversations: [
      { id: 'permitted-session', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [turn('permission', 'Call me Captain Pebble for this session.'), turn('same-session', 'Hello.')] },
      { id: 'new-session', profile: 'an', at: '2026-11-01T10:00:00+07:00', turns: [turn('outside-permission', 'Hello.'), turn('leave', 'Goodbye.')] },
    ],
  };
  const { logs } = await operationalHarness([selected], 'miu-session-evidence-');
  assert.equal(logs[0]!.after.addressPreference!.preferredAddress, 'Captain Pebble');
  assert.equal(logs[0]!.after.addressPreference!.scope, 'session');
  assert.equal(logs[1]!.before.addressPreference!.preferredAddress, 'Captain Pebble');
  assert.notEqual(logs[2]!.before.addressPreference?.preferredAddress, 'Captain Pebble');
});

test('offline negative control exposes and cancels unexpected probe generation without replacing main evidence', async () => {
  // Inject a broken request-cache boundary for this harness-only test. The
  // actual application must still cancel the new unplayed turn and not learn it.
  const prepare = MiuApplication.prototype.prepareTurn;
  const seen = new Set<string>();
  MiuApplication.prototype.prepareTurn = function(profileId: string, sessionId: string, request: TurnRequest) {
    if (seen.has(request.request_id) && request.text === 'My dog is named Mochi.') {
      return prepare.call(this, profileId, sessionId, { ...request, request_id: randomUUID() });
    }
    seen.add(request.request_id);
    return prepare.call(this, profileId, sessionId, request);
  };
  try {
    const { result, logs } = await operationalHarness([scenarios.find(item => item.id === 'SC-100')!], 'miu-bad-probe-evidence-');
    const confirm = logs.find(log => log.turn_spec_id === 'confirm')!;
    const probe = confirm.operational!.stale_replay!;
    assert.equal(confirm.error, null);
    assert.equal(probe.error_code, null);
    assert.ok(probe.response);
    assert.notEqual(probe.response!.turn_id, confirm.response!.turn_id);
    assert.ok(probe.provider_events!.some(event => event.stage === 'classify'));
    for (const event of confirm.provider_events.filter(event => event.stage === 'reply')) {
      assert.equal((event.details as { text: string }).text, confirm.response!.reply.text, 'Probe reply events must not replace the published main reply evidence');
    }
    assert.equal(confirm.operational!.original_response!.turn_id, confirm.response!.turn_id);
    assert.equal(confirm.after.entities.length, 0);
    assert.equal(logs.find(log => log.turn_spec_id === 'deleted-recall')!.error, null, 'The unexpected probe turn was canceled so the session stays usable');
    const scored = result.report.turns.find(log => log.turn_spec_id === 'confirm')!;
    assert.ok(scored.checks.some(check => check.status === 'fail' && check.description === 'Stale replay produces no old response'));
  } finally {
    MiuApplication.prototype.prepareTurn = prepare;
  }
});
