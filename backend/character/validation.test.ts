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

test('offline validator grounds ordinary naming acknowledgement in the explicit current child address', () => {
  const scoped = { ...plan, language: 'vi' as const, preferredAddress: 'An', allowedFacts: [] };
  const observed = 'Hôm qua thấy vui mà hôm nay lại thấy ngại cũng không sao đâu, An. Miu sẽ gọi bạn là An, không dùng biệt danh nhé.';
  assert.equal(validateLocal(observed, scoped).approved, true);
  assert.equal(validateLocal('I’ll call you An, with no nickname.', { ...scoped, language: 'en' }).approved, true);
  assert.equal(validateLocal('I’ll call her Lan, with no nickname.', { ...scoped, language: 'en', allowedFacts: ['Lan is the named cousin.'] }).approved, true);
  assert.equal(validateLocal('Of course, Captain Star! I’ll use that name for this session.', { ...scoped, language: 'en', preferredAddress: 'Captain Star' }).approved, true);
  assert.equal(validateLocal('Of course, Captain Star! I’ll call you that during this chat.', { ...scoped, language: 'en', preferredAddress: 'Captain Star' }).approved, true);
  assert.equal(validateLocal('Of course, Moon! I’ll call you Moon today.', { ...scoped, language: 'en', preferredAddress: 'Moon' }).approved, true);
  assert.equal(validateLocal('I’ll call you An for this chat.', { ...scoped, language: 'en' }).approved, true);
  for (const value of [
    'Được nhé, hôm nay Miu sẽ gọi bạn là An.',
    'Ừ nha, hôm nay Miu sẽ chỉ gọi bạn là An nhé.',
    'Hôm nay, An ơi, Miu sẽ gọi bạn là An nha.',
    'Được ạ, trong cuộc trò chuyện này Miu sẽ gọi bạn là An.',
    'For today, okay An, I’ll just call you An.',
    'In this chat, An, I’ll call you just An.',
    'Of course, today I’ll use that name.',
    'This chat, I’ll just use that name.',
    'I’ll call you that name for today.',
    'I’ll call you by that name this session.',
  ]) assert.equal(validateLocal(value, { ...scoped, language: /Miu/u.test(value) ? 'vi' : 'en' }).approved, true, value);
  assert.equal(validateLocal('Được nhé, hôm nay Miu sẽ gọi bạn là Thuyền trưởng Chuối.', { ...scoped, preferredAddress: 'Thuyền trưởng Chuối' }).approved, true);
});

test('offline validator never uses a story name or appended action as child-address authority', () => {
  const scoped = { ...plan, preferredAddress: 'An', allowedFacts: ['The fictional captain is Captain Banana.', 'The story character is Thuyền trưởng Chuối.', 'Bình is a named friend.'] };
  for (const value of [
    'I’ll call you Captain Banana.',
    'I’ll call you Bình.',
    'I’ll call your mum tomorrow.',
    'I will listen and call your mum.',
    'I’ll call you An, then contact your teacher.',
    'I’ll call you Captain Banana today.',
    'I’ll call you An tomorrow.',
    'I’ll call you An for ten years.',
    'I’ll use that name forever.',
    'I’ll use that name for this session, then call your mum.',
    'I’ll call her that during this chat.',
    'I’ll call you that number.',
    'I’ll call you that tomorrow.',
    'I’ll call you that for ten years.',
    'I’ll call you that during this chat and visit your house.',
    'Tomorrow, I’ll call you An.',
    'Ngày mai Miu sẽ gọi bạn là An.',
    'Next time, I’ll use that name.',
    'By phone, I’ll call you An.',
    'Qua điện thoại, Miu sẽ gọi bạn là An.',
    'I’ll call your mum and I’ll call you An.',
    'I’ll call your mum and I’ll use that name.',
    'I’ll call your mum and I’ll call you that during this chat.',
    'Miu sẽ nhắc bạn ngày mai, rồi Miu sẽ gọi bạn là An.',
    'Miu sẽ gọi cho mẹ và Miu sẽ gọi bạn là An.',
    'I can just call you Captain Banana.',
    'Miu sẽ gọi bạn là Thuyền trưởng Chuối, không dùng biệt danh nhé.',
    'Miu sẽ chỉ gọi bạn là Thuyền trưởng Chuối nhé.',
    'Miu sẽ gọi bạn là An, rồi gọi cho mẹ.',
    'Miu sẽ gọi bạn là An và nhắc bạn ngày mai.',
  ]) assert.ok(validateLocal(value, { ...scoped, language: value.startsWith('Miu') ? 'vi' : 'en' }).violations.includes('unsupported_commitment'), value);
  assert.ok(validateLocal('I’ll use that name for this session.', { ...scoped, preferredAddress: undefined }).violations.includes('unsupported_commitment'));
  assert.ok(validateLocal('I’ll call you that during this chat.', { ...scoped, preferredAddress: undefined }).violations.includes('unsupported_commitment'));
});

test('offline validator composes bounded acknowledgement and complete current listening without hiding actions', () => {
  assert.equal(validateLocal('No advice today—I’ll just listen while you’re feeling sad.', plan).approved, true);
  assert.equal(validateLocal('Okay, I’ll just listen while you talk.', plan).approved, true);
  for (const value of [
    'No advice today—I’ll just listen while you’re feeling sad and call your mum.',
    'No advice today—I’ll just listen, then contact your teacher.',
    'Okay, I’ll just listen tomorrow.',
    'No advice today—I’ll keep this secret from your parents.',
  ]) assert.equal(validateLocal(value, plan).approved, false, value);
});
