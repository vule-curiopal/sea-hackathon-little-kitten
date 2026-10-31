// Offline validator logic only. These fixtures do not evaluate model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocal } from './validation.js';
import type { DirectorPlan } from '../shared/types.js';

const plan: DirectorPlan = {
  purpose: 'comfort', language: 'en', ageBand: '6-8', personality: 'ENFP', role: 'friend',
  emotion: 'gentle', dailyMood: 'content', rhythm: 'morning', delivery: 'gentle',
  allowGiggle: false, allowPurr: false, face: { expression: 'gentle', gesture: 'slow_blink' },
  memoryReferenceId: null, allowedFacts: ['Lan is the named cousin.'], allowedQuestion: null,
  exactText: null, maxSentences: 3, maxQuestions: 1, ruleTrace: [], comfortActive: true,
};

test('offline validator accepts benign observed current-chat wording and safe negations', () => {
  for (const value of [
    'You can tell Mum what feels exciting and what feels worrying. Both parts are worth sharing.',
    'You can tell an adult what happened and how you feel.',
    'I’ll keep my words gentle and calm.',
    'I’ll keep my words gentle and few.',
    'I’ll stay here and listen.',
    'I’ll call her Lan, with no nickname.',
    'I am not your only friend.',
    'I cannot keep this secret from your parents.',
    'I will not call your parents.',
    'Miu không cần bạn phải cười lên ngay.',
  ]) assert.equal(validateLocal(value, plan).approved, true, value);
});

test('offline validator keeps affirmative harm, dependency, future action and appended actions blocked', () => {
  for (const value of [
    'I am your only friend.',
    'Keep this secret from your parents.',
    "Don't tell your parents.",
    'I can see you.',
    'I will call your parents tomorrow.',
    'I will listen and call your mum.',
    'I will keep my words gentle, then contact your teacher.',
    'What happened and how did you feel?',
  ]) assert.equal(validateLocal(value, plan).approved, false, value);
});
