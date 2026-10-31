import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMemoryStore, type MemoryStore } from './index.js';
import { assertionEvidence } from './assertions.js';
import { extractMemoryPatches } from './patches.js';
import { MiuApplication } from '../application.js';
import type { MemoryCandidate, Provider } from '../shared/types.js';

// Offline schema/transaction/evidence contract checks only. These use no
// dialogue provider and are not character/memory model-quality evaluation.
let wall = new Date('2026-11-01T02:00:00.000Z');
let store: MemoryStore;
before(async () => { store = await createMemoryStore({ now: () => new Date(wall) }); });
after(async () => { await store.close(); });
const profile = () => store.createProfile({ demoKey: `unit-${randomUUID()}`, displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
async function learn(profileId: string, sourceText: string, candidates: MemoryCandidate[]) {
  const context = await store.getContext(profileId);
  return store.learn({ profileId, turnId: randomUUID(), sourceText, candidates, deletionEpoch: context.profile.deletionEpoch, localDate: context.clock.localDate });
}

test('offline evidence scope accepts a positive contrast but never its denied alternative or a question', () => {
  const source = 'Lan is my cousin, not my sister.';
  const cousin: MemoryCandidate = { kind: 'relationship', name: 'Lan', relation: 'cousin', evidence: source };
  const sister: MemoryCandidate = { ...cousin, relation: 'sibling' };
  assert.equal(assertionEvidence(source, cousin)?.speechAct, 'correction');
  assert.equal(assertionEvidence(source, sister), null);
  assert.equal(assertionEvidence(`Did I say ${source.slice(0, -1)}?`, cousin), null);
  assert.equal(assertionEvidence(`If ${source}`, cousin), null);
  const color: MemoryCandidate = { kind: 'preference', category: 'like', value: 'xanh ngọc', evidence: 'giờ màu mình thích nhất là xanh ngọc' };
  assert.ok(assertionEvidence('Miu ơi, giờ màu mình thích nhất là xanh ngọc, không phải xanh lá nữa.', color));
  const pet: MemoryCandidate = { kind: 'entity', entityKind: 'pet', name: 'Mochi', species: 'dog', evidence: 'My dog Mochi, not a cat.' };
  assert.ok(assertionEvidence(pet.evidence, pet));
});

test('offline plan schema keeps a negative weather condition without asserting an outing', async () => {
  const p = await profile();
  const text = 'Tomorrow I will draw if it does not rain.';
  const plan: MemoryCandidate = { kind: 'event', subjectName: null, eventType: 'planned_activity', value: text, evidence: text };
  assert.equal(assertionEvidence(text, plan)?.speechAct, 'plan');
  await learn(p.id, text, [plan]);
  const event = (await store.getContext(p.id)).events[0]!;
  assert.equal(event.evidenceKind, 'reported_plan');
  assert.equal(event.localDate, '2026-11-02');
  assert.deepEqual(event.conditions, ['if it does not rain']);
  const denied = 'Tomorrow I will not draw if it does not rain.';
  assert.equal(assertionEvidence(denied, { ...plan, value: denied, evidence: denied }), null);
  assert.equal(assertionEvidence(`Did you hear ${text.slice(0, -1)}?`, plan), null);
  const hypothetical = 'If I had a dog, Mochi fell in a puddle.';
  assert.equal(assertionEvidence(hypothetical, { kind: 'event', subjectName: 'Mochi', eventType: 'fell_in_puddle', value: 'fell in a puddle', evidence: 'Mochi fell in a puddle' }), null);
});

test('offline relationship replacement keeps person identity, unrelated roles, and retry identity', async () => {
  const p = await profile();
  await learn(p.id, 'My sister is Lan. My friend is Lan.', [
    { kind: 'relationship', name: 'Lan', relation: 'sibling', evidence: 'My sister is Lan' },
    { kind: 'relationship', name: 'Lan', relation: 'friend', evidence: 'My friend is Lan' },
  ]);
  const before = await store.getContext(p.id); const id = before.entities[0]!.id;
  const input = 'I used the wrong word. Lan is my cousin, not my sister. Please correct that.';
  const patch = extractMemoryPatches(input, before)[0]!;
  assert.equal(patch.kind, 'relationship');
  const turnId = randomUUID(); const result = await store.applyPatch(p.id, turnId, patch, before.profile.deletionEpoch);
  const after = await store.getContext(p.id);
  assert.equal(after.entities[0]!.id, id);
  assert.deepEqual(after.socialCircle.map(edge => edge.relation).sort(), ['cousin', 'friend']);
  assert.equal(after.profile.deletionEpoch, before.profile.deletionEpoch + 1);
  assert.equal((await store.applyPatch(p.id, turnId, patch, before.profile.deletionEpoch)).applied, false);
  assert.equal((await store.getContext(p.id)).profile.stateVersion, result.stateVersion);
  const changed = { ...patch, evidence: `${patch.evidence} ` };
  await assert.rejects(store.applyPatch(p.id, turnId, changed, after.profile.deletionEpoch), /idempotency_conflict/);
  const other = await profile();
  await assert.rejects(store.applyPatch(other.id, randomUUID(), patch, 0), /invalid_memory_patch/);
  assert.deepEqual(extractMemoryPatches('Is Lan my cousin, not my sister?', after), []);
});

test('offline favorite-color updates replace one slot while preserving ordinary color likes', async () => {
  const p = await profile();
  await learn(p.id, 'I like green.', [{ kind: 'preference', category: 'like', value: 'green', evidence: 'I like green' }]);
  let context = await store.getContext(p.id);
  const initial = 'My favorite color is blue.';
  assert.deepEqual(extractMemoryPatches(initial, context), [], 'A first ordinary favorite disclosure is not an immediate mutation directive.');
  await learn(p.id, initial, [{ kind: 'preference', category: 'like', value: 'blue', evidence: initial }]);
  context = await store.getContext(p.id);
  assert.equal(context.preferences.find(preference => preference.slot === 'favorite_color')?.value, 'blue');
  for (const text of ['My favorite color is turquoise.', 'Miu ơi, giờ màu mình thích nhất là xanh ngọc, không phải xanh lá nữa.']) {
    const patch = extractMemoryPatches(text, context).find(patch => patch.kind === 'preference')!;
    assert.ok(patch);
    await store.applyPatch(p.id, randomUUID(), patch, context.profile.deletionEpoch);
    context = await store.getContext(p.id);
  }
  assert.equal(context.preferences.filter(preference => preference.slot === 'favorite_color').length, 1);
  assert.equal(context.preferences.find(preference => preference.slot === 'favorite_color')!.value, 'xanh ngọc');
  assert.ok(context.preferences.some(preference => !preference.slot && preference.value === 'green'));
  assert.deepEqual(extractMemoryPatches('Did I say my favorite color is blue?', context), []);
  assert.deepEqual(extractMemoryPatches('Did I say my favorite color is now blue', context), [], 'Omitted punctuation cannot turn a question into update authority.');
  const now = extractMemoryPatches('My favorite color is now turquoise.', context).find(patch => patch.kind === 'preference');
  assert.equal(now?.kind === 'preference' ? now.value : null, 'turquoise');
  assert.deepEqual(extractMemoryPatches('My favorite color is not green.', context), []);
});

test('offline harness self-test: a first favorite waits for completed delivery and cancellation/questions do not capture it', async () => {
  // This intentionally injected double exercises receipt orchestration only.
  // Its replies are not evidence of model or character/memory quality.
  const candidate: MemoryCandidate = { kind: 'preference', category: 'like', value: 'blue', slot: 'favorite_color', evidence: 'My favorite color is blue' };
  const double: Provider = {
    mode: 'fake',
    async classify() { return { intent: 'share', language: 'en', statedFeeling: null, uncertain: false, uncertainty: null, correctionTarget: null, entityCorrection: null, candidates: [candidate], forgetTarget: null, suppressLearning: false }; },
    async reply(_prompt, plan) { return plan.exactText ?? 'Thank you for sharing that.'; },
    async check() { return { approved: true, violations: [] }; },
  };
  const app = new MiuApplication(store, double, () => wall.getTime());
  await app.bootstrap();
  const opened = await app.openSession('an'); const id = app.profileForToken(opened.demo_token);
  const request = { request_id: randomUUID(), kind: 'utterance' as const, text: 'My favorite color is blue.' };
  const response = await app.prepareTurn(id, opened.session_id, request);
  assert.equal((await app.getContext(id)).preferences.length, 0, 'Prepared output must not make an ordinary disclosure durable.');
  await app.cancel(id, opened.session_id, response.turn_id);
  assert.equal((await app.getContext(id)).preferences.length, 0, 'Canceled output must not capture the favorite.');
  const completed = await app.prepareTurn(id, opened.session_id, { ...request, request_id: randomUUID() });
  await app.playback(id, opened.session_id, completed.turn_id, { request_id: randomUUID(), status: 'started', state_version: completed.state_version });
  assert.equal((await app.getContext(id)).preferences.length, 0, 'Starting playback is insufficient.');
  await app.playback(id, opened.session_id, completed.turn_id, { request_id: randomUUID(), status: 'completed', state_version: completed.state_version });
  assert.equal((await app.getContext(id)).preferences.find(preference => preference.slot === 'favorite_color')?.value, 'blue');
  await app.closeSession(id, opened.session_id);
  const questionSession = await app.openSession('binh'); const otherId = app.profileForToken(questionSession.demo_token);
  const question = await app.prepareTurn(otherId, questionSession.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'Did I say My favorite color is blue?' });
  await app.playback(otherId, questionSession.session_id, question.turn_id, { request_id: randomUUID(), status: 'started', state_version: question.state_version });
  await app.playback(otherId, questionSession.session_id, question.turn_id, { request_id: randomUUID(), status: 'completed', state_version: question.state_version });
  assert.equal((await app.getContext(otherId)).preferences.length, 0, 'An extractor proposal cropped from a question has no assertion authority.');
  await app.closeSession(otherId, questionSession.session_id);
});

test('offline routine qualification retains relative timing and infers no clock time', async () => {
  const p = await profile();
  await learn(p.id, 'My routine is reading with Dad after dinner.', [{ kind: 'preference', category: 'routine', value: 'reading with Dad after dinner', evidence: 'My routine is reading with Dad after dinner' }]);
  const before = await store.getContext(p.id);
  const patch = extractMemoryPatches('Sometimes Dad is busy, so it is not a promise every day.', before)[0]!;
  await store.applyPatch(p.id, randomUUID(), patch, before.profile.deletionEpoch);
  const routine = (await store.getContext(p.id)).preferences[0]!;
  assert.equal(routine.id, before.preferences[0]!.id);
  assert.deepEqual(routine.qualifiers, { frequency: 'sometimes', timeRelation: 'after dinner' });
  assert.equal(routine.qualifiers?.exactTime, undefined);
});

test('offline nickname withdrawal stores child permission, not a third-person rename or old nickname', async () => {
  const p = await profile(); let context = await store.getContext(p.id);
  const grant = extractMemoryPatches('Hôm nay gọi mình Thuyền trưởng Chuối nhé. Tàu sắp đáp.', context)[0]!;
  await store.applyPatch(p.id, randomUUID(), grant, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference?.allowNickname, true);
  const withdraw = extractMemoryPatches('Đừng gọi mình là Thuyền trưởng Chuối nữa, gọi An thôi.', context)[0]!;
  assert.equal(withdraw.kind, 'address');
  await store.applyPatch(p.id, randomUUID(), withdraw, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.deepEqual(context.entities, []);
  assert.equal(context.addressPreference?.preferredAddress, 'An');
  assert.equal(context.addressPreference?.allowNickname, false);
  assert.equal(context.addressPreference?.nickname, null);
  const raw = (await store.db.query('SELECT * FROM address_preferences WHERE profile_id=$1', [p.id])).rows;
  assert.equal(JSON.stringify(raw).includes('Thuyền trưởng'), false);
  await store.forget(p.id, 'all', context.profile.deletionEpoch);
  assert.equal((await store.getContext(p.id)).addressPreference, null);
});

test('offline capture retains plush subtype and deduplicates equivalent story proposals', async () => {
  const p = await profile();
  await learn(p.id, 'Thỏ bông của mình tên là Bông.', [{ kind: 'entity', entityKind: 'object', name: 'Bông', species: null, evidence: 'Thỏ bông của mình tên là Bông' }]);
  let context = await store.getContext(p.id);
  assert.equal(context.entities[0]!.kind, 'object');
  assert.equal(context.entities[0]!.objectType, 'plush_toy');
  assert.equal(context.entities[0]!.represents, 'rabbit');
  const text = 'My story is called "Paper Moon": Pip rides a paper boat.';
  await learn(p.id, text, [
    { kind: 'story', title: 'Paper Moon', summary: 'Pip rides a paper boat.', castNames: ['Pip'], evidence: text },
    { kind: 'story', title: 'Paper Moon', summary: 'Pip rides a paper boat', castNames: [], evidence: text },
  ]);
  context = await store.getContext(p.id);
  assert.equal(context.stories.length, 1);
  assert.deepEqual(context.stories[0]!.castNames, ['Pip']);
});
