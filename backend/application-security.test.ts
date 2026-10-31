import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MiuApplication, type TurnResponse } from './application.js';
import { createMemoryStore } from './memory/index.js';
import { FakeProvider } from './pipeline/providers.js';
import type { DirectorPlan, Language, Observation } from './shared/types.js';

async function setup(provider = new FakeProvider()) {
  const memory = await createMemoryStore({ now: () => new Date('2026-10-31T02:00:00Z') });
  const app = new MiuApplication(memory, provider);
  await app.bootstrap();
  const opened = await app.openSession('an');
  const profileId = opened.context.profile.id;
  const sessionId = opened.session_id;
  const prepare = (text: string, requestId = randomUUID()) => app.prepareTurn(profileId, sessionId, { request_id: requestId, kind: 'utterance', text });
  const receipt = (response: TurnResponse, status: 'started' | 'completed' | 'interrupted', requestId = randomUUID()) => app.playback(profileId, sessionId, response.turn_id, { request_id: requestId, status, state_version: response.state_version });
  const complete = async (response: TurnResponse) => { await receipt(response, 'started'); await receipt(response, 'completed'); };
  const say = async (text: string, requestId = randomUUID()) => { const response = await prepare(text, requestId); await complete(response); return response; };
  return { memory, app, profileId, sessionId, prepare, receipt, complete, say };
}

test('canceled or interrupted unheard full-delete confirmations cannot authorize a later yes', async (t) => {
  const h = await setup();
  t.after(() => h.app.close());
  await h.say('I like dinosaurs');
  const epoch = (await h.memory.getContext(h.profileId)).profile.deletionEpoch;

  const canceled = await h.prepare('Forget everything');
  assert.equal(canceled.reply.text, 'Should Miu forget everything you shared?');
  await h.app.cancel(h.profileId, h.sessionId, canceled.turn_id);
  const firstYes = await h.say('yes');
  assert.notEqual(firstYes.presentation.purpose, 'acknowledge_forget');
  assert.equal((await h.memory.getContext(h.profileId)).preferences.length, 1);

  const interrupted = await h.prepare('Forget everything');
  await h.receipt(interrupted, 'started');
  await h.receipt(interrupted, 'interrupted');
  const secondYes = await h.say('yes');
  assert.notEqual(secondYes.presentation.purpose, 'acknowledge_forget');
  const after = await h.memory.getContext(h.profileId);
  assert.equal(after.profile.deletionEpoch, epoch);
  assert.equal(after.preferences[0]?.value, 'dinosaurs');
});

test('a confirmation rejected by validation cannot authorize full-profile deletion', async (t) => {
  class RejectConfirmation extends FakeProvider {
    override async check(text: string, plan: DirectorPlan, signal?: AbortSignal) {
      if (text === 'Should Miu forget everything you shared?') return { approved: false, violations: ['fixture_rejected'] };
      return super.check(text, plan, signal);
    }
  }
  const h = await setup(new RejectConfirmation());
  t.after(() => h.app.close());
  await h.say('I like dinosaurs');
  await assert.rejects(h.prepare('Forget everything'), { code: 'validation_failed' });
  const yes = await h.say('yes');
  assert.notEqual(yes.presentation.purpose, 'acknowledge_forget');
  assert.equal((await h.memory.getContext(h.profileId)).preferences[0]?.value, 'dinosaurs');
});

test('a delayed pre-deletion turn retry cannot recreate forgotten memory', async (t) => {
  const h = await setup();
  t.after(() => h.app.close());
  const originalId = randomUUID();
  await h.say('My dog Mochi fell in a puddle', originalId);
  assert.equal((await h.memory.getContext(h.profileId)).entities[0]?.name, 'Mochi');
  const forgotten = await h.say('Forget Mochi');
  assert.equal(forgotten.presentation.purpose, 'acknowledge_forget');
  assert.equal(forgotten.memory.invalidate_replay, true);
  await assert.rejects(h.prepare('My dog Mochi fell in a puddle', originalId), { code: 'stale_state' });
  await assert.rejects(h.prepare('My dog Nori fell in a puddle', originalId), { code: 'idempotency_conflict' });
  const after = await h.memory.getContext(h.profileId);
  assert.equal(after.entities.length, 0);
  assert.equal(after.events.length, 0);
});

test('concurrent identical turns share generation and completed receipts learn only once', async (t) => {
  class CountingProvider extends FakeProvider {
    classifications = 0;
    checks = 0;
    override async classify(text: string, language: Language, signal?: AbortSignal): Promise<Observation> {
      this.classifications += 1;
      return super.classify(text, language, signal);
    }
    override async check(text: string, plan: DirectorPlan, signal?: AbortSignal) {
      this.checks += 1;
      return super.check(text, plan, signal);
    }
  }
  const provider = new CountingProvider();
  const h = await setup(provider);
  t.after(() => h.app.close());
  const turnId = randomUUID();
  const replies = await Promise.all(Array.from({ length: 8 }, () => h.prepare('My dog Mochi fell in a puddle', turnId)));
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
  assert.equal(provider.classifications, 1);
  assert.equal(provider.checks, 1);
  const response = replies[0]!;
  await h.receipt(response, 'started');
  const completionId = randomUUID();
  const completed = await Promise.all(Array.from({ length: 6 }, () => h.receipt(response, 'completed', completionId)));
  for (const result of completed) assert.deepEqual(result, completed[0]);
  const context = await h.memory.getContext(h.profileId);
  assert.equal(context.entities.filter(entity => entity.name === 'Mochi').length, 1);
  assert.equal(context.events.length, 1);
});

test('cached turns are invalid after configuration changes, while exact retries before a change succeed', async (t) => {
  const h = await setup();
  t.after(() => h.app.close());
  const turnId = randomUUID();
  const original = await h.say('I like dinosaurs', turnId);
  assert.deepEqual(await h.prepare('I like dinosaurs', turnId), original);
  await h.app.updateConfig(h.profileId, { personality: 'ISTJ' });
  await assert.rejects(h.prepare('I like dinosaurs', turnId), { code: 'stale_state' });
});
