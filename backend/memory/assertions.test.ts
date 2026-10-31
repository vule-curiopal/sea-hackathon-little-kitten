import test from 'node:test';
import assert from 'node:assert/strict';
import { assertionEvidence } from './assertions.js';
import type { MemoryCandidate } from '../shared/types.js';

// Offline source-validation contracts only, not character or memory quality evidence.
const bath: MemoryCandidate = { kind: 'event', subjectName: 'Mochi', eventType: 'reported_event', value: 'Mochi got a bath today', evidence: 'Mochi got a bath today' };
test('a copied proposition requires affirmative surrounding source, including omitted prefixes', () => {
  for (const text of [
    'Did I tell you Mochi got a bath today?',
    'Did I tell you Mochi got a bath today',
    'Maybe Mochi got a bath today.',
    'If Mochi got a bath today, we can play later.',
    'I did not say Mochi got a bath today.',
    'I never said Mochi got a bath today.',
    'I asked whether Mochi got a bath today.',
    'In my pretend story, Mochi got a bath today.',
    'Mum asked, "Mochi got a bath today?"',
    'Mochi got a bath today and my password is 123456.',
  ]) assert.equal(assertionEvidence(text, bath), null, text);
  assert.deepEqual(assertionEvidence('Mochi got a bath today.', bath), {
    clause: 'Mochi got a bath today.', start: 0, end: bath.evidence.length, speechAct: 'assertion', polarity: 'affirmed',
  });
});
test('mixed utterances retain only asserted clauses, even when a question repeats their text', () => {
  const text = 'Did I tell you Mochi got a bath today? Mochi got a bath today.';
  const evidence = assertionEvidence(text, bath)!;
  assert.equal(evidence.start, text.lastIndexOf(bath.evidence));
  assert.equal(text.slice(evidence.start, evidence.end), bath.evidence);
  const like: MemoryCandidate = { kind: 'preference', category: 'like', value: 'rolling a ball', evidence: 'I like rolling a ball' };
  const mixed = 'I like rolling a ball. Did I tell you Mochi got a bath today?';
  assert.ok(assertionEvidence(mixed, like));
  assert.equal(assertionEvidence(mixed, bath), null);
  const statementThenQuestion = 'Mochi got a bath today. Did I tell you that?';
  assert.ok(assertionEvidence(statementThenQuestion, { ...bath, evidence: 'Mochi got a bath today.' }));
});
test('Vietnamese negations, questions and hypothetical outcomes cannot become reports', () => {
  const event: MemoryCandidate = { kind: 'event', subjectName: 'Mochi', eventType: 'reported_event', value: 'Mochi được tắm hôm nay', evidence: 'Mochi được tắm hôm nay' };
  for (const text of ['Mình đã kể Mochi được tắm hôm nay chưa?', 'Mình chưa nói Mochi được tắm hôm nay.', 'Có lẽ Mochi được tắm hôm nay.']) {
    assert.equal(assertionEvidence(text, event), null, text);
  }
  assert.ok(assertionEvidence('Mochi được tắm hôm nay.', event));
  assert.equal(assertionEvidence('Mochi không được tắm hôm nay.', { ...event, evidence: 'Mochi không được tắm hôm nay' }), null);
});
