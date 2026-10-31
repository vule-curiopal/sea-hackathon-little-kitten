import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MiuApplication, type TurnResponse } from './application.js';
import { createMemoryStore } from './memory/index.js';
import { FakeProvider } from './pipeline/providers.js';
import { AppError, type DirectorPlan, type MemoryCandidate } from './shared/types.js';

// Offline lifecycle and storage contracts only. Authored fixtures and fake speech
// here are not evidence of character quality, memory quality, or model performance.
async function fixture(provider = new FakeProvider()) {
  const memory = await createMemoryStore({ now: () => new Date('2026-11-02T02:00:00Z') });
  const app = new MiuApplication(memory, provider);
  await app.bootstrap();
  const opened = await app.openSession('an');
  const profileId = opened.context.profile.id;
  let sessionId = opened.session_id;
  const prepare = (text: string, id = randomUUID()) => app.prepareTurn(profileId, sessionId, { request_id: id, kind: 'utterance', text });
  const complete = async (reply: TurnResponse) => {
    for (const status of ['started', 'completed'] as const) await app.playback(profileId, sessionId, reply.turn_id, { request_id: randomUUID(), status, state_version: reply.state_version });
  };
  const say = async (text: string, id = randomUUID()) => { const reply = await prepare(text, id); await complete(reply); return reply; };
  const seed = async (value: string) => {
    const context = await memory.getContext(profileId);
    const event: MemoryCandidate = { kind: 'event', subjectName: 'Mochi', eventType: 'reported_event', value, evidence: value };
    await memory.learn({ profileId, turnId: `fixture-${randomUUID()}`, sourceText: value, localDate: context.clock.localDate, deletionEpoch: context.profile.deletionEpoch, candidates: [event] });
    const record = (await memory.getContext(profileId)).events.find(e => e.value === value)!;
    // Deliberately recreate a legacy record with no assertion provenance.
    await memory.db.query('UPDATE events SET source_evidence=NULL WHERE profile_id=$1 AND id=$2', [profileId, record.id]);
    return record.id;
  };
  const reopen = async () => { sessionId = (await app.openSession('an')).session_id; };
  return { app, memory, profileId, prepare, say, seed, reopen };
}

test('an implicit retraction removes only the disputed legacy event and revokes cached turns', async t => {
  const h = await fixture(); t.after(() => h.app.close());
  const originalId = randomUUID();
  await h.say('My dog is Mochi.', originalId);
  await h.say('I like rolling a ball.');
  await h.seed('Mochi got a bath today');
  await h.seed('Mochi rolled a ball today');
  await h.say('Did I tell you Mochi got a bath today?');
  const correction = await h.say('I did not say that, so do not make it up.');
  assert.equal(correction.memory.invalidate_replay, true);
  const after = await h.memory.getContext(h.profileId);
  assert.deepEqual(after.events.map(e => e.value), ['Mochi rolled a ball today']);
  assert.equal(after.entities[0]?.name, 'Mochi');
  assert.equal(after.preferences[0]?.value, 'rolling a ball');
  await assert.rejects(h.prepare('My dog is Mochi.', originalId), { code: 'stale_state' });
});
test('explicit event retraction works after reopening; ambiguous that cannot select a record', async t => {
  const h = await fixture(); t.after(() => h.app.close());
  await h.say('My dog is Mochi.'); await h.seed('Mochi got a bath today');
  await h.reopen();
  const ambiguous = await h.say('I did not say that.');
  assert.equal(ambiguous.presentation.purpose, 'clarify');
  assert.equal((await h.memory.getContext(h.profileId)).events.length, 1);
  await h.say('I did not say Mochi got a bath today.');
  assert.equal((await h.memory.getContext(h.profileId)).events.length, 0);
  assert.equal((await h.memory.getContext(h.profileId)).entities[0]?.name, 'Mochi');
});
test('a provider failure after retraction preserves the committed correction and client invalidation', async t => {
  class Failure extends FakeProvider {
    override async check(text: string, plan: DirectorPlan, signal?: AbortSignal) {
      if (plan.responseGoal?.includes('was retracted')) throw new AppError('provider_unavailable', 503);
      return super.check(text, plan, signal);
    }
  }
  const h = await fixture(new Failure()); t.after(() => h.app.close());
  await h.say('My dog is Mochi.'); await h.seed('Mochi got a bath today');
  await assert.rejects(h.prepare('I did not say Mochi got a bath today.'), error => error instanceof AppError && error.code === 'provider_unavailable' && error.invalidation?.memory.invalidate_replay === true);
  const after = await h.memory.getContext(h.profileId);
  assert.equal(after.events.length, 0); assert.equal(after.entities[0]?.name, 'Mochi');
});
