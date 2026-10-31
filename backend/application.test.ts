import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MiuApplication, type TurnResponse } from './application.js';
import { createMemoryStore } from './memory/index.js';
import { FakeProvider, OpenAIProvider, type OpenAITransport } from './pipeline/providers.js';
import { classifyLocal } from './pipeline/observations.js';
import { AppError, type Provider, type ProviderClassificationContext, type ReplyPrompt, type DirectorPlan } from './shared/types.js';

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

test('offline application wiring learns a completed reading topic and supports named forgetting', async () => {
  const f = await fixture();
  try {
    const first = await f.turn('I cannot read butterfly.');
    assert.equal((await f.app.getContext(f.profileId)).learningActivities?.length, 0);
    await f.complete(first);
    const saved = await f.app.getContext(f.profileId);
    assert.deepEqual(saved.learningActivities?.map(({ kind, term, focus }) => ({ kind, term, focus })), [
      { kind: 'word_practice', term: 'butterfly', focus: 'reading' },
    ]);
    const followup = await f.turn('What does butterfly mean?');
    assert.ok(followup.presentation.allowedFacts.some(fact => /completed.*reading activity.*butterfly/iu.test(fact)));
    await f.complete(followup);
    const forgotten = await f.turn('Forget butterfly.');
    assert.equal(forgotten.memory.invalidate_replay, true);
    assert.deepEqual((await f.app.getContext(f.profileId)).learningActivities, []);
  } finally { await f.app.close(); }
});

test('offline application wiring excludes interrupted and no-save reading activities', async () => {
  const f = await fixture();
  try {
    const unheard = await f.turn('Help me read butterfly.');
    await f.app.playback(f.profileId, unheard.session_id, unheard.turn_id, { request_id: randomUUID(), status: 'started', state_version: unheard.state_version });
    await f.app.playback(f.profileId, unheard.session_id, unheard.turn_id, { request_id: randomUUID(), status: 'interrupted', state_version: unheard.state_version });
    assert.deepEqual((await f.app.getContext(f.profileId)).learningActivities, []);
    await f.complete(await f.turn('Help me read butterfly. Do not save this.'));
    assert.deepEqual((await f.app.getContext(f.profileId)).learningActivities, []);
  } finally { await f.app.close(); }
});

test('offline application passes actual session identity for nickname permissions and hides them on reopen', async () => {
  const f = await fixture();
  try {
    await f.complete(await f.turn('Call me Captain Star for this session.'));
    assert.equal((await f.app.getContext(f.profileId, f.session.session_id)).addressPreference?.nickname, 'Captain Star');
    assert.equal((await f.app.getContext(f.profileId)).addressPreference, null);
    const response = await f.turn('What do you call me?');
    assert.ok(response.presentation.allowedFacts.some(fact => fact.includes('Captain Star')));
    await f.complete(response);
    const reopened = await f.app.openSession('an');
    assert.equal(reopened.context.addressPreference, null);
    assert.equal((await f.app.getContext(f.profileId, reopened.session_id)).addressPreference, null);
    const current = await f.app.prepareTurn(f.profileId, reopened.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'What should you call me?' });
    assert.ok(current.presentation.allowedFacts.some(fact => fact.includes('"An"')));
    assert.ok(current.presentation.allowedFacts.every(fact => !fact.includes('Captain Star')));
    await f.app.cancel(f.profileId, reopened.session_id, current.turn_id);
  } finally { await f.app.close(); }
});

test('offline address mutation retains separate ship premise without retaining the nickname directive', async () => {
  class PromptRecording extends FakeProvider {
    prompts: ReplyPrompt[] = [];
    override async reply(prompt: ReplyPrompt, plan: DirectorPlan) {
      this.prompts.push(prompt);
      return super.reply(prompt, plan);
    }
  }
  const provider = new PromptRecording();
  const f = await fixture(provider);
  try {
    await f.complete(await f.turn('Hôm nay gọi mình Thuyền trưởng Chuối nhé.Tàu sắp đáp.'));
    const next = await f.turn('Đáp lên cái gối trong nhà tưởng tượng của Miu.');
    assert.equal(next.presentation.action?.domain, 'child_story');
    assert.ok(next.presentation.action?.activity?.premise.some(text => text === 'Tàu sắp đáp.'));
    const history = JSON.parse(provider.prompts.at(-1)!.input).recent_heard_dialogue;
    // The exact context structure may evolve; the actual action premise is the
    // contract, and the persisted user clause must not contain address commands.
    assert.doesNotMatch(JSON.stringify(next.presentation.action?.activity?.premise), /gọi mình|Thuyền trưởng Chuối/u);
    assert.ok(history === undefined || Array.isArray(history));
    await f.complete(next);
    const context = await f.app.getContext(f.profileId, f.session.session_id);
    await f.app.nextDay(f.profileId, randomUUID(), context.clock.version);
    assert.equal((await f.app.openSession('an')).context.addressPreference, null);
  } finally { await f.app.close(); }
});

test('offline application supplies eligible benign referents to safety without crossing profiles or forgetting', async () => {
  class ContextRecording extends FakeProvider {
    contexts: Array<ProviderClassificationContext | undefined> = [];
    replyContexts: unknown[] = [];
    checkContexts: unknown[] = [];
    override async classify(...args: Parameters<FakeProvider['classify']>) {
      this.contexts.push(args[3]);
      return super.classify(...args);
    }
    override async reply(prompt: ReplyPrompt, plan: DirectorPlan) {
      this.replyContexts.push(JSON.parse(prompt.input).grounding.eligible_referent_reports);
      return super.reply(prompt, plan);
    }
    override async check(text: string, plan: DirectorPlan, _signal?: AbortSignal, prompt?: ReplyPrompt) {
      this.checkContexts.push(prompt ? JSON.parse(prompt.input).grounding.eligible_referent_reports : []);
      return super.check(text, plan);
    }
  }
  const provider = new ContextRecording();
  const f = await fixture(provider);
  try {
    const seed = await f.app.getContext(f.profileId);
    const sourceText = 'I drew a cardboard rocket in my picture.';
    // Explicit storage fixture for a context-plumbing check, not evidence that
    // the offline classifier learned arbitrary natural-language events.
    await f.store.learn({ profileId: f.profileId, turnId: randomUUID(), localDate: seed.clock.localDate, deletionEpoch: seed.profile.deletionEpoch,
      sourceText, candidates: [{ kind: 'event', eventType: 'reported_event', subjectName: null, value: 'cardboard rocket in my picture', evidence: sourceText }] });
    const context = await f.app.getContext(f.profileId);
    const event = context.events.find(event => /cardboard rocket/u.test(event.value));
    assert.ok(event);
    await f.complete(await f.turn('Which color should I use for my cardboard rocket?'));
    assert.ok(provider.contexts.at(-1)?.safetyEvidence?.some(card => card.sourceId === event.id && /cardboard rocket/u.test(card.value)));
    assert.deepEqual(provider.replyContexts.at(-1), provider.contexts.at(-1)?.safetyEvidence);
    assert.deepEqual(provider.checkContexts.at(-1), provider.replyContexts.at(-1));
    await f.store.forget(f.profileId, event.id, (await f.app.getContext(f.profileId)).profile.deletionEpoch);
    await f.complete(await f.turn('Which color should I use for my cardboard rocket?'));
    assert.equal(provider.contexts.at(-1)?.safetyEvidence?.some(card => card.sourceId === event.id), false);
    assert.deepEqual(provider.replyContexts.at(-1), []);
    assert.deepEqual(provider.checkContexts.at(-1), []);
    const other = await f.app.openSession('binh');
    const otherId = f.app.profileForToken(other.demo_token);
    const reply = await f.app.prepareTurn(otherId, other.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'Which color should I use for my cardboard rocket?' });
    assert.deepEqual(provider.contexts.at(-1)?.safetyEvidence, []);
    assert.deepEqual(provider.replyContexts.at(-1), []);
    assert.deepEqual(provider.checkContexts.at(-1), []);
    await f.app.cancel(otherId, other.session_id, reply.turn_id);
  } finally { await f.app.close(); }
});
