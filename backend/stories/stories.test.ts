import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateLocal } from '../character/validation.js';
import type { DirectorPlan } from '../shared/types.js';
import { storyAt, STORY } from '../memory/authored-life.js';
import { chooseStory, getStory, STORY_CATALOG, STORY_CATALOG_VERSION } from './index.js';
import { STORY_SETTINGS } from './settings.js';

test('catalog contains exactly 1,000 distinct complete stories in both languages', () => {
  assert.equal(STORY_CATALOG.length, 1_000);
  assert.equal(new Set(STORY_CATALOG.map(story => story.templateId)).size, 1_000);
  assert.equal(new Set(STORY_CATALOG.map(story => story.plotId)).size, 100);
  assert.equal(new Set(STORY_CATALOG.map(story => story.settingId)).size, 10);
  for (const language of ['en', 'vi'] as const) {
    assert.equal(new Set(STORY_CATALOG.map(story => story.title[language])).size, 1_000);
    assert.equal(new Set(STORY_CATALOG.map(story => story.scenes.map(scene => scene[language]).join('\n'))).size, 1_000);
  }
  for (const story of STORY_CATALOG) {
    const setting = STORY_SETTINGS.find(item => item.id === story.settingId)!;
    assert.equal(story.scenes.length, 4, story.templateId);
    assert.match(story.templateId, /^miu-[a-z0-9-]+-v1$/u);
    assert.ok(story.theme.length > 0);
    assert.ok(Object.isFrozen(story));
    for (const language of ['en', 'vi'] as const) {
      assert.ok(story.scenes[0]![language].includes(setting.place[language]), `${story.templateId} needs its setting in the narrative`);
      assert.ok(story.scenes.some(scene => scene[language].includes(setting.clue[language])), `${story.templateId} needs its setting's object`);
    }
    for (const scene of story.scenes) {
      assert.ok(scene.en.startsWith('In our pretend story, '));
      assert.ok(scene.vi.startsWith('Trong truyện tưởng tượng, '));
      assert.doesNotMatch(scene.en + scene.vi, /\{[^}]*\}|undefined|\bTODO\b/u);
    }
  }
});

test('all 8,000 localized chapters pass the existing youngest-age speech and policy gates', () => {
  const plan: DirectorPlan = {
    purpose: 'story', language: 'en', ageBand: '4-5', personality: 'ENFP', role: 'friend',
    emotion: 'curious', dailyMood: 'content', rhythm: 'daytime', delivery: 'gentle',
    allowGiggle: false, allowPurr: false, face: { expression: 'curious', gesture: 'head_tilt' },
    memoryReferenceId: null, allowedFacts: [], allowedQuestion: null, exactText: null,
    maxSentences: 2, maxQuestions: 1, ruleTrace: [], comfortActive: false,
  };
  const failures: string[] = [];
  for (const story of STORY_CATALOG) {
    for (const [index, scene] of story.scenes.entries()) {
      for (const language of ['en', 'vi'] as const) {
        const verdict = validateLocal(scene[language], { ...plan, language, exactText: scene[language] });
        if (!verdict.approved) failures.push(`${story.templateId} chapter ${index} ${language}: ${verdict.violations.join(', ')}: ${scene[language]}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('stable lookup, random choice, chapter bounds, and the legacy adventure resolve correctly', () => {
  for (const story of STORY_CATALOG) assert.equal(getStory(story.templateId), story);
  for (let index = 0; index < 100; index++) {
    const story = chooseStory();
    assert.equal(getStory(story.templateId), story);
  }
  assert.throws(() => getStory('does-not-exist'), /Unknown Miu story template/);
  const story = STORY_CATALOG.at(-1)!;
  assert.deepEqual(storyAt('checkpoint', 0, story.templateId).scene, story.scenes[0]);
  assert.equal(storyAt('checkpoint', 100, story.templateId).status, 'complete');
  assert.equal(storyAt('checkpoint', -10, story.templateId).chapter, 0);
  assert.deepEqual(storyAt('legacy', 0).scene, STORY.scenes[0]);
});

test('the committed JSON export contains every generated story and its full text', async () => {
  const artifact = JSON.parse(await readFile(new URL('./catalog.v1.json', import.meta.url), 'utf8'));
  assert.equal(artifact.version, STORY_CATALOG_VERSION);
  assert.equal(artifact.count, 1_000);
  assert.deepEqual(artifact.stories, STORY_CATALOG);
});
