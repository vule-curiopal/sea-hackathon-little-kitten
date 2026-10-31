import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MiuApplication } from '../application.js';
import { createMemoryStore } from '../memory/index.js';
import { createDatabase, migrate } from '../memory/database.js';
import { FakeProvider } from '../pipeline/providers.js';
import { getStory, STORY_CATALOG } from './index.js';

const now = () => new Date('2026-10-31T03:00:00.000Z');
const profileInput = (demoKey: string) => ({
  demoKey, displayName: 'An', ageBand: '4-5' as const,
  languageMode: 'en' as const, timezone: 'Asia/Ho_Chi_Minh',
});

test('assignment survives registration retries, settings, forgetting, rollover, and database restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'miu-stories-'));
  let store = await createMemoryStore({ dataDir: directory, now });
  try {
    const profile = await store.createProfile(profileInput('new-user'));
    const assigned = (await store.getContext(profile.id)).config.assignedStoryId!;
    assert.equal(getStory(assigned).templateId, assigned);
    const retry = await store.createProfile(profileInput('new-user'));
    assert.equal(retry.id, profile.id);
    assert.equal((await store.updateConfig(profile.id, { personality: 'ISTJ', languageMode: 'vi' })).config.assignedStoryId, assigned);
    await store.forget(profile.id, 'all');
    const clock = await store.getClock(profile.id);
    await store.nextDay(profile.id, randomUUID(), clock.version);
    assert.equal((await store.getContext(profile.id)).config.assignedStoryId, assigned);
    await store.close();
    store = await createMemoryStore({ dataDir: directory, now });
    assert.equal((await store.getContext(profile.id)).config.assignedStoryId, assigned);
    assert.equal((await store.previewStory(profile.id, 'start')).templateId, assigned);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('story previews do not write progress; completed playback advances the assigned story once', async () => {
  const store = await createMemoryStore({ now });
  try {
    const profile = await store.createProfile(profileInput('an'));
    const other = await store.createProfile(profileInput('binh'));
    const story = STORY_CATALOG.at(-1)!;
    // Exercise a known nonlegacy template, independent of which random story won.
    await store.db.query('UPDATE miu_configs SET assigned_story_id=$2 WHERE profile_id=$1', [profile.id, story.templateId]);
    const before = await store.db.query('SELECT * FROM memory_records WHERE profile_id=$1', [profile.id]);
    const preview = await store.previewStory(profile.id, 'start');
    assert.equal(preview.templateId, story.templateId);
    assert.deepEqual((await store.db.query('SELECT * FROM memory_records WHERE profile_id=$1', [profile.id])).rows, before.rows);
    assert.equal((await store.getContext(profile.id)).storyProgress, null);
    const app = new MiuApplication(store, new FakeProvider(), () => now().getTime());
    const session = await app.openSession('an');
    const abandoned = await app.prepareTurn(profile.id, session.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'Tell me a story' });
    assert.equal(abandoned.reply.text, story.scenes[0]!.en);
    await app.cancel(profile.id, session.session_id, abandoned.turn_id);
    assert.equal((await store.getContext(profile.id)).storyProgress, null);
    for (let chapter = 0; chapter < story.scenes.length; chapter++) {
      const response = await app.prepareTurn(profile.id, session.session_id, {
        request_id: randomUUID(), kind: 'utterance', text: chapter === 0 ? 'Tell me a story' : 'Continue the story',
      });
      assert.equal(response.reply.text, story.scenes[chapter]!.en);
      await app.playback(profile.id, session.session_id, response.turn_id, {
        request_id: randomUUID(), status: 'started', state_version: response.state_version,
      });
      const receipt = { request_id: randomUUID(), status: 'completed' as const, state_version: response.state_version };
      await app.playback(profile.id, session.session_id, response.turn_id, receipt);
      await app.playback(profile.id, session.session_id, response.turn_id, receipt);
      const saved = (await store.getContext(profile.id)).storyProgress!;
      assert.equal(saved.templateId, story.templateId);
      assert.equal(saved.chapter, chapter);
      assert.equal(saved.status, chapter === story.scenes.length - 1 ? 'complete' : 'active');
    }
    assert.equal((await store.getContext(other.id)).storyProgress, null);
    const restart = await app.openSession('an');
    const repeated = await app.prepareTurn(profile.id, restart.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'Tell me a story' });
    assert.equal(repeated.reply.text, story.scenes[0]!.en);
    await app.cancel(profile.id, restart.session_id, repeated.turn_id);
  } finally { await store.close(); }
});

test('migration preserves the original Moon Boat for profiles created before the catalog', async () => {
  const db = await createDatabase();
  try {
    await db.exec(await readFile(new URL('../memory/migrations/001_character_memory.sql', import.meta.url), 'utf8'));
    await db.exec('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)', ['001_character_memory.sql']);
    const id = randomUUID();
    await db.query("INSERT INTO profiles(id,demo_key,display_name,age_band,language_mode,timezone,created_at) VALUES($1,'legacy','An','4-5','en','Asia/Ho_Chi_Minh',$2)", [id, now().toISOString()]);
    await db.query("INSERT INTO miu_configs(profile_id,personality,role) VALUES($1,'ENFP','friend')", [id]);
    await migrate(db);
    await migrate(db);
    const config = (await db.query('SELECT assigned_story_id FROM miu_configs WHERE profile_id=$1', [id])).rows[0]!;
    assert.equal(config.assigned_story_id, 'moon-boat-v1');
  } finally { await db.close(); }
});
