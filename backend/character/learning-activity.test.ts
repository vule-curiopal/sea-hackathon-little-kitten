import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLearningActivity, selectLearningActivity } from './learning-activity.js';
import type { LearningActivity } from '../shared/types.js';

test('current word-reading requests save only the literal topic and focus', () => {
  for (const [source, expected, language] of [
    ['I cannot read butterfly. Too many letters.', 'butterfly', 'en'],
    ['Help me read the word “Sunflower”.', 'Sunflower', 'en'],
    ['Please sound out this word fire-fly.', 'fire-fly', 'en'],
    ['Mình chưa đọc được từ nghiêng.', 'nghiêng', 'vi'],
    ['Giúp mình đánh vần từ “nghiêng” nhé.', 'nghiêng', 'vi'],
  ] as const) {
    assert.deepEqual(extractLearningActivity(source, language), { kind: 'word_practice', term: expected, focus: 'reading', language });
  }
  const literal = 'nghiêng';
  assert.equal(extractLearningActivity(`Giúp mình đọc từ ${literal}.`, 'vi')?.term, literal);
});

test('questions, quoted reports, past events and hypothetical activities cannot introduce checkpoints', () => {
  for (const source of [
    'Did I say I cannot read butterfly?',
    'Mum said I cannot read butterfly.',
    '“I cannot read butterfly.”',
    'In my story I cannot read butterfly.',
    'If I cannot read butterfly, can I ask?',
    'Yesterday I cannot read butterfly.',
    'Tomorrow help me read butterfly.',
    'I do not want to read the word butterfly.',
    'I cannot read books.',
    'I cannot read my book.',
    'My friend cannot read butterfly.',
    'Mẹ bảo mình không đọc được từ butterfly.',
    'Hôm qua mình chưa đọc được butterfly.',
    'I like butterfly pictures.',
    'What does butterfly mean?',
  ]) assert.equal(extractLearningActivity(source, 'en'), null, source);
});

test('topical selection uses exact word boundaries and respects explicit new sense', () => {
  const checkpoint: LearningActivity = { id: 'lesson', kind: 'word_practice', term: 'butterfly', focus: 'reading', language: 'en', localDate: '2026-11-01', expiresAt: '2026-12-01T00:00:00Z', sourceTurnId: 'source' };
  const context = { learningActivities: [checkpoint] };
  assert.equal(selectLearningActivity(context, 'Butterfly nghĩa là gì?')?.id, 'lesson');
  assert.equal(selectLearningActivity(context, 'What does fly mean?'), null);
  assert.equal(selectLearningActivity(context, 'What is butterflyfish?'), null);
  assert.equal(selectLearningActivity(context, 'Butterfly trong môn bơi nghĩa là gì?'), null);
  assert.equal(selectLearningActivity(context, 'What does butterfly mean in swimming?'), null);
  assert.equal(selectLearningActivity({}, 'Butterfly nghĩa là gì?'), null);
});
