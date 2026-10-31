import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createDatabase, createMemoryStore, MemoryStore } from './index.js';
import { extractMemoryPatches } from './patches.js';
import { canonicalPreferenceKey } from './normalization.js';
import { extractLearningActivity } from '../character/learning-activity.js';
import type { LearningInput, MemoryCandidate } from '../shared/types.js';

// Offline storage/evidence/lifecycle contract checks. No provider is used and
// these results are not evidence of real-model memory or character quality.
const initialWall = '2026-11-01T02:00:00.000Z';
let wall = new Date(initialWall);
let store: MemoryStore;
before(async () => { store = await createMemoryStore({ now: () => new Date(wall) }); });
beforeEach(() => { wall = new Date(initialWall); });
after(async () => { await store.close(); });
const profile = () => store.createProfile({ demoKey: `scope-${randomUUID()}`, displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
async function learn(profileId: string, sourceText: string, candidates: MemoryCandidate[] = [], learningActivity?: LearningInput['learningActivity']) {
  const context = await store.getContext(profileId);
  const input: LearningInput = { profileId, turnId: randomUUID(), sourceText, candidates, deletionEpoch: context.profile.deletionEpoch, localDate: context.clock.localDate, ...(learningActivity ? { learningActivity } : {}) };
  return { input, result: await store.learn(input) };
}

test('offline storage: hobby reconfirmation keeps the original ID, display and source, without conflating still life', async () => {
  const p = await profile();
  const original = 'I enjoy drawing rockets.';
  await learn(p.id, original, [{ kind: 'preference', category: 'hobby', value: 'drawing rockets', evidence: original }]);
  const before = (await store.getContext(p.id)).preferences[0]!;
  assert.equal(before.expiresAt, null);
  const source = (await store.db.query('SELECT source_evidence FROM facts WHERE profile_id=$1 AND id=$2', [p.id, before.id])).rows[0]!.source_evidence;
  wall = new Date(wall.getTime() + 86_400_000);
  const repeated = 'My hobby is still drawing rockets.';
  const { input } = await learn(p.id, repeated, [{ kind: 'preference', category: 'hobby', value: 'still drawing rockets', evidence: repeated }]);
  const after = (await store.getContext(p.id)).preferences;
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, before.id);
  assert.equal(after[0]!.value, before.value);
  assert.equal(after[0]!.expiresAt, null);
  const dates = (await store.db.query(`SELECT learned_local_date::text AS learned_date,
    last_reconfirmed_local_date::text AS reconfirmed_date FROM memory_records WHERE profile_id=$1 AND id=$2`, [p.id, before.id])).rows[0]!;
  assert.equal(dates.learned_date, '2026-11-01');
  assert.equal(dates.reconfirmed_date, '2026-11-02');
  assert.deepEqual((await store.db.query('SELECT source_evidence FROM facts WHERE profile_id=$1 AND id=$2', [p.id, before.id])).rows[0]!.source_evidence, source);
  assert.equal((await store.learn(input)).applied, false);
  assert.notEqual(canonicalPreferenceKey('hobby', 'still life painting'), canonicalPreferenceKey('hobby', 'life painting'));
  assert.notEqual(canonicalPreferenceKey('like', 'still drawing rockets'), canonicalPreferenceKey('like', 'drawing rockets'));
  await learn(p.id, 'My hobby is still life painting.', [{ kind: 'preference', category: 'hobby', value: 'still life painting', evidence: 'My hobby is still life painting.' }]);
  assert.equal((await store.getContext(p.id)).preferences.length, 2);
});

test('offline storage: today nickname expires with local day, independently of retention, and cannot replay', async () => {
  const p = await profile();
  let context = await store.getContext(p.id);
  const patch = extractMemoryPatches('Hôm nay gọi mình Thuyền trưởng Chuối nhé. Tàu sắp đáp.', context)[0]!;
  assert.equal(patch.kind, 'address');
  const requestId = randomUUID();
  await store.applyPatch(p.id, requestId, patch, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference?.scope, 'day');
  assert.equal(context.addressPreference?.validLocalDate, context.clock.localDate);
  assert.equal(context.addressPreference?.allowNickname, true);
  assert.equal(context.addressPreference?.expiresAt, null, 'Saved storage lifetime does not extend a day-scoped permission.');
  assert.equal((await store.applyPatch(p.id, requestId, patch, 0)).applied, false);
  const epoch = context.profile.deletionEpoch;
  await store.nextDay(p.id, randomUUID(), context.clock.version);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference, null);
  assert.equal(context.profile.deletionEpoch, epoch + 1);
  assert.equal((await store.db.query('SELECT id FROM address_preferences WHERE profile_id=$1', [p.id])).rows.length, 0);
  await assert.rejects(store.applyPatch(p.id, requestId, patch, epoch), /stale_state/);
  const denial = extractMemoryPatches('No nicknames today.', context)[0]!;
  assert.equal(denial.kind, 'address');
  if (denial.kind !== 'address') throw new Error('Expected address patch');
  assert.equal(denial.scope, 'day');
  assert.equal(denial.allowNickname, false);
});

test('offline storage: session nickname is usable only in the actual granting session', async () => {
  const p = await profile();
  const context = await store.getContext(p.id);
  const text = 'Please call me Comet in this chat.';
  assert.deepEqual(extractMemoryPatches(text, context), [], 'Session scope requires an actual application session ID.');
  const patch = extractMemoryPatches(text, context, 'session-a')[0]!;
  assert.equal(patch.kind, 'address');
  const turnId = randomUUID();
  await store.applyPatch(p.id, turnId, patch, context.profile.deletionEpoch, 'session-a');
  assert.equal((await store.getContext(p.id, 'session-a')).addressPreference?.preferredAddress, 'Comet');
  assert.equal((await store.getContext(p.id, 'session-a')).addressPreference?.scope, 'session');
  assert.equal((await store.getContext(p.id, 'session-b')).addressPreference, null);
  assert.equal((await store.getContext(p.id)).addressPreference, null);
  await assert.rejects(store.applyPatch(p.id, turnId, patch, context.profile.deletionEpoch, 'session-b'), /stale_state/);
  if (patch.kind !== 'address') throw new Error('Expected address patch');
  await assert.rejects(store.applyPatch(p.id, randomUUID(), { ...patch, scope: 'persistent', sessionId: undefined }, (await store.getContext(p.id)).profile.deletionEpoch, 'session-a'), /invalid_memory_patch/);
});

test('offline storage: ordinary address persists across days and explicit nickname denial needs no old grant', async () => {
  const p = await profile();
  let context = await store.getContext(p.id);
  const denial = extractMemoryPatches('No nicknames, please.', context)[0]!;
  await store.applyPatch(p.id, randomUUID(), denial, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference?.allowNickname, false);
  const grant = extractMemoryPatches('Call me Comet.', context)[0]!;
  await store.applyPatch(p.id, randomUUID(), grant, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference?.scope, 'persistent');
  assert.equal(context.addressPreference?.expiresAt, null);
  await store.nextDay(p.id, randomUUID(), context.clock.version);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference?.preferredAddress, 'Comet');
  assert.equal(context.addressPreference?.expiresAt, null);
  const withdrawal = extractMemoryPatches('Do not call me Comet anymore. Call me An.', context)[0]!;
  await store.applyPatch(p.id, randomUUID(), withdrawal, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.equal(context.addressPreference?.preferredAddress, 'An');
  assert.equal(context.addressPreference?.nickname, null);
  assert.equal(context.addressPreference?.scope, 'persistent');
  assert.deepEqual(extractMemoryPatches('Do not call my Dad.', context), [], 'Third-party contact boundaries do not change child naming permission.');
});

test('offline storage: a completed reading checkpoint keeps the task topic, never inability or assistant prose', async () => {
  const p = await profile();
  const source = 'I cannot read butterfly. Too many letters.';
  const activity = extractLearningActivity(source, 'en')!;
  const { input, result } = await learn(p.id, source, [], activity);
  const context = await store.getContext(p.id);
  assert.equal(context.learningActivities?.length, 1);
  const checkpoint = context.learningActivities![0]!;
  assert.equal(checkpoint.term, 'butterfly');
  assert.equal(checkpoint.focus, 'reading');
  assert.equal(checkpoint.sourceTurnId, input.turnId);
  assert.equal(checkpoint.id, result.learnedIds[0]);
  assert.equal(checkpoint.expiresAt, null);
  assert.deepEqual(context.preferences, []);
  const raw = (await store.db.query('SELECT * FROM activity_checkpoints WHERE profile_id=$1', [p.id])).rows[0]!;
  assert.equal(JSON.stringify(raw).includes('cannot'), false);
  assert.equal(JSON.stringify(raw).includes('Too many'), false);
  assert.deepEqual(raw.source_evidence, { kind: 'child_task_request', term: 'butterfly', start: 14, end: 23, turnId: input.turnId });
  assert.equal((await store.learn(input)).applied, false);
  wall = new Date(wall.getTime() + 86_400_000);
  const next = 'Help me read butterfly.';
  const updated = await learn(p.id, next, [], extractLearningActivity(next, 'en')!);
  const after = (await store.getContext(p.id)).learningActivities!;
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, checkpoint.id);
  assert.equal(after[0]!.sourceTurnId, updated.input.turnId);
  assert.equal(after[0]!.expiresAt, null);
  const dates = (await store.db.query(`SELECT learned_local_date::text AS learned_date,
    last_reconfirmed_local_date::text AS reconfirmed_date FROM memory_records WHERE profile_id=$1 AND id=$2`, [p.id, checkpoint.id])).rows[0]!;
  assert.equal(dates.learned_date, '2026-11-01');
  assert.equal(dates.reconfirmed_date, '2026-11-02');
  const other = await profile();
  assert.deepEqual((await store.getContext(other.id)).learningActivities, []);
});

test('offline storage: cropped, suppressed or assistant-derived task proposals cannot create a checkpoint', async () => {
  const p = await profile();
  const proposal = { kind: 'word_practice', term: 'butterfly', focus: 'reading', language: 'en' } as const;
  for (const text of ['Do not save this. Help me read butterfly.', 'Mum said I cannot read butterfly.', 'Did I say I cannot read butterfly?', 'Miu said butterfly has wings.', 'If I cannot read butterfly, Mum can help.']) {
    await learn(p.id, text, [], proposal);
  }
  await learn(p.id, 'Help me read dragon.', [], proposal);
  assert.deepEqual((await store.getContext(p.id)).learningActivities, []);
});

test('offline storage: checkpoints survive age and respect deletion epoch and personal-name dependency closure', async () => {
  const p = await profile();
  await learn(p.id, 'My dog is Rumi.', [{ kind: 'entity', entityKind: 'pet', name: 'Rumi', species: 'dog', evidence: 'My dog is Rumi.' }]);
  const named = 'Help me read Rumi.';
  await learn(p.id, named, [], extractLearningActivity(named, 'en')!);
  const generic = 'Help me read butterfly.';
  await learn(p.id, generic, [], extractLearningActivity(generic, 'en')!);
  let context = await store.getContext(p.id);
  await store.forget(p.id, context.entities[0]!.id, context.profile.deletionEpoch);
  context = await store.getContext(p.id);
  assert.deepEqual(context.learningActivities?.map(activity => activity.term), ['butterfly']);
  const checkpoint = context.learningActivities![0]!;
  assert.equal(checkpoint.expiresAt, null);
  wall = new Date(wall.getTime() + 29 * 86_400_000);
  assert.equal((await store.getContext(p.id)).learningActivities![0]!.expiresAt, null, 'Reading leaves durable storage unchanged.');
  wall = new Date(wall.getTime() + 2 * 86_400_000);
  const aged = await store.getContext(p.id);
  assert.deepEqual(aged.learningActivities?.map(activity => activity.id), [checkpoint.id]);
  assert.equal(aged.profile.deletionEpoch, context.profile.deletionEpoch);
  assert.equal((await store.db.query('SELECT last_reconfirmed_local_date::text AS reconfirmed_date FROM memory_records WHERE profile_id=$1 AND id=$2', [p.id, checkpoint.id])).rows[0]!.reconfirmed_date, '2026-11-01', 'Passive reads do not reconfirm the source.');
  const current = await learn(p.id, generic, [], extractLearningActivity(generic, 'en')!);
  context = await store.getContext(p.id);
  await store.forget(p.id, 'all', context.profile.deletionEpoch);
  assert.deepEqual((await store.getContext(p.id)).learningActivities, []);
  await assert.rejects(store.learn({ ...current.input, turnId: randomUUID() }), /stale_state/);
});

test('offline migration: unknown legacy nickname duration is revoked conservatively', async () => {
  const db = await createDatabase();
  try {
    const directory = new URL('./migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql') && name < '009').sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
    const profileId = randomUUID(), recordId = randomUUID(), derivedId = randomUUID();
    await db.query("INSERT INTO profiles(id,demo_key,display_name,age_band,language_mode,timezone,created_at) VALUES($1,$2,'An','6-8','follow_child','Asia/Ho_Chi_Minh',$3)", [profileId, `legacy-${randomUUID()}`, wall.toISOString()]);
    await db.query("INSERT INTO memory_records(id,profile_id,kind,source_turn_id,candidate_key,evidence_kind,scope,created_at,expires_at) VALUES($1,$2,'preference','legacy','address','child_reported','reported_real',$3,$4)", [recordId, profileId, wall.toISOString(), new Date(wall.getTime() + 30 * 86_400_000).toISOString()]);
    await db.query("INSERT INTO address_preferences(profile_id,id,preferred_address,allow_nickname,nickname,source_evidence) VALUES($1,$2,'Captain Banana',true,'Captain Banana','{}')", [profileId, recordId]);
    await db.query('INSERT INTO relationship_states(profile_id,nickname_reference) VALUES($1,$2)', [profileId, recordId]);
    await db.query("INSERT INTO memory_records(id,profile_id,kind,source_turn_id,candidate_key,evidence_kind,scope,created_at,expires_at) VALUES($1,$2,'self_statement','legacy-derived','copy','child_reported','reported_real',$3,$4)", [derivedId, profileId, wall.toISOString(), new Date(wall.getTime() + 30 * 86_400_000).toISOString()]);
    await db.query('INSERT INTO memory_dependencies(profile_id,source_id,derived_id) VALUES($1,$2,$3)', [profileId, recordId, derivedId]);
    await db.exec(await readFile(new URL('009_scoped_permissions_and_learning_activities.sql', directory), 'utf8'));
    const row = (await db.query('SELECT * FROM address_preferences WHERE profile_id=$1', [profileId])).rows[0]!;
    assert.equal(row.preferred_address, 'An');
    assert.equal(row.allow_nickname, false);
    assert.equal(row.nickname, null);
    assert.equal(row.scope, 'persistent');
    assert.equal(JSON.stringify(row).includes('Captain Banana'), false);
    const profileRow = (await db.query('SELECT deletion_epoch,state_version FROM profiles WHERE id=$1', [profileId])).rows[0]!;
    assert.equal(profileRow.deletion_epoch, 1);
    assert.equal((await db.query('SELECT nickname_reference FROM relationship_states WHERE profile_id=$1', [profileId])).rows[0]!.nickname_reference, null);
    assert.equal((await db.query('SELECT id FROM memory_records WHERE profile_id=$1 AND id=$2', [profileId, derivedId])).rows.length, 0);
  } finally { await db.close(); }
});
