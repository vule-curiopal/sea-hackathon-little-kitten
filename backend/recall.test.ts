import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from './character/director.js';
import { isPetIdentityQuery, petIdentityMatches, recallFromProfile, resolveMemoryQuery } from './recall.js';
import type { DirectorInput, Entity, MemoryContext, SessionExchange } from './shared/types.js';

// Pure matcher/grounding fixtures only: these tests make no model requests and
// establish no character quality, learned-memory quality, or provider behavior.
const pet = (id: string, name: string, species: string): Entity => ({ id, name, species, kind: 'pet', aliases: [], expiresAt: '2026-12-01T02:00:00Z' });
function context(entities: Entity[] = []): MemoryContext {
  return {
    profile: { id: 'an-profile', demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh', stateVersion: 1, deletionEpoch: 0 },
    config: { personality: 'ENFP', role: 'friend', voiceId: 'miu-default', canonVersion: 'miu-v1' },
    clock: { mode: 'demo', effectiveNow: '2026-11-02T02:00:00Z', localDate: '2026-11-02', timezone: 'Asia/Ho_Chi_Minh', version: 1 },
    daily: { localDate: '2026-11-02', mood: 'curious', growthDays: 1, growthTheme: 'small discoveries', diary: { templateId: 'day', en: 'In my pretend house, Miu stacked boxes.', vi: 'Trong nhà tưởng tượng, Miu xếp hộp.' }, storyEpisode: { templateId: 'episode', chapter: 0, en: 'Miu tried a pretend paper boat.', vi: 'Miu thử chiếc thuyền giấy tưởng tượng.' } },
    entities, preferences: [], socialCircle: [], events: [], stories: [], storyProgress: null, friendship: 'getting_acquainted',
  };
}
const uncertainInput = (text: string, memory: MemoryContext): DirectorInput => ({
  text, context: memory, observation: { intent: 'chat', language: 'en', statedFeeling: null, uncertain: true, uncertainty: 'name', candidates: [], forgetTarget: null, suppressLearning: false },
  history: [], recall: null, comfortActive: false,
});

test('pure logic: bounded English and Vietnamese species-identity questions are recognized', () => {
  for (const query of [
    'Which one is my dog?', 'Which of them is my cat?', 'Which is our rabbit?', 'Who is my kitten?',
    'Which puppy is mine?', 'Hello again. Which one is my dog, again?', '  WHICH ONE IS MY CAT?  ',
    'Con nào là chó của mình?', 'Con nào là con mèo của tớ?', 'Con thỏ nào là của tôi?',
    'Chó nhà mình là con nào?', 'Thú cưng nào là của mình?', 'Con nào là thỏ của mình',
  ]) assert.equal(isPetIdentityQuery(query), true, query);
});

test('pure logic: existing explicit-name and direct-recall forms retain their routing', () => {
  for (const query of [
    'What is my dog’s name?', 'What is my cat called?', 'Do you remember my rabbit from last week?',
    'Con chó mình đã kể tên gì?', 'Miu có nhớ tên chó của mình không?',
    'What is my dog’s name after the bath?', 'Con chó đã tắm tên gì?',
  ]) assert.equal(isPetIdentityQuery(query), true, query);
});

test('pure logic: event questions and toy/fiction selectors do not become pet identity requests', () => {
  for (const query of [
    'Which dog fell in a puddle?', 'Which one of my cats ate the food?', 'Which one is my dog going to feed?',
    'Did my dog named Mochi get a bath?', 'What happened to my dog named Mochi?', 'Where is my cat named Nori?',
    'Do you remember my dog fell in a puddle?', 'Miu có biết chó tên Mochi được tắm chưa?',
    'Con chó nào đã ngã vào vũng nước?', 'Which one is my toy rabbit?', 'Con nào là thỏ bông của mình?',
    'Which one is my story rabbit?', 'Tell me about my dog.',
  ]) {
    assert.equal(isPetIdentityQuery(query), false, query);
    assert.notEqual(resolveMemoryQuery(context(), query)?.targetKind, 'pet', query);
  }
});

test('pure logic: typed identity grounding filters eligible pets by the requested species', () => {
  const memory = context([pet('dog', 'Mochi', 'dog'), pet('cat', 'Nori', 'cat'), pet('rabbit', 'Tofu', 'rabbit')]);
  for (const [query, expected] of [
    ['Which one is my dog?', 'dog'], ['Which of them is my cat?', 'cat'], ['Which is our rabbit?', 'rabbit'],
    ['Which puppy is mine?', 'dog'], ['Who is my kitten?', 'cat'],
    ['Con nào là chó của mình?', 'dog'], ['Con nào là con mèo của tớ?', 'cat'], ['Con nào là thỏ của mình', 'rabbit'],
  ] as const) {
    const resolved = resolveMemoryQuery(memory, query);
    assert.equal(resolved?.status, 'resolved', query);
    assert.deepEqual(resolved?.sourceIds, [expected], query);
    assert.equal(petIdentityMatches(memory, query)[0]?.id, expected, query);
    assert.equal(recallFromProfile(memory, query)?.id, expected, query);
    assert.equal(resolved?.facts.length, 1, query);
  }
});

test('pure logic: new copular routing does not turn fictional or compound species questions into real identity claims', () => {
  const memory = context([pet('dog', 'Mochi', 'dog'), pet('cat', 'Nori', 'cat'), pet('rabbit', 'Tofu', 'rabbit')]);
  for (const query of [
    'In my pretend story, which one is my dog?', 'In our story, which one is my cat?',
    'Trong truyện tưởng tượng, con nào là chó của mình?', 'Trong trò chơi, con nào là thỏ của tớ?',
    'Which one is my dog and which one is my cat?', 'Which one is my puppy and which one is my kitten?',
    'Con nào là chó của mình và con nào là mèo của mình?',
  ]) {
    assert.equal(isPetIdentityQuery(query), false, query);
    assert.deepEqual(petIdentityMatches(memory, query), [], query);
    assert.equal(resolveMemoryQuery(memory, query), null, query);
    assert.equal(recallFromProfile(memory, query), null, query);
    const plan = decide(uncertainInput(query, memory));
    assert.equal(plan.memoryReferenceId, null, query);
    assert.doesNotMatch(plan.allowedFacts.join(' '), /Mochi|Nori|Tofu/u, query);
  }
});

test('pure logic: same-species ambiguity and a missing species never select another surviving pet', () => {
  const ambiguous = context([pet('dog-1', 'Mochi', 'dog'), pet('dog-2', 'Pip', 'dog'), pet('cat', 'Nori', 'cat')]);
  const resolved = resolveMemoryQuery(ambiguous, 'Which one is my dog?');
  assert.equal(resolved?.status, 'ambiguous');
  assert.deepEqual(resolved?.sourceIds, ['dog-1', 'dog-2']);
  assert.equal(recallFromProfile(ambiguous, 'Which one is my dog?'), null);
  const missing = resolveMemoryQuery(context([pet('cat', 'Nori', 'cat')]), 'Which one is my dog?');
  assert.equal(missing?.status, 'missing');
  assert.deepEqual(missing?.sourceIds, []);
  assert.deepEqual(missing?.facts, []);
});

test('pure logic: eligible context remains the only identity source after deletion, expiry, or a profile switch', () => {
  const oldHistory: SessionExchange[] = [{ user: 'My dog is Mochi.', assistant: 'Mochi is your dog.', referenceId: 'removed-dog' }];
  // The memory service removes deleted/expired records before building context;
  // narrative demo time is deliberately not used as the real retention clock.
  const cleaned = context([]);
  assert.equal(resolveMemoryQuery(cleaned, 'Which one is my dog?', oldHistory)?.status, 'missing');
  assert.equal(recallFromProfile(cleaned, 'Which one is my dog?'), null);
  const other = context([pet('binh-dog', 'Orbit', 'dog')]);
  other.profile = { ...other.profile, id: 'binh-profile', demoKey: 'binh', displayName: 'Bình' };
  const otherResult = resolveMemoryQuery(other, 'Which one is my dog?', oldHistory);
  assert.deepEqual(otherResult?.sourceIds, ['binh-dog']);
  assert.doesNotMatch(otherResult?.facts.join(' ') ?? '', /Mochi/u);
  const forgotten = resolveMemoryQuery(other, 'What is the dog’s name that I asked you to forget?', oldHistory);
  assert.equal(forgotten?.status, 'missing');
  assert.deepEqual(forgotten?.sourceIds, []);
});

test('pure logic: eligible species grounding overrides generic classifier name uncertainty without mutating memory', () => {
  const memory = context([pet('dog', 'Mochi', 'dog'), pet('cat', 'Nori', 'cat')]);
  const before = structuredClone(memory);
  const plan = decide(uncertainInput('Which one is my dog?', memory));
  assert.equal(plan.purpose, 'chat');
  assert.equal(plan.action?.domain, 'memory');
  assert.equal(plan.action?.target?.status, 'resolved');
  assert.equal(plan.memoryReferenceId, 'dog');
  assert.match(plan.allowedFacts.join(' '), /Mochi/u);
  assert.doesNotMatch(plan.allowedFacts.join(' '), /Nori/u);
  assert.deepEqual(memory, before);
  const ambiguous = decide(uncertainInput('Which one is my dog?', context([pet('a', 'Mochi', 'dog'), pet('b', 'Pip', 'dog')])));
  assert.equal(ambiguous.purpose, 'clarify');
  assert.equal(ambiguous.memoryReferenceId, null);
  const missing = decide(uncertainInput('Which one is my dog?', context([pet('cat', 'Nori', 'cat')])));
  assert.equal(missing.action?.target?.status, 'missing');
  assert.deepEqual(missing.allowedFacts, []);
  assert.equal(missing.memoryReferenceId, null);
});
