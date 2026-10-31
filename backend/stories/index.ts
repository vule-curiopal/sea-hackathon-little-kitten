import { randomInt } from 'node:crypto';
import { PLOTS_A } from './plots-a.js';
import { PLOTS_B } from './plots-b.js';
import { STORY_SETTINGS } from './settings.js';
import type { BilingualText, StorySetting, StoryTemplate } from './types.js';

export type { BilingualText, StoryTemplate } from './types.js';

/** Stable IDs and content are versioned together; keep v1 available for saved users. */
export const STORY_CATALOG_VERSION = 'miu-stories-v1';

function freezeText(text: BilingualText): BilingualText {
  return Object.freeze(text);
}

const plots = [...PLOTS_A, ...PLOTS_B];
if (plots.length !== 100 || new Set(plots.map(plot => plot.id)).size !== 100) {
  throw new Error('The Miu story library requires 100 distinct authored plots.');
}
if (STORY_SETTINGS.length !== 10 || new Set(STORY_SETTINGS.map(setting => setting.id)).size !== 10) {
  throw new Error('The Miu story library requires 10 distinct pretend settings.');
}

function render(scene: BilingualText, setting: StorySetting, language: keyof BilingualText): string {
  const prose = scene[language]
    .replaceAll('{clue}', setting.clue[language])
    .replaceAll('{place}', setting.place[language]);
  // Preserve the proper names which begin most chapters.
  const initial = /^(Miu|Pip)\b/u.test(prose) ? prose : prose.charAt(0).toLocaleLowerCase(language) + prose.slice(1);
  const prefix = language === 'en' ? 'In our pretend story, ' : 'Trong truyện tưởng tượng, ';
  return prefix + initial;
}

/** Materialize complete prose once, never generate stories or call AI during signup. */
export const STORY_CATALOG: readonly StoryTemplate[] = Object.freeze(plots.flatMap(plot =>
  STORY_SETTINGS.map(setting => {
    const scenes = plot.scenes.map(scene => freezeText({ en: render(scene, setting, 'en'), vi: render(scene, setting, 'vi') }));
    return Object.freeze({
      templateId: `miu-${plot.id}-${setting.id}-v1`,
      title: freezeText({ en: `${plot.title.en} — ${setting.name.en}`, vi: `${plot.title.vi} — ${setting.name.vi}` }),
      theme: plot.theme,
      plotId: plot.id,
      settingId: setting.id,
      scenes: Object.freeze(scenes),
    });
  }),
));

const storiesById = new Map(STORY_CATALOG.map(story => [story.templateId, story]));

export function getStory(templateId: string): StoryTemplate {
  const story = storiesById.get(templateId);
  if (!story) throw new RangeError(`Unknown Miu story template: ${templateId}`);
  return story;
}

/** Uniform sampling with replacement: the pool keeps working after 1,000 users. */
export function chooseStory(): StoryTemplate {
  return STORY_CATALOG[randomInt(STORY_CATALOG.length)]!;
}
