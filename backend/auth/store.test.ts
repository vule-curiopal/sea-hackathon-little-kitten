import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../memory/index.js';
import type { Queryable, Row } from '../memory/database.js';
import { AppError } from '../shared/types.js';
import { AUTH_SESSION_LIFETIME_MS, AuthStore, normalizeUsername } from './store.js';

// Offline account persistence, isolation, credential and transaction contracts;
// these are not character or memory-model evaluations and make no model calls.
const PASSWORD = 'correct horse paper kitten';
const failure = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const start = Date.parse('2026-11-01T02:00:00Z');
async function fixture() {
  const memory = await createMemoryStore({ now: () => new Date(start), clockMode: 'demo' });
  let wall = start;
  const auth = new AuthStore(memory, { now: () => new Date(wall) });
  return { memory, auth, wall: (value: number) => { wall = value; } };
}

test('account registration uses an ASCII normalized username and an isolated generic character profile', async t => {
  const h = await fixture(); t.after(() => h.memory.db.close());
  const session = await h.auth.register(' Family.Test ', PASSWORD);
  assert.equal(session.user.username, 'family.test');
  assert.match(session.user.profile_key, /^user_[0-9a-f-]{36}$/u);
  assert.deepEqual(Object.keys(session.user).sort(), ['id', 'profile_key', 'username']);
  assert.equal(Buffer.from(session.token, 'base64url').length, 32);
  assert.equal(session.expiresAt, new Date(start + AUTH_SESSION_LIFETIME_MS).toISOString());
  assert.deepEqual(await h.auth.authenticate(session.token), session.user);
  const profile = await h.memory.findProfile(session.user.profile_key);
  assert.ok(profile);
  assert.equal(profile.displayName, 'Friend');
  assert.equal(profile.languageMode, 'vi');
  assert.equal(profile.ageBand, '6-8');
  assert.equal(profile.timezone, 'Asia/Ho_Chi_Minh');
  const context = await h.memory.getContext(profile.id);
  assert.equal(JSON.stringify(context).includes(session.user.username), false);
  assert.equal(JSON.stringify(context).includes(PASSWORD), false);
  const account = (await h.memory.db.query('SELECT * FROM user_accounts')).rows[0]!;
  const persisted = (await h.memory.db.query('SELECT * FROM auth_sessions')).rows[0]!;
  assert.notEqual(account.password_hash, PASSWORD);
  assert.equal(account.profile_id, profile.id);
  assert.equal(persisted.token_hash, createHash('sha256').update(session.token).digest('hex'));
  assert.equal(JSON.stringify([account, persisted]).includes(session.token), false);
});

test('public input validation is separate from generic login credential failures', async t => {
  const h = await fixture(); t.after(() => h.memory.db.close());
  for (const invalid of ['ab', 'a'.repeat(33), 'sam@example.com', 'Ｓａｍ', 'x y', '.sam', 'sam\nname', null]) {
    assert.throws(() => normalizeUsername(invalid), failure('invalid_username'));
    await assert.rejects(h.auth.register(invalid, PASSWORD), failure('invalid_username'));
  }
  await assert.rejects(h.auth.register('valid_user', '1'), failure('invalid_password'));
  const registered = await h.auth.register('valid_user', PASSWORD);
  for (const [name, password] of [['valid_user', 'wrong'], ['not_registered', PASSWORD], ['bad username', PASSWORD], ['valid_user', undefined]] as const) {
    await assert.rejects(h.auth.login(name, password), failure('invalid_credentials'));
  }
  const loggedIn = await h.auth.login(' VALID_USER ', PASSWORD);
  assert.deepEqual(loggedIn.user, registered.user);
  assert.notEqual(loggedIn.token, registered.token);
  assert.equal((await h.memory.db.query('SELECT id FROM user_accounts')).rows.length, 1);
});

test('opaque sessions revoke independently and expire at seven wall-clock days without sliding', async t => {
  const h = await fixture(); t.after(() => h.memory.db.close());
  const first = await h.auth.register('session_user', PASSWORD);
  const second = await h.auth.login('session_user', PASSWORD);
  await h.auth.revoke(first.token);
  assert.equal(await h.auth.authenticate(first.token), null);
  assert.deepEqual(await h.auth.authenticate(second.token), second.user);
  assert.equal(await h.auth.authenticate(second.token.slice(0, -1)), null);
  assert.equal(await h.auth.authenticate('not-a-session-token'), null);
  const profile = await h.memory.findProfile(second.user.profile_key);
  assert.ok(profile);
  const context = await h.memory.getContext(profile.id);
  await h.memory.nextDay(profile.id, randomUUID(), context.clock.version);
  assert.deepEqual(await h.auth.authenticate(second.token), second.user, 'Narrative next-day is not the authentication wall clock.');
  h.wall(start + AUTH_SESSION_LIFETIME_MS - 1);
  assert.deepEqual(await h.auth.authenticate(second.token), second.user);
  h.wall(start + AUTH_SESSION_LIFETIME_MS);
  assert.equal(await h.auth.authenticate(second.token), null);
  const expiry = (await h.memory.db.query('SELECT expires_at FROM auth_sessions')).rows[0]!.expires_at;
  assert.equal(new Date(String(expiry)).toISOString(), second.expiresAt, 'Authentication never refreshes the fixed expiry.');
});

test('concurrent duplicate usernames create exactly one complete account and no orphan character profile', async t => {
  const h = await fixture(); t.after(() => h.memory.db.close());
  const results = await Promise.allSettled([h.auth.register('same_user', PASSWORD), h.auth.register(' SAME_USER ', PASSWORD)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && failure('username_in_use')(rejected.reason));
  for (const table of ['profiles', 'user_accounts', 'auth_sessions', 'miu_configs']) {
    assert.equal((await h.memory.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count, 1, table);
  }
});

test('failure to store the initial session rolls back account and all profile creation', async t => {
  const h = await fixture(); t.after(() => h.memory.db.close());
  const original = h.memory.db.transaction.bind(h.memory.db);
  h.memory.db.transaction = async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => original(tx => work({
    exec: sql => tx.exec(sql),
    query: async <R = Row>(sql: string, values?: unknown[]) => {
      if (sql.startsWith('INSERT INTO auth_sessions')) throw new Error('auth_fixture_session_insert_failed');
      return tx.query<R>(sql, values);
    },
  }));
  try { await assert.rejects(h.auth.register('rollback_user', PASSWORD), /auth_fixture_session_insert_failed/u); }
  finally { h.memory.db.transaction = original; }
  for (const table of ['profiles', 'user_accounts', 'auth_sessions', 'miu_configs', 'daily_states', 'memory_records']) {
    assert.equal((await h.memory.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]!.count, 0, table);
  }
});

test('explicit sam/1 seed links the existing test profile without resetting data or an existing password', async t => {
  const h = await fixture(); t.after(() => h.memory.db.close());
  const profile = await h.memory.createProfile({ demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh' });
  const initial = await h.memory.getContext(profile.id);
  await h.memory.learn({ profileId: profile.id, turnId: randomUUID(), deletionEpoch: initial.profile.deletionEpoch, localDate: initial.clock.localDate,
    sourceText: 'I like paper folding.', candidates: [{ kind: 'preference', category: 'like', value: 'paper folding', evidence: 'I like paper folding.' }] });
  const before = await h.memory.getContext(profile.id);
  const seeded = await h.auth.seedTestAccount({ username: 'Sam', password: '1', profileKey: 'an' });
  assert.equal(seeded.username, 'sam');
  assert.equal(seeded.profile_key, 'an');
  assert.equal((await h.memory.db.query('SELECT * FROM auth_sessions')).rows.length, 0, 'Seeding does not sign in.');
  assert.deepEqual((await h.auth.login('sam', '1')).user, seeded);
  assert.deepEqual(await h.auth.seedTestAccount({ username: 'SAM', password: 'changed seed password', profileKey: 'an' }), seeded);
  await assert.rejects(h.auth.login('sam', 'changed seed password'), failure('invalid_credentials'));
  assert.deepEqual((await h.auth.login('sam', '1')).user, seeded);
  await assert.rejects(h.auth.register('another_user', '1'), failure('invalid_password'));
  await assert.rejects(h.auth.seedTestAccount({ username: 'other_account', password: '1', profileKey: 'an' }), failure('username_in_use'));
  const after = await h.memory.getContext(profile.id);
  assert.deepEqual(after.profile, before.profile);
  assert.deepEqual(after.preferences, before.preferences);
  assert.deepEqual(after.config, before.config);
});

test('accounts, password verification, and session revocation persist across database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'miu-auth-persistence-'));
  let memory = await createMemoryStore({ dataDir: join(directory, 'database'), now: () => new Date(start) });
  try {
    let auth = new AuthStore(memory, { now: () => new Date(start) });
    const first = await auth.register('persistent_user', PASSWORD);
    await memory.db.close();
    memory = await createMemoryStore({ dataDir: join(directory, 'database'), now: () => new Date(start) });
    auth = new AuthStore(memory, { now: () => new Date(start) });
    assert.deepEqual(await auth.authenticate(first.token), first.user);
    assert.deepEqual((await auth.login('PERSISTENT_USER', PASSWORD)).user, first.user);
    await auth.revoke(first.token);
    await memory.db.close();
    memory = await createMemoryStore({ dataDir: join(directory, 'database'), now: () => new Date(start) });
    assert.equal(await new AuthStore(memory, { now: () => new Date(start) }).authenticate(first.token), null);
  } finally { await memory.db.close(); await rm(directory, { recursive: true, force: true }); }
});
