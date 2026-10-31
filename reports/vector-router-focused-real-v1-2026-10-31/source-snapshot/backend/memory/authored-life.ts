import type { DailyState, Mood, StoryProgress } from '../shared/types.js';
import { getStory } from '../stories/index.js';

export const DIARY = [
  { templateId: 'cardboard-fort', en: 'In my pretend house, I made a tiny cardboard fort.', vi: 'Trong ngôi nhà tưởng tượng, Miu làm một pháo đài bìa nhỏ.' },
  { templateId: 'window-drops', en: 'In my pretend house, I imagined raindrops racing down the window.', vi: 'Trong ngôi nhà tưởng tượng, Miu tưởng tượng những giọt mưa đua trên cửa sổ.' },
  { templateId: 'ribbon-puzzle', en: 'In my pretend house, I untangled a ribbon puzzle.', vi: 'Trong ngôi nhà tưởng tượng, Miu gỡ một câu đố ruy băng.' },
  { templateId: 'moon-dream', en: 'In my pretend dream, a cushion became a moon boat.', vi: 'Trong giấc mơ tưởng tượng, chiếc gối của Miu biến thành thuyền mặt trăng.' },
  { templateId: 'shadow-butterfly', en: 'In my pretend house, I made a butterfly shadow with my paws.', vi: 'Trong ngôi nhà tưởng tượng, Miu dùng chân tạo bóng con bướm.' },
  { templateId: 'quiet-listening', en: 'In my pretend house, I practiced listening to a soft little bell.', vi: 'Trong ngôi nhà tưởng tượng, Miu tập nghe tiếng chuông khe khẽ.' },
];
export const EPISODES = [
  { templateId: 'lantern-1', en: 'In our pretend story, Miu and Pip the paper bird find a little lantern.', vi: 'Trong truyện tưởng tượng, Miu và chim giấy Pip tìm thấy một chiếc đèn nhỏ.' },
  { templateId: 'lantern-2', en: 'In our pretend story, Pip draws a map across the cushion hills.', vi: 'Trong truyện tưởng tượng, Pip vẽ bản đồ qua những đồi gối.' },
  { templateId: 'lantern-3', en: 'In our pretend story, Miu learns to cross a ribbon bridge slowly.', vi: 'Trong truyện tưởng tượng, Miu học cách chậm rãi qua cầu ruy băng.' },
  { templateId: 'lantern-4', en: 'In our pretend story, Pip and Miu listen before choosing a tunnel.', vi: 'Trong truyện tưởng tượng, Pip và Miu lắng nghe trước khi chọn đường hầm.' },
  { templateId: 'lantern-5', en: 'In our pretend story, Miu tries a new way to fold a paper boat.', vi: 'Trong truyện tưởng tượng, Miu thử cách mới để gấp thuyền giấy.' },
  { templateId: 'lantern-6', en: 'In our pretend story, Pip shares the lantern with a tiny paper snail.', vi: 'Trong truyện tưởng tượng, Pip chia sẻ chiếc đèn với một bạn ốc sên giấy nhỏ.' },
];
const THEMES = ['curiosity', 'imagination', 'patience', 'listening', 'trying', 'kindness'];
const MOODS: Mood[] = ['content', 'curious', 'mellow'];
export function authoredDay(localDate: string, growthDays: number): DailyState {
  const index = growthDays % DIARY.length;
  return {
    localDate, mood: MOODS[growthDays % MOODS.length]!, growthDays,
    growthTheme: THEMES[index]!, diary: DIARY[index]!,
    storyEpisode: { ...EPISODES[index]!, chapter: growthDays + 1 },
  };
}

export const STORY = {
  templateId: 'moon-boat-v1',
  title: { en: 'The Little Moon Boat', vi: 'Chiếc Thuyền Mặt Trăng Nhỏ' },
  scenes: [
    { en: 'In our pretend story, Miu finds a paper boat beside a pillow mountain. Shall we give it a tiny flag?', vi: 'Trong truyện tưởng tượng, Miu thấy thuyền giấy cạnh núi gối. Mình làm lá cờ nhỏ nhé?' },
    { en: 'In our pretend story, Miu and Pip sail to a soft cloud island. Shall we explore the sparkling path?', vi: 'Trong truyện tưởng tượng, Miu và Pip đến đảo mây mềm. Mình khám phá đường lấp lánh nhé?' },
    { en: 'In our pretend story, Miu finds a sleepy star and shares the boat. Shall we bring the star home?', vi: 'Trong truyện tưởng tượng, Miu thấy sao buồn ngủ và mời lên thuyền. Mình đưa sao về nhé?' },
    { en: 'In our pretend story, the star reaches its cozy home, and Miu waves goodnight. Our little adventure is complete.', vi: 'Trong truyện tưởng tượng, sao về nhà ấm áp và Miu chúc ngủ ngon. Chuyến phiêu lưu nhỏ đã xong.' },
  ],
};
export function storyAt(id: string, chapter: number, templateId = STORY.templateId): StoryProgress {
  const story = templateId === STORY.templateId ? STORY : getStory(templateId);
  const bounded = Math.min(Math.max(Number.isFinite(chapter) ? Math.trunc(chapter) : 0, 0), story.scenes.length - 1);
  return { id, templateId: story.templateId, chapter: bounded, status: bounded === story.scenes.length - 1 ? 'complete' : 'active', title: story.title, scene: story.scenes[bounded]! };
}
