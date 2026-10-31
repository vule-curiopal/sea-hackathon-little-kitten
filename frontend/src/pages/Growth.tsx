import { useState } from 'react';
import Dialog from '../components/Dialog';
import Icon, { type IconName } from '../components/Icon';
import Miu from '../components/Miu';
import { useLanguage } from '../lib/i18n';
import { growthHistory, growthMilestones, growthMonths, summarizeMonth } from '../lib/growth-history';
import { Brand } from './Landing';

const copy = {
  en: {
    nav: 'A year together', room: 'Miu’s room', profile: 'Fictional test profile', back: 'Back to Little Buddy',
    eyebrow: 'AN + MIU · A YEAR OF LITTLE MOMENTS', title: 'A little every day.', titleBlue: 'A whole year of discovery.',
    description: 'From first hellos to new school days. Follow An’s changing interests, little adventures, and everyday conversations with Miu.',
    ages: 'From age 6 to 7', note: 'Big discoveries start with little moments.', source: 'Fictional test-user history · Authored reference conversations',
    conversations: 'Daily conversations', exchanges: 'Back-and-forth exchanges', topics: 'Topics explored', languages: 'Languages & mixed chats',
    overview: 'THE BIG PICTURE', chartTitle: 'One day at a time', chartDescription: 'A year of conversations, adding up month by month.',
    chats: 'Conversations', turns: 'Exchanges', chartLabel: 'Cumulative activity from November 2025 to October 2026',
    chartCaption: 'Running totals from the archived conversations.', through: 'through', months: 'Choose a month',
    chapters: 'TWELVE LITTLE CHAPTERS', chaptersTitle: 'There’s a story in every month.', chaptersDescription: 'Pick a month, then a day, to see the moments behind the numbers.',
    monthLabel: 'A CLOSER LOOK', milestone: 'A MOMENT TO REMEMBER', monthChats: 'conversations', monthExchanges: 'exchanges',
    talkedAbout: 'What came up', daily: 'The little everyday moments', dailyDescription: 'Choose any day to open its conversation.', calendar: 'Daily conversations in',
    selected: 'SELECTED CONVERSATION', read: 'Read the conversation', messages: 'messages', vi: 'Tiếng Việt', en: 'English', mixed: 'Việt + English',
    transcriptNote: 'Original authored dialogue from the fictional test archive. These replies are references, not live model outputs.',
    archiveTitle: 'A year to explore, at your own pace.', archiveNote: 'This timeline follows An’s fictional history. Activity counts describe the archive; they do not score a child’s development or prove Miu’s memory performance.',
    footer: 'Little moments. A growing world.', tryMiu: 'Spend a little time with Miu',
  },
  vi: {
    nav: 'Một năm cùng nhau', room: 'Căn phòng của Miu', profile: 'Hồ sơ thử nghiệm hư cấu', back: 'Về với Little Buddy',
    eyebrow: 'AN + MIU · MỘT NĂM VỚI NHỮNG ĐIỀU NHỎ', title: 'Mỗi ngày một chút.', titleBlue: 'Cả năm cùng khám phá.',
    description: 'Từ lời chào đầu tiên đến những ngày học mới. Cùng nhìn lại sở thích thay đổi, cuộc phiêu lưu nhỏ và chuyện thường ngày của An với Miu.',
    ages: 'Từ 6 đến 7 tuổi', note: 'Khám phá lớn từ những khoảnh khắc nhỏ.', source: 'Lịch sử người dùng thử hư cấu · Hội thoại tham chiếu được viết sẵn',
    conversations: 'Cuộc trò chuyện mỗi ngày', exchanges: 'Lượt trao đổi qua lại', topics: 'Chủ đề đã khám phá', languages: 'Ngôn ngữ & trò chuyện kết hợp',
    overview: 'NHÌN LẠI CẢ NĂM', chartTitle: 'Từng ngày, từng chút một', chartDescription: 'Những cuộc trò chuyện được cộng dồn qua từng tháng.',
    chats: 'Trò chuyện', turns: 'Lượt trao đổi', chartLabel: 'Hoạt động cộng dồn từ tháng 11 năm 2025 đến tháng 10 năm 2026',
    chartCaption: 'Số liệu cộng dồn từ hội thoại được lưu trữ.', through: 'đến hết', months: 'Chọn một tháng',
    chapters: 'MƯỜI HAI CHƯƠNG NHỎ', chaptersTitle: 'Mỗi tháng có một câu chuyện.', chaptersDescription: 'Chọn tháng, rồi chọn ngày để khám phá những khoảnh khắc sau các con số.',
    monthLabel: 'NHÌN GẦN HƠN', milestone: 'MỘT KHOẢNH KHẮC ĐÁNG NHỚ', monthChats: 'cuộc trò chuyện', monthExchanges: 'lượt trao đổi',
    talkedAbout: 'Những chủ đề được kể', daily: 'Những điều nhỏ mỗi ngày', dailyDescription: 'Chọn một ngày để xem cuộc trò chuyện.', calendar: 'Hội thoại mỗi ngày trong',
    selected: 'CUỘC TRÒ CHUYỆN ĐÃ CHỌN', read: 'Đọc cuộc trò chuyện', messages: 'tin nhắn', vi: 'Tiếng Việt', en: 'English', mixed: 'Việt + English',
    transcriptNote: 'Hội thoại gốc được viết sẵn cho kho thử nghiệm hư cấu. Đây là nội dung tham chiếu, không phải phản hồi trực tiếp của mô hình.',
    archiveTitle: 'Một năm để khám phá theo nhịp của bạn.', archiveNote: 'Dòng thời gian kể lại lịch sử hư cấu của An. Số liệu mô tả kho hội thoại; không chấm điểm sự phát triển của trẻ hay chứng minh khả năng ghi nhớ của Miu.',
    footer: 'Khoảnh khắc nhỏ. Thế giới lớn dần.', tryMiu: 'Ghé chơi cùng Miu',
  },
};

const topicNames: Record<string, { en: string; vi: string }> = {
  daily_life: { en: 'Everyday life', vi: 'Chuyện thường ngày' }, school: { en: 'School days', vi: 'Trường lớp' },
  family: { en: 'Family', vi: 'Gia đình' }, friendship: { en: 'Friendship', vi: 'Bạn bè' }, pet: { en: 'Mochi & pets', vi: 'Mochi & thú cưng' },
  play: { en: 'Little games', vi: 'Trò chơi nhỏ' }, nonsense: { en: 'Silly moments', vi: 'Chuyện ngộ nghĩnh' },
  q_and_a: { en: 'Big questions', vi: 'Câu hỏi hay' }, tam_su: { en: 'Heart-to-hearts', vi: 'Tâm sự' }, mood: { en: 'Sharing feelings', vi: 'Chia sẻ cảm xúc' },
  bedtime: { en: 'Bedtime', vi: 'Giờ đi ngủ' }, story: { en: 'Story time', vi: 'Kể chuyện' }, language_learning: { en: 'Language play', vi: 'Vui học ngôn ngữ' },
  memory: { en: 'Looking back', vi: 'Nhớ lại' }, correction: { en: 'Changing details', vi: 'Cập nhật chi tiết' },
  boundary: { en: 'Personal boundaries', vi: 'Ranh giới cá nhân' }, stop: { en: 'Taking a pause', vi: 'Nghỉ một chút' },
  holiday: { en: 'Celebrations', vi: 'Ngày lễ' }, creativity: { en: 'Little inventions', vi: 'Sáng tạo' },
  health: { en: 'Everyday care', vi: 'Chăm sóc bản thân' }, routine: { en: 'Daily routines', vi: 'Nếp sinh hoạt' },
};

export default function Growth() {
  const { language, setLanguage, t } = useLanguage();
  const c = copy[language];
  const locale = language === 'vi' ? 'vi-VN' : 'en-GB';
  const [month, setMonth] = useState(growthMonths[0]);
  const [date, setDate] = useState(growthHistory.period.start);
  const [metric, setMetric] = useState<'sessions' | 'exchanges'>('sessions');
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const summaries = growthMonths.map(summarizeMonth);
  const summary = summaries.find(item => item.month === month)!;
  const milestone = growthMilestones.find(item => item.month === month)!;
  const selected = summary.sessions.find(session => session.date === date) ?? summary.sessions[0];
  const formatNumber = (value: number) => value.toLocaleString(locale);
  const formatDate = (value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  const monthName = (value: string, short = false) => formatDate(`${value}-01`, { month: short ? 'short' : 'long', ...(short ? {} : { year: 'numeric' }) });
  const totalTopics = new Set(growthHistory.sessions.flatMap(session => session.tags)).size;
  const stats: { value: number; label: string; icon: IconName; className?: string }[] = [
    { value: growthHistory.totals.sessions, label: c.conversations, icon: 'chat' },
    { value: growthHistory.totals.exchanges, label: c.exchanges, icon: 'sparkle', className: 'is-gold' },
    { value: totalTopics, label: c.topics, icon: 'book', className: 'is-green' },
    { value: new Set(growthHistory.sessions.map(session => session.language)).size, label: c.languages, icon: 'globe' },
  ];
  const counts = summaries.map(item => metric === 'sessions' ? item.cumulativeSessions : item.cumulativeMessages / 2);
  const maximum = metric === 'sessions' ? 400 : 1600;
  const points = counts.map((value, index) => ({ x: 55 + index * 82, y: 201 - value / maximum * 176 }));
  const linePath = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const selectedIndex = growthMonths.indexOf(month);
  const chartPoint = points[selectedIndex];
  const offset = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const selectMonth = (value: string) => {
    setMonth(value);
    setDate(growthMilestones.find(item => item.month === value)?.date ?? `${value}-01`);
  };
  const topic = (tag: string) => topicNames[tag]?.[language] ?? tag.replaceAll('_', ' ');
  // Mixed-language reference text retains both languages for pronunciation.
  const textLanguage = (content: string) => selected.language !== 'mixed' ? selected.language : /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i.test(content) ? 'vi' : 'en';

  return <div className="growth-page">
    <header className="growth-header site-header container">
      <Brand />
      <nav className="growth-nav" aria-label={c.nav}>
        <a href="/app/talk">{c.room}</a>
        <a href="/app/growth" className="is-active" aria-current="page"><Icon name="chart" />{c.nav}</a>
      </nav>
      <div className="header-actions">
        <button className="language-toggle" onClick={() => setLanguage(language === 'en' ? 'vi' : 'en')} aria-label={t('language')}><Icon name="globe" /><span>{language === 'en' ? 'VI' : 'EN'}</span></button>
        <div className="growth-profile"><span className="growth-profile-avatar" aria-hidden="true">A</span><div><strong>An</strong><small>{c.profile}</small></div></div>
      </div>
    </header>

    <main id="main-content" className="growth-main container">
      <a className="growth-breadcrumb text-link" href="/"><Icon name="back" />{c.back}</a>
      <section className="growth-hero wall" aria-labelledby="growth-title">
        <div className="growth-hero-copy">
          <span className="eyebrow-pill"><span className="small-dot" />{c.eyebrow}</span>
          <h1 id="growth-title">{c.title}<br /><span>{c.titleBlue}</span></h1>
          <p className="growth-hero-description">{c.description}</p>
          <div className="growth-period"><Icon name="calendar" /><span>{formatDate(growthHistory.period.start, { day: 'numeric', month: 'short', year: 'numeric' })} – {formatDate(growthHistory.period.end, { day: 'numeric', month: 'short', year: 'numeric' })}</span><span className="tiny-dot" /><span>{c.ages}</span></div>
        </div>
        <div className="growth-hero-art">
          <div className="growth-hero-orbit" aria-hidden="true" />
          <Icon name="sparkle" className="growth-sparkle-one" /><Icon name="sparkle" className="growth-sparkle-two" />
          <Miu emotion="happy" className="growth-hero-miu" />
          <div className="growth-hero-note"><Icon name="heart" /><span>{c.note}</span></div>
        </div>
      </section>
      <p className="growth-source-note"><Icon name="shield" />{c.source}</p>

      <section className="growth-stats" aria-label={c.overview}>
        {stats.map(stat => <article className="growth-stat growth-card" key={stat.icon}><span className={`growth-stat-icon ${stat.className ?? ''}`}><Icon name={stat.icon} /></span><div><strong>{formatNumber(stat.value)}</strong><span>{stat.label}</span></div></article>)}
      </section>

      <section className="growth-overview growth-card" aria-labelledby="growth-chart-title">
        <div className="growth-section-heading"><div><span className="eyebrow">{c.overview}</span><h2 id="growth-chart-title">{c.chartTitle}</h2><p>{c.chartDescription}</p></div><div className="growth-chart-toggle" role="group" aria-label={c.chartTitle}><button aria-pressed={metric === 'sessions'} onClick={() => setMetric('sessions')}>{c.chats}</button><button aria-pressed={metric === 'exchanges'} onClick={() => setMetric('exchanges')}>{c.turns}</button></div></div>
        <div className="growth-chart-wrap">
          <svg className="growth-chart" viewBox="0 0 1000 230" role="img" aria-labelledby="activity-title activity-description">
            <title id="activity-title">{c.chartLabel}</title>
            <desc id="activity-description">{formatNumber(counts[selectedIndex])} {metric === 'sessions' ? c.monthChats : c.monthExchanges} {c.through} {monthName(month)}. {formatNumber(counts.at(-1)!)} {metric === 'sessions' ? c.monthChats : c.monthExchanges} {c.through} {monthName(growthMonths.at(-1)!)}.</desc>
            <defs><linearGradient id="growth-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--pop)" stopOpacity=".16" /><stop offset="100%" stopColor="var(--pop)" stopOpacity=".015" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line className="growth-chart-grid" x1="55" x2="970" y1={201 - tick * 44} y2={201 - tick * 44} /><text className="growth-chart-label" x="35" y={205 - tick * 44} textAnchor="end">{formatNumber(maximum / 4 * tick)}</text></g>)}
            <path className="growth-chart-area" d={`${linePath} L 957 201 L 55 201 Z`} fill="url(#growth-chart-fill)" />
            <line className="growth-chart-guide" x1={chartPoint.x} x2={chartPoint.x} y1="20" y2="201" />
            <path className="growth-chart-line" d={linePath} />
            {points.map((point, index) => <circle key={growthMonths[index]} className={`growth-chart-point ${index === selectedIndex ? 'is-selected' : ''}`} cx={point.x} cy={point.y} r={index === selectedIndex ? 7 : 4} />)}
          </svg>
        </div>
        <div className="growth-months" role="group" aria-label={c.months}>{growthMonths.map((value, index) => <button key={value} className="growth-month" aria-pressed={month === value} aria-label={`${monthName(value)} · ${formatNumber(counts[index])} ${metric === 'sessions' ? c.monthChats : c.monthExchanges}`} onClick={() => selectMonth(value)}><small>{value.slice(0, 4)}</small><strong>{monthName(value, true)}</strong><span>{formatNumber(counts[index])}</span></button>)}</div>
        <div className="growth-chart-caption"><span><span className="small-dot" />{c.chartCaption}</span><span aria-live="polite"><strong>{formatNumber(counts[selectedIndex])}</strong> {metric === 'sessions' ? c.monthChats : c.monthExchanges} {c.through} {monthName(month)}</span></div>
      </section>

      <div className="growth-chapters-header"><span className="eyebrow">{c.chapters}</span><h2>{c.chaptersTitle}</h2><p>{c.chaptersDescription}</p></div>
      <div className="growth-detail-grid">
        <aside className="growth-month-card growth-card" aria-label={`${c.monthLabel} · ${monthName(month)}`}>
          <span className="eyebrow growth-month-kicker">{c.monthLabel}</span><h3>{monthName(month)}</h3>
          <p className="growth-month-summary">{milestone.description[language]}</p>
          <div className="growth-month-totals"><div><strong>{summary.sessionCount}</strong><span>{c.monthChats}</span></div><div><strong>{summary.exchangeCount}</strong><span>{c.monthExchanges}</span></div></div>
          <div className="growth-milestone-card"><span className="growth-milestone-icon"><Icon name="sparkle" /></span><span className="eyebrow">{c.milestone}</span><small>{formatDate(milestone.date, { day: 'numeric', month: 'long' })}</small><h4>{milestone.title[language]}</h4><button className="text-link" onClick={() => { setDate(milestone.date); setTranscriptOpen(true); }}>{c.read}<Icon name="arrow" /></button></div>
          <h4>{c.talkedAbout}</h4><div className="growth-topics">{summary.topics.slice(0, 5).map(item => <span className="growth-topic" key={item.tag}>{topic(item.tag)}<small>{item.count}</small></span>)}</div>
        </aside>
        <section className="growth-session-card growth-card" aria-labelledby="daily-conversations-title">
          <div className="growth-session-heading"><div><h3 id="daily-conversations-title">{c.daily}</h3><p>{c.dailyDescription}</p></div><span>{summary.sessionCount} <Icon name="chat" /></span></div>
          <div className="growth-calendar-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <span key={i}>{formatDate(`2026-06-0${i + 1}`, { weekday: 'short' })}</span>)}</div>
          <div className="growth-calendar" role="group" aria-label={`${c.calendar} ${monthName(month)}`}>
            {Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`} aria-hidden="true" />)}
            {summary.sessions.map(session => <button key={session.id} className={session.date === milestone.date ? 'is-milestone' : ''} aria-pressed={selected.id === session.id} aria-label={`${formatDate(session.date)} · ${session.title}`} onClick={() => setDate(session.date)}><span>{Number(session.date.slice(-2))}</span><span className="small-dot" aria-hidden="true" /></button>)}
          </div>
          <article className="growth-session-preview" aria-live="polite">
            <div className="growth-session-meta"><span className="eyebrow">{formatDate(selected.date, { day: 'numeric', month: 'long', year: 'numeric' })}</span><span className="growth-language-badge">{c[selected.language]}</span></div>
            <h4 lang="en">{selected.title}</h4>
            <p lang={textLanguage(selected.messages[0].content)}>“{selected.messages[0].content}”</p>
            <div className="growth-session-tags">{selected.tags.slice(0, 3).map(tag => <span className="growth-topic" key={tag}>{topic(tag)}</span>)}</div>
            <button className="growth-open-session button button-white" onClick={() => setTranscriptOpen(true)}>{c.read}<Icon name="arrow" /></button>
          </article>
        </section>
      </div>
      <aside className="growth-bottom-note"><Icon name="shield" /><div><strong>{c.archiveTitle}</strong><p>{c.archiveNote}</p></div></aside>
    </main>
    <footer className="growth-footer container"><Brand /><p>{c.footer}</p><a className="text-link" href="/app/talk">{c.tryMiu}<Icon name="arrow" /></a></footer>
    <Dialog open={transcriptOpen} onClose={() => setTranscriptOpen(false)} title={selected.title} className="growth-transcript-dialog">
      <p className="growth-transcript-intro">{formatDate(selected.date)} · {selected.messages.length} {c.messages} · {c[selected.language]}</p>
      <p className="growth-transcript-intro">{c.transcriptNote}</p>
      <div className="growth-transcript-list">{selected.messages.map(message => <article key={message.id} className={`growth-message ${message.role === 'assistant' ? 'is-miu' : ''}`}><span className="growth-message-avatar" aria-hidden="true">{message.role === 'assistant' ? <Miu emotion="happy" /> : 'A'}</span><div><strong>{message.role === 'assistant' ? 'Miu' : 'An'}</strong><p lang={textLanguage(message.content)}>{message.content}</p></div></article>)}</div>
    </Dialog>
  </div>;
}
