import assert from 'node:assert/strict';
import test from 'node:test';
import { selectJudgePriorContext } from './judge-context.js';
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
