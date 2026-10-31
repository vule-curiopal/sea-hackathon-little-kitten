import historyData from '../data/growth-history.json' with { type: 'json' };

export type GrowthMessage = { id: string; role: 'user' | 'assistant'; content: string };
export type GrowthSession = {
  id: string; date: string; title: string; age: number;
  language: 'vi' | 'en' | 'mixed'; tags: string[]; messages: GrowthMessage[];
};
export type GrowthHistory = {
  schemaVersion: string;
  provenance: { synthetic: true; responseOrigin: 'authored_reference'; source: string };
  profile: { id: string; name: string; ageAtStart: number; ageAtEnd: number; ageBand: string };
  period: { start: string; end: string; days: number; timezone: string };
  totals: { sessions: number; messages: number; exchanges: number };
  sessions: GrowthSession[];
};
export type GrowthMonthSummary = {
  month: string; sessions: GrowthSession[]; sessionCount: number; messageCount: number; exchangeCount: number;
  cumulativeSessions: number; cumulativeMessages: number; topics: { tag: string; count: number }[];
};
export type GrowthMilestone = {
  month: string; date: string;
  title: { en: string; vi: string }; description: { en: string; vi: string }; messageIds: string[];
};

export const growthHistory = historyData as GrowthHistory;
export const growthMonths = [...new Set(growthHistory.sessions.map(session => session.date.slice(0, 7)))].sort();

export function summarizeMonth(month: string): GrowthMonthSummary {
  const sessions = growthHistory.sessions.filter(session => session.date.slice(0, 7) === month);
  const messageCount = sessions.reduce((total, session) => total + session.messages.length, 0);
  const topics = new Map<string, number>();
  for (const session of sessions) for (const tag of session.tags) topics.set(tag, (topics.get(tag) ?? 0) + 1);
  const cumulative = growthHistory.sessions.filter(session => session.date.slice(0, 7) <= month);
  return {
    month, sessions, sessionCount: sessions.length, messageCount, exchangeCount: messageCount / 2,
    cumulativeSessions: cumulative.length,
    cumulativeMessages: cumulative.reduce((total, session) => total + session.messages.length, 0),
    topics: [...topics].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'en')),
  };
}

// Editorial descriptions of dated fictional dialogue. Each description is
// traceable to the original child messages; none is a learned-trait assessment.
export const growthMilestones: GrowthMilestone[] = [
  {
    month: '2025-11', date: '2025-11-01',
    title: { en: 'A first hello', vi: 'Lời chào đầu tiên' },
    description: { en: 'An introduces themself, shares a love of green, and turns a cardboard box into an imaginary rocket.', vi: 'An giới thiệu mình, kể về màu xanh lá yêu thích và biến hộp bìa thành tên lửa trong tưởng tượng.' },
    messageIds: ['an_2025-11-01_01_m01', 'an_2025-11-01_01_m05', 'an_2025-11-01_01_m07'],
  },
  {
    month: '2025-12', date: '2025-12-29',
    title: { en: 'One evening, a new order', vi: 'Một tối đổi thứ tự' },
    description: { en: 'For this evening, An talks through a changed routine: bath, clothes, dinner, then brushing teeth. Tomorrow is still undecided.', vi: 'Tối hôm đó, An nhắc lại thứ tự mới: tắm, mặc đồ, ăn rồi đánh răng. Ngày mai vẫn chưa được quyết định.' },
    messageIds: ['an_2025-12-29_01_m01', 'an_2025-12-29_01_m05', 'an_2025-12-29_01_m07'],
  },
  {
    month: '2026-01', date: '2026-01-25',
    title: { en: 'Some things can stay private', vi: 'Có những điều được giữ riêng' },
    description: { en: 'An shares the joy of a drawing while choosing to keep its picture and colors private.', vi: 'An chia sẻ niềm vui từ bức tranh nhưng chọn giữ riêng nội dung và màu sắc.' },
    messageIds: ['an_2026-01-25_01_m01', 'an_2026-01-25_01_m03', 'an_2026-01-25_01_m05'],
  },
  {
    month: '2026-02', date: '2026-02-15',
    title: { en: 'Two apples, please', vi: 'Two apples, please' },
    description: { en: 'In a pretend shop, An practices ordering in English and changes “two apple” to “two apples, please.”', vi: 'Trong cửa hàng tưởng tượng, An tập mua táo bằng tiếng Anh và sửa “two apple” thành “two apples, please.”' },
    messageIds: ['an_2026-02-15_01_m01', 'an_2026-02-15_01_m03', 'an_2026-02-15_01_m05'],
  },
  {
    month: '2026-03', date: '2026-03-12',
    title: { en: 'Little questions about floating', vi: 'Câu hỏi nhỏ về sự nổi' },
    description: { en: 'An describes testing a leaf and a stone with grandmother, then plans to try a paper boat in a basin.', vi: 'An kể chuyện thử thả lá và đá cùng bà, rồi muốn nhờ bà gấp thuyền giấy để thử trong chậu.' },
    messageIds: ['an_2026-03-12_01_m01', 'an_2026-03-12_01_m05', 'an_2026-03-12_01_m07'],
  },
  {
    month: '2026-04', date: '2026-04-07',
    title: { en: 'A green rocket, in two languages', vi: 'Tên lửa xanh qua hai ngôn ngữ' },
    description: { en: 'An describes a green rocket, practices English color words, and corrects the spelling of “green.”', vi: 'An kể về tên lửa xanh, tập từ chỉ màu sắc bằng tiếng Anh và sửa cách viết từ “green.”' },
    messageIds: ['an_2026-04-07_01_m01', 'an_2026-04-07_01_m03', 'an_2026-04-07_01_m07'],
  },
  {
    month: '2026-05', date: '2026-05-14',
    title: { en: 'Seven candles for An', vi: 'Bảy ngọn nến của An' },
    description: { en: 'An turns seven, reports celebrating with family and friends, and keeps a birthday wish a secret.', vi: 'An tròn bảy tuổi, kể về sinh nhật bên gia đình, bạn bè và giữ bí mật điều ước.' },
    messageIds: ['an_2026-05-14_01_m01', 'an_2026-05-14_01_m03', 'an_2026-05-14_01_m05', 'an_2026-05-14_01_m07'],
  },
  {
    month: '2026-06', date: '2026-06-10',
    title: { en: 'A new favorite color', vi: 'Một màu yêu thích mới' },
    description: { en: 'An says turquoise is now the favorite color. Green is still beautiful, just no longer the favorite.', vi: 'An nói xanh ngọc đã trở thành màu yêu thích nhất. Xanh lá vẫn đẹp, chỉ không còn đứng đầu.' },
    messageIds: ['an_2026-06-10_01_m01', 'an_2026-06-10_01_m03', 'an_2026-06-10_01_m07'],
  },
  {
    month: '2026-07', date: '2026-07-15',
    title: { en: 'Giving Mochi a little space', vi: 'Cho Mochi một chút không gian' },
    description: { en: 'When Mochi stops playing, An describes letting go and choosing a stuffed dog for an imaginary pilot game.', vi: 'Khi Mochi nghỉ chơi, An kể rằng mình đã buông tay và chọn chó bông làm phi công tưởng tượng.' },
    messageIds: ['an_2026-07-15_01_m01', 'an_2026-07-15_01_m03', 'an_2026-07-15_01_m07'],
  },
  {
    month: '2026-08', date: '2026-08-30',
    title: { en: 'A story with An’s own ending', vi: 'Câu chuyện có cái kết do An chọn' },
    description: { en: 'An returns to yesterday’s make-believe sock planet, adds a sleeping button, and chooses to end the story.', vi: 'An trở lại hành tinh tất trong truyện hôm trước, thêm một hạt nút đang ngủ và chọn kết thúc câu chuyện.' },
    messageIds: ['an_2026-08-30_01_m01', 'an_2026-08-30_01_m03', 'an_2026-08-30_01_m07'],
  },
  {
    month: '2026-09', date: '2026-09-01',
    title: { en: 'Hello, second grade', vi: 'Chào lớp hai' },
    description: { en: 'An meets teacher Mai in second grade, sees Bình across the room, and hopes to introduce themself a little louder tomorrow.', vi: 'An gặp cô Mai ở lớp hai, thấy Bình vẫy tay và muốn thử giới thiệu tên to hơn vào ngày mai.' },
    messageIds: ['an_2026-09-01_01_m01', 'an_2026-09-01_01_m03', 'an_2026-09-01_01_m05', 'an_2026-09-01_01_m07'],
  },
  {
    month: '2026-10', date: '2026-10-31',
    title: { en: 'Room for the world outside', vi: 'Dành chỗ cho thế giới bên ngoài' },
    description: { en: 'After an ordinary day with Mochi and some coloring, An says goodbye and chooses to go outside with Dad.', vi: 'Sau một ngày bình thường chơi với Mochi và tô màu, An chào tạm biệt rồi chọn ra ngoài cùng bố.' },
    messageIds: ['an_2026-10-31_01_m01', 'an_2026-10-31_01_m05', 'an_2026-10-31_01_m07'],
  },
];
