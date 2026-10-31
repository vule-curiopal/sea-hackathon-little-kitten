// Offline pure-language and routing contracts only; no provider/model quality claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { socialFormulaLanguage } from './language.js';
import { classifyLocal, validateObservation } from './observations.js';
import { decide } from '../character/director.js';
import type { MemoryContext, ProviderClassificationContext } from '../shared/types.js';

const known: ProviderClassificationContext = {
  entities: [{ id: 'binh', kind: 'person', name: 'Bình', aliases: ['Ben'] }, { id: 'rumi', kind: 'pet', name: 'Rumi', aliases: [] }],
  recent: [],
};

test('offline complete English social formulas override a Vietnamese prior language', () => {
  for (const text of ['Bye, AI kitten.', 'Bye!', 'Goodbye Miu.', 'Good night, my friend.', 'Goodnight.', 'See you.', 'See you later, Bình!', 'Miu, goodbye.', 'Hello, Ben.']) {
    assert.equal(socialFormulaLanguage(text, known.entities), 'en', text);
    assert.equal(classifyLocal(text, 'vi', known).language, 'en', text);
    const proposed = { ...classifyLocal('Chào Miu.', 'vi'), intent: 'greeting' as const, language: 'vi' as const };
    assert.equal(validateObservation(text, proposed, known).language, 'en', text);
  }
});

test('offline complete Vietnamese formulas override an English prior language with neutral proper names', () => {
  for (const text of ['Tạm biệt.', 'Tạm biệt Miu!', 'Xin chào, Rumi.', 'Chào Bình.', 'Miu ơi, tạm biệt nhé.', 'Xin chào Miu nha.']) {
    assert.equal(socialFormulaLanguage(text, known.entities), 'vi', text);
    assert.equal(classifyLocal(text, 'en', known).language, 'vi', text);
    const proposed = { ...classifyLocal('Hello.', 'en'), language: 'en' as const };
    assert.equal(validateObservation(text, proposed, known).language, 'vi', text);
  }
  assert.equal(socialFormulaLanguage('Bye, Bình.', known.entities), 'en', 'NFC spelling preserves name neutrality.');
});

test('offline names, quotations, reported formulas and mixed/other statements do not choose language', () => {
  for (const text of [
    'Miu', 'Bình', 'Ben.', 'AI kitten', 'Moon', 'abc',
    '"Bye, AI kitten."', '“Tạm biệt Miu.”', "'Bye.'", 'Bye, “Miu”.',
    'Mum said goodbye.', 'Bạn ấy nói tạm biệt.', 'What does goodbye mean?',
    'Bye, AI kitten. I am tired.', 'Goodbye but stay here.', 'Chào. Bye.', 'Bye, tạm biệt.',
    'Chào, my friend.', 'Bye, bạn nhé.', 'See you ở trường.', 'I want to talk about goodbye.',
    'Bye, Unknown Name.',
  ]) assert.equal(socialFormulaLanguage(text, known.entities), null, text);
  assert.equal(validateObservation('"Bye, AI kitten."', { ...classifyLocal('Chào.', 'vi'), language: 'vi' }, known).language, 'vi');
  assert.equal(validateObservation('Bye, tạm biệt.', { ...classifyLocal('Hello.', 'en'), language: 'vi' }, known).language, 'vi', 'Mixed utterances retain the accepted model language.');
  assert.equal(socialFormulaLanguage('Bye.', [{ name: 'Bye', aliases: [] }]), null, 'A bare known proper name remains ambiguous.');
});

test('offline explicit requested language retains precedence over a social formula', () => {
  const text = 'Please reply in Vietnamese. Bye, AI kitten.';
  assert.equal(classifyLocal(text, 'en', known).language, 'vi');
  assert.equal(validateObservation(text, { ...classifyLocal('Hello.', 'en'), language: 'en' }, known).language, 'vi');
});

test('offline fixed profile language still overrides social-formula observation language', () => {
  const context: MemoryContext = {
    profile: { id: 'an', demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'vi', timezone: 'Asia/Ho_Chi_Minh', stateVersion: 1, deletionEpoch: 0 },
    config: { personality: 'ENFP', role: 'friend', voiceId: 'miu-default', canonVersion: 'miu-v1' },
    clock: { mode: 'demo', effectiveNow: '2026-11-01T02:00:00.000Z', localDate: '2026-11-01', timezone: 'Asia/Ho_Chi_Minh', version: 1 },
    daily: { localDate: '2026-11-01', mood: 'content', growthDays: 0, growthTheme: 'curiosity', diary: { templateId: 'test', en: 'Pretend boxes.', vi: 'Hộp tưởng tượng.' }, storyEpisode: { templateId: 'test', chapter: 1, en: 'Pretend boxes.', vi: 'Hộp tưởng tượng.' } },
    entities: [], preferences: [], socialCircle: [], events: [], stories: [], storyProgress: null, friendship: 'getting_acquainted',
  };
  const en = classifyLocal('Bye, AI kitten.', 'vi', known);
  assert.equal(en.language, 'en');
  assert.equal(decide({ context, observation: en, text: 'Bye, AI kitten.', recall: null, comfortActive: false, history: [] }).language, 'vi');
  context.profile.languageMode = 'en';
  const vi = classifyLocal('Tạm biệt Miu.', 'en', known);
  assert.equal(vi.language, 'vi');
  assert.equal(decide({ context, observation: vi, text: 'Tạm biệt Miu.', recall: null, comfortActive: false, history: [] }).language, 'en');
});
