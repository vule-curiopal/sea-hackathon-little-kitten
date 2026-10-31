import assert from 'node:assert/strict';
import test from 'node:test';
import { groupJudgeConversations, selectJudgePriorContext, selectJudgeOperationalContext } from './judge-context.js';
import type { TurnLog } from './types.js';

// Context selection uses only identity/order metadata; no engine or model output is simulated.
const entry = (id: string, profile: 'an' | 'binh', overrides: Partial<TurnLog> = {}): TurnLog => ({
  run_id: 'run-1', scenario_id: 'SC-001', conversation_id: `conversation-${id}`,
  turn_spec_id: id, profile_key: profile, phase: 'scenario', ...overrides,
} as TurnLog);

test('judge context excludes other profiles, scenarios, runs, and all later turns', () => {
  const seed = entry('seed', 'binh', { phase: 'scenario_history' });
  const otherProfile = entry('an-secret', 'an');
  const otherScenario = entry('other-case', 'binh', { scenario_id: 'SC-002' });
  const otherRun = entry('other-run', 'binh', { run_id: 'run-2' });
  const prior = entry('eligible-prior', 'binh');
  const current = entry('current', 'binh');
  const later = entry('future', 'binh');
  const logs = [seed, otherProfile, otherScenario, otherRun, prior, current, later];
  assert.deepEqual(selectJudgePriorContext(logs, [current]), [seed, prior]);
});

test('judge context never follows a profile switch into the other fictional child', () => {
  const an = entry('an-first', 'an');
  const binh = entry('binh-first', 'binh');
  const anReturns = entry('an-returns', 'an');
  assert.deepEqual(selectJudgePriorContext([an, binh, anReturns], [binh]), []);
  assert.deepEqual(selectJudgePriorContext([an, binh, anReturns], [anReturns]), [an]);
});

test('mixed-profile conversation input and an unknown log position fail closed', () => {
  const an = entry('an', 'an', { conversation_id: 'same-conversation' });
  const binh = entry('binh', 'binh', { conversation_id: 'same-conversation' });
  assert.throws(() => selectJudgePriorContext([an, binh], [an, binh]), /one fictional profile/u);
  assert.throws(() => selectJudgePriorContext([an], [entry('missing', 'an')]), /not present/u);
  assert.deepEqual(selectJudgePriorContext([an], []), []);
});

test('seed grouping is opt-in and phase is part of the group key', () => {
  const seedA = entry('seed-a', 'an', { phase: 'scenario_history', conversation_id: 'shared-id' });
  const seedB = entry('seed-b', 'an', { phase: 'scenario_history', conversation_id: 'shared-id' });
  const regular = entry('regular', 'an', { conversation_id: 'shared-id' });
  const fullHistory = entry('year-history', 'an', { phase: 'history', scenario_id: null });
  const logs = [fullHistory, seedA, seedB, regular];
  const defaults = groupJudgeConversations(logs);
  assert.equal(defaults.size, 1);
  assert.deepEqual([...defaults.values()], [[regular]]);
  const withSeeds = groupJudgeConversations(logs, true);
  assert.equal(withSeeds.size, 2);
  assert.deepEqual([...withSeeds.values()], [[seedA, seedB], [regular]]);
  assert.ok([...withSeeds.keys()].some(key => key.includes('/scenario_history/')));
  assert.ok([...withSeeds.keys()].some(key => key.includes('/scenario/')));
});

test('prior-context selection rejects mixing seed and test turns into one conversation', () => {
  const seed = entry('seed', 'an', { phase: 'scenario_history', conversation_id: 'shared-id' });
  const regular = entry('regular', 'an', { conversation_id: 'shared-id' });
  assert.throws(() => selectJudgePriorContext([seed, regular], [seed, regular]), /one conversation/u);
});

test('offline operational context includes prior profile switches but excludes other cases and future conversations', () => {
  const an = entry('an-first', 'an');
  const binh = entry('binh-first', 'binh');
  const current = entry('current', 'an', { conversation_id: 'current-conversation' });
  const laterSameConversation = entry('next', 'an', { conversation_id: 'current-conversation' });
  const future = entry('future', 'an');
  const otherCase = entry('other', 'an', { scenario_id: 'SC-002' });
  const logs = [an, binh, otherCase, current, laterSameConversation, future];
  assert.deepEqual(selectJudgePriorContext(logs, [current, laterSameConversation]), [an]);
  assert.deepEqual(selectJudgeOperationalContext(logs, [current, laterSameConversation]), [an, binh, current, laterSameConversation]);
  assert.deepEqual(selectJudgeOperationalContext(logs, []), []);
});
