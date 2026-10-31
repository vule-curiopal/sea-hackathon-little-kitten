import { coreScenarios } from './scenarios/core.js';
import { advancedScenarios } from './scenarios/advanced.js';
import { memoryRegressionScenarios } from './scenarios/memory-regressions.js';
import { isSafeProjection } from '../memory/evidence.js';
import type { Scenario } from './types.js';

export const SCENARIO_CATALOG_VERSION = 'miu-product-scenarios-v1';
export const scenarios: Scenario[] = [...coreScenarios, ...advancedScenarios, ...memoryRegressionScenarios];
const assertionOps = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'contains_one_of', 'matches', 'not_matches', 'one_of', 'exists', 'gte', 'lte', 'equals_before']);

export function validateScenarios(items: Scenario[], expectedCount = 103): void {
  if (items.length !== expectedCount) throw new Error(`Expected ${expectedCount} scenarios; found ${items.length}`);
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const scenario of items) {
    const fixture = scenario.initial_memory;
    if (fixture && (fixture.provenance !== 'synthetic_legacy_fixture_not_learning_evidence' || !['an', 'binh'].includes(fixture.profile) || !['dog', 'cat', 'rabbit'].includes(fixture.pet.species) || !/^[\p{L}\p{M} '\-]{1,60}$/u.test(fixture.pet.name) || !isSafeProjection(fixture.event.value) || !/^\d{4}-\d{2}-\d{2}$/u.test(fixture.event.local_date))) throw new Error(`Invalid synthetic memory precondition in ${scenario.id}`);
    if (!/^SC-\d{3}$/u.test(scenario.id) || ids.has(scenario.id)) throw new Error(`Invalid/duplicate scenario ID: ${scenario.id}`);
    ids.add(scenario.id);
    if (!scenario.title.trim() || titles.has(scenario.title)) throw new Error(`Empty/duplicate scenario title: ${scenario.id}`);
    titles.add(scenario.title);
    if (!scenario.requirements.length || scenario.requirements.some(id => !/^[A-Z]+-\d{2}$/u.test(id))) throw new Error(`Missing/invalid requirement mapping: ${scenario.id}`);
    if (scenario.conversations.length < 2) throw new Error(`Scenario ${scenario.id} needs at least two conversations`);
    let previous = -Infinity;
    const conversationIds = new Set<string>();
    for (const date of scenario.history_dates) {
      const at = Date.parse(`${date}T00:00:00+07:00`);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(at) || at <= previous) throw new Error(`Unordered historical seed in ${scenario.id}`);
      previous = at;
    }
    for (const conversation of scenario.conversations) {
      const at = Date.parse(conversation.at);
      if (!Number.isFinite(at) || at <= previous) throw new Error(`Non-monotonic conversation date in ${scenario.id}/${conversation.id}`);
      previous = at;
      if (!conversation.id || conversationIds.has(conversation.id)) throw new Error(`Duplicate conversation ID in ${scenario.id}`);
      conversationIds.add(conversation.id);
      if (!['an', 'binh'].includes(conversation.profile)) throw new Error(`Invalid fictional profile in ${scenario.id}`);
      if (conversation.turns.length < 2) throw new Error(`Conversation ${scenario.id}/${conversation.id} needs multiple exchanges`);
      const turnIds = new Set<string>();
      for (const turn of conversation.turns) {
        if (!turn.id || turnIds.has(turn.id)) throw new Error(`Duplicate turn ID in ${scenario.id}/${conversation.id}`);
        turnIds.add(turn.id);
        const expectsMissingInput = turn.assertions.some(assertion => assertion.target === 'error.code' && assertion.op === 'equals' && assertion.value === 'missing_text');
        if (turn.kind !== 'greeting' && !turn.text?.trim() && !expectsMissingInput) throw new Error(`Missing input in ${scenario.id}/${turn.id}`);
        if (!turn.assertions.length || !turn.rubric.length || turn.rubric.some(criterion => !criterion.trim())) throw new Error(`Missing acceptance criteria in ${scenario.id}/${turn.id}`);
        for (const assertion of turn.assertions) {
          if (!assertionOps.has(assertion.op) || !assertion.description.trim() || !assertion.requirement) throw new Error(`Invalid assertion in ${scenario.id}/${turn.id}`);
          if (!assertion.target || assertion.target.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error(`Unsafe assertion path in ${scenario.id}/${turn.id}`);
          if (assertion.op === 'matches' || assertion.op === 'not_matches') {
            if (typeof assertion.value !== 'string') throw new Error(`Regex must be a string in ${scenario.id}/${turn.id}`);
            new RegExp(assertion.value, 'iu');
          }
        }
      }
    }
  }
}
