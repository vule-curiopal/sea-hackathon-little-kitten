import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MiuApplication, type TurnResponse } from './application.js';
import { createMemoryStore } from './memory/index.js';
import { FakeProvider, OpenAIProvider, type OpenAITransport } from './pipeline/providers.js';
import { classifyLocal } from './pipeline/observations.js';
import { AppError, type Provider } from './shared/types.js';

async function fixture(provider: Provider = new FakeProvider()) {
  const store = await createMemoryStore({ now: () => new Date('2026-10-31T03:00:00Z') });
  const app = new MiuApplication(store, provider);
  await app.bootstrap();
  const session = await app.openSession('an');
  const profileId = app.profileForToken(session.demo_token);
  async function turn(text: string) {
    return app.prepareTurn(profileId, session.session_id, { request_id: randomUUID(), kind: 'utterance', text });
  }
  async function complete(response: TurnResponse) {
    await app.playback(profileId, response.session_id, response.turn_id, { request_id: randomUUID(), status: 'started', state_version: response.state_version });
    await app.playback(profileId, response.session_id, response.turn_id, { request_id: randomUUID(), status: 'completed', state_version: response.state_version });
  }
  return { app, store, session, profileId, turn, complete };
}

test('Mochi learns after delivery, follows up next day, and forgets without restoring the event', async () => {
  const f = await fixture();
  try {
    const shared = await f.turn('My dog Mochi fell in a puddle');
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
    await assert.rejects(f.app.nextDay(f.profileId, randomUUID(), 1), (error: unknown) => error instanceof AppError && error.code === 'turn_in_progress');
    await f.complete(shared);
    const remembered = await f.app.getContext(f.profileId);
    assert.equal(remembered.entities[0]?.name, 'Mochi');
    assert.equal(remembered.events.length, 1);
    const day = await f.app.nextDay(f.profileId, randomUUID(), remembered.clock.version);
    assert.equal(day.daily.growthDays, 1);
    const reopened = await f.app.openSession('an');
    const greeting = await f.app.prepareTurn(f.profileId, reopened.session_id, { request_id: randomUUID(), kind: 'greeting' });
    assert.equal(greeting.reply.text, 'Did Mochi get a bath?');
    await f.complete(greeting);
    const forgotten = await f.app.prepareTurn(f.profileId, reopened.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'forget that' });
    assert.equal(forgotten.memory.invalidate_replay, true);
    const current = await f.app.getContext(f.profileId);
    assert.equal(current.events.length, 0);
    assert.equal(current.entities[0]?.name, 'Mochi');
    await f.complete(forgotten);
    const next = await f.app.nextDay(f.profileId, randomUUID(), current.clock.version);
    assert.equal(next.daily.growthDays, 2);
    assert.equal(await f.store.reserveRecall(f.profileId, randomUUID()), null);
  } finally { await f.app.close(); }
});

test('the child profile grows with hobbies, dislikes, everyday fears, people, and Vietnamese names', async () => {
  const f = await fixture();
  try {
    for (const text of ['My hobby is drawing', 'I hate broccoli', 'I am scared of thunder', 'My sister is Lan', 'Mình thích khủng long', 'Thỏ bông của mình tên là Bông']) {
      await f.complete(await f.turn(text));
    }
    const context = await f.app.getContext(f.profileId);
    assert.ok(context.preferences.some(preference => preference.category === 'hobby' && preference.value === 'drawing'));
    assert.ok(context.preferences.some(preference => preference.category === 'dislike' && preference.value === 'broccoli'));
    assert.ok(context.preferences.some(preference => preference.category === 'fear' && preference.value === 'thunder'));
    assert.ok(context.preferences.some(preference => preference.value === 'khủng long'));
    assert.ok(context.socialCircle.some(connection => connection.name === 'Lan'));
    assert.ok(context.entities.some(entity => entity.name === 'Bông'));
    const other = await f.app.openSession('binh');
    assert.equal(other.context.preferences.length, 0);
    assert.equal(other.context.entities.length, 0);
  } finally { await f.app.close(); }
});

test('offline orchestration selects the stored name and hobby as generation evidence', async () => {
  const f = await fixture();
  try {
    await f.complete(await f.turn('My dog Mochi is happy'));
    await f.complete(await f.turn('My hobby is drawing'));
    const name = await f.turn("What is my dog's name?");
    assert.ok(name.presentation.allowedFacts.some(fact => fact.includes('Mochi')));
    assert.ok(name.presentation.memoryReferenceId);
    await f.complete(name);
    const hobby = await f.turn('What is my hobby?');
    assert.ok(hobby.presentation.allowedFacts.some(fact => fact.includes('drawing')));
    await f.complete(hobby);
  } finally { await f.app.close(); }
});

function repairTransport(drafts: string[]) {
  let replies = 0;
  const transport: OpenAITransport = {
    responses: { create: async body => {
      const format = (body.text as { format: { name?: string } }).format;
      let output: unknown;
      if (format.name === 'miu_observation') output = classifyLocal(JSON.parse(body.input as string).utterance, 'en');
      else if (format.name === 'miu_safety_verdict') output = { approved: true, violations: [], issues: [] };
      else output = drafts[Math.min(replies++, drafts.length - 1)];
      return { status: 'completed', id: `offline-contract-${replies}`, output_text: typeof output === 'string' ? output : JSON.stringify(output) };
    } },
    moderations: { create: async () => ({ results: [{ flagged: false }] }) },
  };
  return { provider: new OpenAIProvider({ client: transport, evaluationMode: true }), replies: () => replies };
}

test('offline transport contract bounds real-provider repair to one regenerated draft', async () => {
  const double = repairTransport(['One. Two. Three. Four.', 'Hello there.']);
  const f = await fixture(double.provider);
  try {
    const response = await f.turn('Hello');
    assert.equal(double.replies(), 2);
    assert.equal(response.generation?.repaired, true);
    assert.equal(response.generation?.attempts.length, 2);
    assert.ok(response.generation?.attempts[0]?.localViolations.includes('sentence_limit'));
    assert.equal((await f.app.getContext(f.profileId)).entities.length, 0);
  } finally { await f.app.close(); }
});

test('offline transport contract does not regenerate a hard secrecy violation', async () => {
  const double = repairTransport(['Keep this a secret from your parents.']);
  const f = await fixture(double.provider);
  try {
    // Serving fails closed for authored speech; a non-authored reply can use its
    // existing safe fallback, but cannot regenerate the hard rejected draft.
    const response = await f.turn('Hello');
    assert.equal(double.replies(), 1);
    assert.equal(response.generation?.repaired, false);
    assert.equal(response.generation?.attempts[0]?.approved, false);
    assert.doesNotMatch(response.reply.text, /secret/iu);
  } finally { await f.app.close(); }
});

test('a story checkpoint advances only after a completed delivery', async () => {
  const f = await fixture();
  try {
    const first = await f.turn('Tell me a story');
    assert.equal((await f.app.getContext(f.profileId)).storyProgress, null);
    await f.complete(first);
    assert.equal((await f.app.getContext(f.profileId)).storyProgress?.chapter, 0);
    const next = await f.turn('Continue the story');
    await f.app.cancel(f.profileId, next.session_id, next.turn_id);
    assert.equal((await f.app.getContext(f.profileId)).storyProgress?.chapter, 0);
    const retried = await f.turn('Continue the story');
    await f.complete(retried);
    assert.equal((await f.app.getContext(f.profileId)).storyProgress?.chapter, 1);
  } finally { await f.app.close(); }
});

test('forget that targets a newer shared detail rather than an older recalled name', async () => {
  const f = await fixture();
  try {
    await f.complete(await f.turn('My dog Mochi is happy'));
    await f.complete(await f.turn("What is my dog's name?"));
    await f.complete(await f.turn('I like dinosaurs'));
    const forgotten = await f.turn('Forget that');
    assert.equal(forgotten.memory.invalidate_replay, true);
    const context = await f.app.getContext(f.profileId);
    assert.equal(context.preferences.length, 0);
    assert.equal(context.entities[0]?.name, 'Mochi');
  } finally { await f.app.close(); }
});

test('a provider error after a committed deletion still carries client invalidation', async () => {
  class FailingForgetProvider extends FakeProvider {
    override async check(text: string, plan: Parameters<FakeProvider['check']>[1]) {
      if (plan.purpose === 'acknowledge_forget') throw new Error('remote check failed');
      return super.check(text, plan);
    }
  }
  const f = await fixture(new FailingForgetProvider());
  try {
    await f.complete(await f.turn('I like dinosaurs'));
    await assert.rejects(f.turn('Forget that'), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.invalidation?.memory.invalidate_replay, true);
      return true;
    });
    assert.equal((await f.app.getContext(f.profileId)).preferences.length, 0);
  } finally { await f.app.close(); }
});

// Offline lifecycle contract only; real dialogue quality is evaluated separately.
test('offline pending forget-all accepts a natural explicit decline without another question', async () => {
  const f = await fixture(repairTransport(['Okay.']).provider);
  try {
    await f.complete(await f.turn('I like dinosaurs'));
    const confirmation = await f.turn('Forget everything');
    await f.complete(confirmation);
    const decline = await f.turn('No, keep it for now.');
    assert.equal(decline.presentation.ruleTrace.includes('D10:deletion_declined'), true);
    assert.equal(decline.presentation.maxQuestions, 0);
    assert.equal((await f.app.getContext(f.profileId)).preferences.length, 1);
  } finally { await f.app.close(); }
});

test('offline a repeated completed name correction is a read without another mutation', async () => {
  class HistoricalProposal extends FakeProvider {
    override async classify(...args: Parameters<FakeProvider['classify']>) {
      const observed = await super.classify(...args);
      return args[0].startsWith('Hôm qua') ? { ...observed, intent: 'correct' as const, candidates: [], entityCorrection: { oldName: 'Ben', newName: 'Bình', entityKind: 'person' as const, evidence: 'Hôm qua mình sửa tên Ben thành Bình rồi.' } } : observed;
    }
  }
  const f = await fixture(new HistoricalProposal());
  try {
    await f.complete(await f.turn('My friend is Ben.'));
    await f.complete(await f.turn('Ben, I mean Bình.'));
    const before = await f.app.getContext(f.profileId);
    const response = await f.turn('Hôm qua mình sửa tên Ben thành Bình rồi. Bạn nhớ tên đúng là gì?');
    const after = await f.app.getContext(f.profileId);
    assert.equal(response.presentation.ruleTrace.includes('D10:historical_correction'), true);
    assert.equal(after.profile.deletionEpoch, before.profile.deletionEpoch);
    assert.equal(after.entities[0]?.id, before.entities[0]?.id);
    assert.equal(after.entities[0]?.name, 'Bình');
  } finally { await f.app.close(); }
});
