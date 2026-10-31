import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCENARIO_CATALOG_COUNT, SCENARIO_CATALOG_VERSION, scenarios, validateScenarios } from './catalog.js';
import { REQUIREMENTS } from './evaluate.js';
import { addDays, atLocalHour, localDate } from '../memory/clock.js';

const additions = scenarios.filter(scenario => Number(scenario.id.slice(3)) >= 104);

// Offline fixture checks only: these tests make no provider requests and do not
// establish character quality, successful learning, or memory performance.
test('the extension adds exactly 100 new cases while preserving all previous scenario IDs', () => {
  validateScenarios(scenarios);
  assert.equal(SCENARIO_CATALOG_COUNT, 203);
  assert.equal(additions.length, 100);
  assert.deepEqual(additions.map(scenario => scenario.id), Array.from({ length: 100 }, (_, index) => `SC-${104 + index}`));
  assert.deepEqual(scenarios.map(scenario => scenario.id).sort(), Array.from({ length: 203 }, (_, index) => `SC-${String(index + 1).padStart(3, '0')}`));
});

test('new cases have distinct multi-session inputs and substantive requirement-mapped acceptance criteria', () => {
  const knownRequirements = new Set(REQUIREMENTS.map(requirement => requirement.id));
  const transcripts = new Set<string>();
  const titles = new Set<string>();
  for (const scenario of scenarios) {
    const title = scenario.title.normalize('NFC').toLocaleLowerCase('en').trim();
    assert.ok(!titles.has(title), `Repeated title in ${scenario.id}`);
    titles.add(title);
    const transcript = JSON.stringify(scenario.conversations.map(conversation => conversation.turns.map(turn => turn.text?.normalize('NFC').trim())));
    assert.ok(!transcripts.has(transcript), `Repeated input sequence in ${scenario.id}`);
    transcripts.add(transcript);
  }
  for (const scenario of additions) {
    assert.ok(scenario.conversations.length >= 2, scenario.id);
    for (const conversation of scenario.conversations) {
      assert.ok(conversation.turns.length >= 2, `${scenario.id}/${conversation.id}`);
      for (const turn of conversation.turns) {
        const label = `${scenario.id}/${conversation.id}/${turn.id}`;
        assert.ok(turn.text?.trim(), `Missing child input in ${label}`);
        assert.ok(turn.assertions.some(assertion => assertion.requirement !== 'VOICE-02'), `Only length checks in ${label}`);
        for (const assertion of turn.assertions) {
          assert.ok(knownRequirements.has(assertion.requirement), `Unknown requirement in ${label}: ${assertion.requirement}`);
          assert.ok(scenario.requirements.includes(assertion.requirement), `Unmapped requirement in ${label}`);
          assert.ok(/^(response|before|after|delivery|error|retry|transition)\./u.test(assertion.target) || assertion.target === 'retry', `Unsupported evidence root in ${label}: ${assertion.target}`);
        }
      }
    }
  }
});

test('new cases cover diverse subjects, languages, age bands, delivery outcomes and session transitions', () => {
  const conversations = additions.flatMap(scenario => scenario.conversations);
  const turns = conversations.flatMap(conversation => conversation.turns);
  assert.ok(new Set(additions.map(scenario => scenario.category)).size >= 9);
  assert.ok(turns.some(turn => /[ăâđêôơư]/iu.test(turn.text ?? '')), 'Vietnamese inputs are present');
  assert.ok(turns.some(turn => /\b(?:my|what|please|pretend)\b/iu.test(turn.text ?? '')), 'English inputs are present');
  assert.ok(additions.some(scenario => scenario.age_band === '4-5'));
  assert.ok(turns.some(turn => turn.delivery === 'canceled'));
  assert.ok(turns.some(turn => turn.delivery === 'interrupted'));
  assert.ok(turns.some(turn => turn.retry === 'turn'));
  assert.ok(turns.some(turn => turn.retry === 'receipt'));
  assert.ok(conversations.some(conversation => conversation.transition === 'reload'));
  assert.ok(conversations.some(conversation => conversation.transition === 'next_day_retry'));
  assert.ok(conversations.some(conversation => conversation.profile === 'binh'));
});

test('new conversation schedules allow every minute-spaced turn without reversing privacy time', () => {
  for (const scenario of additions) {
    let previousWall = -Infinity;
    const narrativeOffsets = new Map<string, number>();
    for (const conversation of scenario.conversations) {
      let offset = narrativeOffsets.get(conversation.profile) ?? 0;
      if (conversation.transition === 'next_day' || conversation.transition === 'next_day_retry') {
        const beforeDate = localDate(new Date(previousWall + offset), 'Asia/Ho_Chi_Minh');
        offset = atLocalHour(addDays(beforeDate, 1), 'Asia/Ho_Chi_Minh').getTime() - previousWall;
        narrativeOffsets.set(conversation.profile, offset);
      }
      const startWall = Date.parse(conversation.at) - offset;
      assert.ok(startWall >= previousWall, `Overlapping or backward fixture clock in ${scenario.id}/${conversation.id}`);
      previousWall = startWall + (conversation.turns.length - 1) * 60_000;
    }
  }
});

test('specific answer checks accept valid equivalent loss and telescope wording', () => {
  const answerPattern = (scenarioId: string, turnId: string) => {
    const turn = scenarios.find(scenario => scenario.id === scenarioId)!.conversations.flatMap(conversation => conversation.turns).find(turn => turn.id === turnId)!;
    const assertion = turn.assertions.find(assertion => assertion.op === 'matches' && assertion.target === 'response.reply.text')!;
    return new RegExp(assertion.value as string, 'iu');
  };
  const loss = answerPattern('SC-145', 'opponent-forced');
  assert.match('I take the last token, so I’m the loser this time.', loss);
  assert.match("I am the loser because I must take the last token.", loss);
  assert.doesNotMatch('I win by taking the last token.', loss);
  const observer = answerPattern('SC-159', 'observer-clarifies');
  assert.match('Through a telescope, I saw the pretend pirate.', observer);
  assert.match('I used a telescope to see the pretend pirate.', observer);
});

test('the versioned export matches the authored catalog and explicitly contains no execution results', async () => {
  const exported = JSON.parse(await readFile(new URL('./scenarios/catalog.v3.json', import.meta.url), 'utf8'));
  assert.equal(exported.version, SCENARIO_CATALOG_VERSION);
  assert.equal(exported.synthetic, true);
  assert.equal(exported.execution_status, 'not_run');
  assert.equal(exported.character_memory_quality_evidence, false);
  assert.deepEqual(exported.scenarios, scenarios);
  assert.deepEqual(exported.totals, {
    scenarios: scenarios.length,
    conversations: scenarios.reduce((total, scenario) => total + scenario.conversations.length, 0),
    turns: scenarios.reduce((total, scenario) => total + scenario.conversations.reduce((count, conversation) => count + conversation.turns.length, 0), 0),
  });
});
