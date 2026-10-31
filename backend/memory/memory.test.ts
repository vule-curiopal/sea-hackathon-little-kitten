import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMemoryStore, migrate, type MemoryStore } from './index.js';
import { atLocalHour, dateDifference } from './clock.js';
import { PERSONALITIES, type MemoryCandidate } from '../shared/types.js';

let wall = new Date('2026-10-31T03:00:00Z');
let store: MemoryStore;
before(async () => { store = await createMemoryStore({ now: () => new Date(wall), clockMode: 'demo' }); });
after(async () => { await store?.close(); });
async function profile(key: string) {
  return store.createProfile({ demoKey: key, displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
}
async function learn(profileId: string, candidates: MemoryCandidate[], turnId = randomUUID()) {
  const context = await store.getContext(profileId);
  return store.learn({ profileId, turnId, candidates, sourceText: candidates.map(candidate => candidate.evidence).join('. '), deletionEpoch: context.profile.deletionEpoch, localDate: context.clock.localDate });
}
const puddle: MemoryCandidate[] = [
  { kind: 'entity', entityKind: 'pet', name: 'Mochi', species: 'dog', evidence: 'My dog Mochi' },
  { kind: 'event', subjectName: 'Mochi', eventType: 'fell_in_puddle', value: 'fell in a puddle', evidence: 'Mochi fell in a puddle' },
];

test('migrations are idempotent and all 16 personality presets persist', async () => {
  await migrate(store.db);
  const p = await profile('presets');
  for (const personality of PERSONALITIES) {
    const context = await store.updateConfig(p.id, { personality });
    assert.equal(context.config.personality, personality);
  }
  assert.equal((await store.getContext(p.id)).profile.displayName, 'An');
  await assert.rejects(store.updateConfig(p.id, { personality: 'XXXX' as never }), /invalid_personality/);
});

test('Mochi is learned once, next day creates an inferred question without a bath assertion', async () => {
  const p = await profile('mochi'); const turnId = randomUUID();
  const first = await learn(p.id, puddle, turnId);
  assert.equal(first.learnedIds.length, 2);
  assert.equal((await learn(p.id, puddle, turnId)).applied, false);
  let context = await store.getContext(p.id);
  assert.equal(context.entities[0]!.name, 'Mochi');
  assert.equal(context.events.length, 1);
  const next = await store.nextDay(p.id, randomUUID(), context.clock.version);
  assert.equal(next.daily.growthDays, 1);
  assert.equal(next.clock.effectiveNow, '2026-11-01T02:00:00.000Z');
  const hook = await store.reserveRecall(p.id, 'greeting');
  assert.equal(hook!.evidenceKind, 'inferred_question');
  assert.equal(hook!.question!.en, 'Did Mochi get a bath?');
  context = await store.getContext(p.id);
  assert.deepEqual(context.events.map((event) => event.eventType), ['fell_in_puddle']);
  await store.releaseRecall(p.id, 'greeting');
});

test('forgetting the bath hook deletes the source event while retaining pet identity', async () => {
  const p = await profile('forget-hook'); await learn(p.id, puddle);
  const clock = await store.getClock(p.id); await store.nextDay(p.id, randomUUID(), clock.version);
  const hook = await store.reserveRecall(p.id, 'greeting');
  const result = await store.forget(p.id, hook!.id, 0);
  assert.ok(result.deletedIds.includes(hook!.id));
  const context = await store.getContext(p.id);
  assert.equal(context.entities.length, 1); assert.equal(context.events.length, 0);
  await store.nextDay(p.id, randomUUID(), context.clock.version);
  assert.equal(await store.reserveRecall(p.id, 'again'), null);
});

test('offline storage contract rejects question evidence and retains bounded assertion provenance', async () => {
  const p = await profile('assertion-source'); await learn(p.id, [puddle[0]!]);
  const event: MemoryCandidate = { kind: 'event', subjectName: 'Mochi', eventType: 'reported_event', value: 'Mochi got a bath today', evidence: 'Mochi got a bath today' };
  const context = await store.getContext(p.id);
  const base = { profileId: p.id, localDate: context.clock.localDate, deletionEpoch: context.profile.deletionEpoch, candidates: [event] };
  await store.learn({ ...base, turnId: randomUUID(), sourceText: 'Did I tell you Mochi got a bath today?' });
  assert.equal((await store.getContext(p.id)).events.length, 0);
  const turnId = randomUUID();
  await store.learn({ ...base, turnId, sourceText: 'Mochi got a bath today.' });
  const source = (await store.getContext(p.id)).events[0]!.source!;
  assert.equal(source.turnId, turnId); assert.equal(source.clause, 'Mochi got a bath today.');
  assert.equal(source.speechAct, 'assertion'); assert.equal(source.polarity, 'affirmed');
});
test('offline event retraction cascades hooks, enforces profile scope, and preserves unrelated memory', async () => {
  const p = await profile('retract-source'); const other = await profile('retract-other');
  await learn(p.id, puddle);
  const before = await store.getContext(p.id); const eventId = before.events[0]!.id;
  await store.nextDay(p.id, randomUUID(), before.clock.version);
  const hook = await store.reserveRecall(p.id, 'fixture-hook');
  await assert.rejects(store.retractEvent(other.id, eventId, 0), /memory_not_found/);
  const result = await store.retractEvent(p.id, eventId, before.profile.deletionEpoch);
  assert.ok(result.deletedIds.includes(hook!.id));
  const after = await store.getContext(p.id);
  assert.equal(after.entities[0]?.name, 'Mochi'); assert.equal(after.events.length, 0);
  assert.equal(await store.reserveRecall(p.id, 'fixture-after'), null);
  await assert.rejects(store.learn({ profileId: p.id, sourceText: 'My dog Mochi fell in a puddle', turnId: randomUUID(), localDate: after.clock.localDate, deletionEpoch: before.profile.deletionEpoch, candidates: puddle }), /stale_state/);
});

test('entity deletion clears events and derived hooks and blocks stale learning', async () => {
  const p = await profile('forget-entity'); await learn(p.id, puddle);
  const context = await store.getContext(p.id);
  const result = await store.forget(p.id, context.entities[0]!.id, context.profile.deletionEpoch);
  assert.equal(result.deletedIds.length, 2);
  await assert.rejects(store.learn({ profileId: p.id, turnId: randomUUID(), sourceText: 'My dog Mochi fell in a puddle', localDate: context.clock.localDate, deletionEpoch: 0, candidates: puddle }), /stale_state/);
  assert.equal((await store.getContext(p.id)).entities.length, 0);
});

test('profile isolation is enforced in reads, deletion, and foreign keys', async () => {
  const a = await profile('scope-a'); const b = await profile('scope-b'); await learn(a.id, puddle);
  const aContext = await store.getContext(a.id);
  assert.equal((await store.getContext(b.id)).entities.length, 0);
  await assert.rejects(store.forget(b.id, aContext.entities[0]!.id), /memory_not_found/);
  await assert.rejects(store.db.query('INSERT INTO entity_aliases(profile_id,entity_id,alias) VALUES($1,$2,$3)', [b.id, aContext.entities[0]!.id, 'Wrong profile']));
});

test('child hobbies, dislikes, self descriptions, everyday fears and social circle preserve proper names', async () => {
  const p = await profile('child-profile');
  await learn(p.id, [
    { kind: 'preference', category: 'hobby', value: 'drawing', evidence: 'I enjoy drawing' },
    { kind: 'preference', category: 'dislike', value: 'broccoli', evidence: 'I dislike broccoli' },
    { kind: 'preference', category: 'self_description', value: 'creative', evidence: 'I am creative' },
    { kind: 'preference', category: 'fear', value: 'thunder', evidence: 'I am afraid of thunder' },
    { kind: 'preference', category: 'story_preference', value: 'dragon stories', evidence: 'I like dragon stories' },
    { kind: 'relationship', name: 'Bảo Ngọc', relation: 'friend', evidence: 'Bạn của mình tên là Bảo Ngọc' },
    { kind: 'relationship', name: 'Lan', relation: 'sibling', evidence: 'My sister is Lan' },
  ]);
  const context = await store.getContext(p.id);
  assert.equal(context.preferences.length, 5);
  assert.equal(context.socialCircle.length, 2);
  assert.ok(context.entities.some((entity) => entity.name === 'Bảo Ngọc'));
  const person = context.entities.find((entity) => entity.name === 'Lan')!;
  await store.forget(p.id, person.id);
  assert.deepEqual((await store.getContext(p.id)).socialCircle.map((person) => person.name), ['Bảo Ngọc']);
});

test('unsupported inferred facts and sensitive disclosures are never persisted', async () => {
  const p = await profile('evidence');
  await learn(p.id, [
    { kind: 'preference', category: 'self_description', value: 'introverted', evidence: 'I like quiet games' },
    { kind: 'preference', category: 'like', value: 'password 1234567', evidence: 'I like password 1234567' },
    { kind: 'preference', category: 'fear', value: 'my father hitting me', evidence: 'I am afraid of my father hitting me' },
    { kind: 'entity', entityKind: 'pet', name: 'Bong', species: 'dog', evidence: 'My dog has an unclear name' },
    { kind: 'relationship', name: 'Bông', relation: 'grandparent', evidence: 'Thỏ bông của mình tên là Bông' },
  ]);
  const context = await store.getContext(p.id);
  assert.equal(context.entities.length, 0); assert.equal(context.preferences.length, 0);
});

test('child stories retain named fictional cast and cascade when that character is forgotten', async () => {
  const p = await profile('stories');
  await learn(p.id, [{ kind: 'story', title: 'Moon Hare', summary: 'Moon Hare and Pip sail away', castNames: ['Moon Hare', 'Pip'], evidence: 'My story is Moon Hare. Moon Hare and Pip sail away.' }]);
  let context = await store.getContext(p.id);
  assert.equal(context.stories.length, 1);
  assert.equal(context.entities.filter((entity) => entity.kind === 'story_character').length, 2);
  await store.forget(p.id, context.entities.find((entity) => entity.name === 'Moon Hare')!.id);
  context = await store.getContext(p.id);
  assert.equal(context.stories.length, 0);
});

test('story previews do not commit and completed transitions resume the exact next chapter', async () => {
  const p = await profile('checkpoint');
  assert.equal((await store.previewStory(p.id, 'start')).chapter, 0);
  let context = await store.getContext(p.id);
  assert.equal(context.storyProgress, null);
  const firstTurn = randomUUID();
  await store.learn({ profileId: p.id, turnId: firstTurn, sourceText: '', candidates: [], deletionEpoch: 0, localDate: context.clock.localDate, storyTransition: 'start' });
  assert.equal((await store.getContext(p.id)).storyProgress!.chapter, 0);
  assert.equal((await store.previewStory(p.id, 'continue')).chapter, 1);
  context = await store.getContext(p.id);
  await store.learn({ profileId: p.id, turnId: randomUUID(), sourceText: '', candidates: [], deletionEpoch: 0, localDate: context.clock.localDate, storyTransition: 'continue' });
  assert.equal((await store.getContext(p.id)).storyProgress!.chapter, 1);
});

test('daily growth and next day are idempotent and do not advance friendship', async () => {
  const p = await profile('growth'); const clock = await store.getClock(p.id); const request = randomUUID();
  const first = await store.nextDay(p.id, request, clock.version);
  const retry = await store.nextDay(p.id, request, clock.version);
  assert.equal(retry.clock.version, first.clock.version);
  assert.equal(retry.daily.growthDays, 1);
  await assert.rejects(store.nextDay(p.id, randomUUID(), clock.version), /stale_clock/);
  assert.equal((await store.runNightJob(p.id)).applied, false);
  const context = await store.getContext(p.id);
  assert.equal(context.friendship, 'getting_acquainted');
  assert.notEqual(context.daily.diary.templateId, 'cardboard-fort');
  assert.equal(context.daily.storyEpisode.chapter, 2);
  const count = await store.db.query('SELECT count(*)::integer count FROM daily_states WHERE profile_id=$1', [p.id]);
  assert.equal(count.rows[0]!.count, 1);
});

test('failed rollover transaction leaves both daily state and clock unchanged', async () => {
  const p = await profile('rollback'); const before = await store.getContext(p.id);
  // Force the real rollover's unique-date write to fail after growth processing.
  const conflict = randomUUID();
  await store.db.query(`INSERT INTO memory_records(id,profile_id,kind,source_turn_id,candidate_key,evidence_kind,scope,created_at,expires_at)
    VALUES($1,$2,'diary','fault','diary','approved_fiction','fictional',$3,$4)`, [conflict, p.id, wall.toISOString(), new Date(wall.getTime() + 86_400_000).toISOString()]);
  await store.db.query('INSERT INTO diary_entries(profile_id,id,local_date,template_id) VALUES($1,$2,$3,$4)', [p.id, conflict, '2026-11-01', 'conflict']);
  await assert.rejects(store.nextDay(p.id, randomUUID(), before.clock.version));
  assert.equal((await store.getClock(p.id)).version, before.clock.version);
  assert.equal((await store.getContext(p.id)).daily.growthDays, 0);
  await store.db.query('DELETE FROM memory_records WHERE profile_id=$1 AND id=$2', [p.id, conflict]);
});

test('IANA calendar conversion observes DST rather than assuming 24-hour days', () => {
  const first = atLocalHour('2026-10-31', 'America/New_York');
  const next = atLocalHour('2026-11-01', 'America/New_York');
  assert.equal((next.getTime() - first.getTime()) / 3_600_000, 25);
  assert.equal(dateDifference('2026-10-31', '2026-11-02'), 2);
});

test('same-day personal expiry revokes captured response versions and cascades dependent events', async () => {
  const p = await profile('expiry-response'); await learn(p.id, puddle);
  const captured = await store.getContext(p.id);
  const original = wall;
  await store.db.query('UPDATE memory_records SET expires_at=$3 WHERE profile_id=$1 AND id=$2', [p.id, captured.entities[0]!.id, new Date(wall.getTime() + 1_000).toISOString()]);
  wall = new Date(wall.getTime() + 2_000);
  try {
    const current = await store.getContext(p.id);
    assert.equal(current.clock.localDate, captured.clock.localDate, 'no rollover can mask the expiry invalidation');
    assert.equal(current.profile.stateVersion, captured.profile.stateVersion + 1);
    assert.equal(current.profile.deletionEpoch, captured.profile.deletionEpoch + 1);
    assert.equal(current.entities.length, 0);
    assert.equal(current.events.length, 0);
    const replay = await store.getContext(p.id);
    assert.equal(replay.profile.deletionEpoch, current.profile.deletionEpoch, 'cleanup is idempotent');
  } finally { wall = original; }
});

test('learning cannot reinsert an expired source and commits revocation before reporting stale input', async () => {
  const p = await profile('expiry-learning');
  const candidate: MemoryCandidate = { kind: 'preference', category: 'hobby', value: 'drawing', evidence: 'I enjoy drawing' };
  await learn(p.id, [candidate]);
  const captured = await store.getContext(p.id); const original = wall;
  await store.db.query('UPDATE memory_records SET expires_at=$3 WHERE profile_id=$1 AND id=$2', [p.id, captured.preferences[0]!.id, new Date(wall.getTime() + 1_000).toISOString()]);
  wall = new Date(wall.getTime() + 2_000);
  try {
    await assert.rejects(store.learn({ profileId: p.id, turnId: randomUUID(), sourceText: candidate.evidence, localDate: captured.clock.localDate, deletionEpoch: captured.profile.deletionEpoch, candidates: [candidate] }), /stale_state/);
    // Read the committed database directly: a later getContext must not be the
    // operation that finally removes the old source or advances its epoch.
    const row = (await store.db.query('SELECT deletion_epoch,state_version FROM profiles WHERE id=$1', [p.id])).rows[0]!;
    assert.equal(row.deletion_epoch, captured.profile.deletionEpoch + 1);
    assert.equal(row.state_version, captured.profile.stateVersion + 1);
    assert.equal((await store.db.query('SELECT id FROM facts WHERE profile_id=$1', [p.id])).rows.length, 0);
  } finally { wall = original; }
});

test('independent authored diary expiry does not revoke personal memory snapshots', async () => {
  const p = await profile('expiry-diary'); const captured = await store.getContext(p.id); const original = wall;
  await store.db.query("UPDATE memory_records SET expires_at=$2 WHERE profile_id=$1 AND kind='diary'", [p.id, new Date(wall.getTime() + 1_000).toISOString()]);
  wall = new Date(wall.getTime() + 2_000);
  try {
    const current = await store.getContext(p.id);
    assert.equal(current.profile.stateVersion, captured.profile.stateVersion);
    assert.equal(current.profile.deletionEpoch, captured.profile.deletionEpoch);
    assert.equal(current.daily.diary.templateId, captured.daily.diary.templateId);
  } finally { wall = original; }
});

test('conflicting pet species with the same proper name requires clarification and rolls back the whole turn', async () => {
  const p = await profile('same-name'); await learn(p.id, puddle);
  const before = await store.getContext(p.id);
  const duplicate = await learn(p.id, [{ kind: 'entity', entityKind: 'pet', name: 'MOCHI', species: 'dog', evidence: 'My dog MOCHI' }]);
  assert.deepEqual(duplicate.learnedIds, [before.entities[0]!.id]);
  await assert.rejects(learn(p.id, [
    { kind: 'entity', entityKind: 'pet', name: 'Maple', species: 'dog', evidence: 'My dog Maple' },
    { kind: 'entity', entityKind: 'pet', name: 'Mochi', species: 'cat', evidence: 'My cat Mochi' },
  ]), /ambiguous_name/);
  const current = await store.getContext(p.id);
  assert.deepEqual(current.entities.map((entity) => [entity.name, entity.species]), [['Mochi', 'dog']]);
  assert.equal(current.events.length, 1);
});

test('privacy expiry uses real time and daily catch-up creates no spoken backlog', async () => {
  const p = await profile('retention'); await learn(p.id, puddle);
  const original = wall;
  wall = new Date(original.getTime() + 31 * 86_400_000);
  try {
    const context = await store.getContext(p.id);
    assert.equal(context.entities.length, 0); assert.equal(context.events.length, 0);
    assert.equal(context.daily.growthDays, 31);
    assert.equal(context.friendship, 'getting_acquainted');
    assert.equal(await store.reserveRecall(p.id, 'late'), null);
    assert.equal((await store.db.query('SELECT count(*)::integer count FROM daily_states WHERE profile_id=$1', [p.id])).rows[0]!.count, 1);
  } finally { wall = original; }
});
