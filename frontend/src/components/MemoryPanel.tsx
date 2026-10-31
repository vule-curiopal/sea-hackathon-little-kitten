import { useEffect, useState } from 'react';
import type { SessionResponse, TurnResponse } from '@miu/voice-client';
import Dialog from './Dialog';
import Icon from './Icon';
import { useLanguage } from '../lib/i18n';
import { engineRequest, type DemoPanelData, type Presentation } from '../lib/engine-api';
import { affectMoodLabel, readAffectPresentation, readAffectSnapshot } from '../lib/affect';

export default function MemoryPanel({ open, onClose, session, revision, busy, advancing, onNextDay, lastTurn }: {
  open: boolean; onClose(): void; session: SessionResponse | null; revision: number; busy: boolean; advancing: boolean;
  onNextDay(clockVersion: number): void; lastTurn: TurnResponse | null;
}) {
  const { language } = useLanguage();
  const vi = language === 'vi';
  const [data, setData] = useState<DemoPanelData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { setData(null); setError(''); }, [session?.session_id]);
  useEffect(() => {
    if (!open || !session) return;
    const abort = new AbortController();
    setLoading(true); setError('');
    void engineRequest<DemoPanelData>(session, '/api/demo/panel', {}, abort.signal).then(value => {
      if (!abort.signal.aborted) setData(value);
    }).catch(reason => {
      if (!abort.signal.aborted) { setData(null); setError(typeof reason?.code === 'string' ? reason.code : 'unavailable'); }
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [open, session?.session_id, revision, refresh]);
  const context = data?.memory_available ? data.context : undefined;
  const presentation = lastTurn?.presentation as Presentation | null | undefined;
  const affect = readAffectSnapshot(context?.affect);
  const responseAffect = readAffectPresentation(presentation?.affect);
  const times = lastTurn?.timings_ms;
  const empty = vi ? 'Chưa có ký ức được lưu.' : 'No saved memories yet.';
  const expiry = (date: string) => `${vi ? 'Đến' : 'Until'} ${new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', timeZone: context?.clock.timezone ?? 'UTC' }).format(new Date(date))}`;
  return <Dialog open={open} onClose={onClose} title={vi ? 'Góc người lớn · Trí nhớ của Miu' : 'Adult demo · Miu’s memory'} className="memory-dialog">
    <p className="memory-intro">{vi ? 'Hồ sơ hư cấu dành cho bản demo. Những thẻ dưới đây là dữ liệu thực đang được máy chủ lưu, không phải câu trả lời mẫu.' : 'Fictional profiles for this demo. These cards show the server’s current saved state.'}</p>
    <a className="text-link" href="/app/growth"><Icon name="chart" />{vi ? 'Khám phá một năm hội thoại của An' : 'Explore An’s year of conversations'}<Icon name="arrow" /></a>
    <div className="memory-toolbar"><span className={`engine-badge ${session?.provider_mode === 'real' ? 'is-live' : ''}`}><span className="small-dot" />{session?.provider_mode === 'real' ? 'Real providers' : session ? 'Development provider' : 'Disconnected'}</span><button className="button button-white" disabled={!session || loading} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" />{vi ? 'Làm mới' : 'Refresh'}</button></div>
    {loading && <p className="memory-notice" role="status">{vi ? 'Đang đọc trí nhớ…' : 'Reading memory…'}</p>}
    {error && <p className="memory-notice is-error" role="status">{vi ? 'Chưa đọc được trí nhớ' : 'Memory unavailable'} · {error}</p>}
    {!session && <p className="memory-notice">{vi ? 'Kết nối một hồ sơ để xem trạng thái.' : 'Connect a profile to see its state.'}</p>}
    {data && !context && <p className="memory-notice">{vi ? 'Dịch vụ hiện tại chưa cung cấp trí nhớ nhân vật.' : 'The current service does not expose character memory.'}</p>}
    {context && <>
      <section className="memory-overview"><div><span className="eyebrow">{vi ? 'Người bạn nhỏ' : 'Little friend'}</span><h3>{context.profile.displayName}</h3><p>{vi ? 'Nhóm tuổi' : 'Age band'} {context.profile.ageBand} · {context.config.personality} · {context.config.role.replaceAll('_', ' ')}</p></div><div className="day-counter"><strong>{context.daily.growthDays}</strong><span>{vi ? 'ngày trưởng thành' : 'growth days'}</span></div></section>
      <div className="memory-clock"><span>{new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: context.clock.timezone }).format(new Date(context.clock.effectiveNow))}</span><small>{context.clock.timezone} · {context.clock.mode === 'demo' ? (vi ? 'đồng hồ demo' : 'demo clock') : 'real clock'}</small></div>
      {affect && <section className="memory-card memory-affect"><h3>{vi ? 'Tâm trạng của Miu' : 'Miu’s mood'}</h3><dl>
        <div><dt>{vi ? 'Hôm nay' : 'Daily mood'}</dt><dd>{affectMoodLabel(affect.dailyMood, language)}</dd><small>{vi ? 'Năng lượng đầu ngày' : 'Daily energy'} · {Math.round(affect.baseline.energy * 100)}%</small></div>
        <div><dt>{vi ? 'Hiện tại' : 'Current mood'}</dt><dd>{affectMoodLabel(affect.currentMood, language)}</dd><small>{vi ? 'Năng lượng hiện tại' : 'Current energy'} · {Math.round(affect.current.energy * 100)}%</small><meter min={0} max={1} value={affect.current.energy} aria-label={vi ? 'Năng lượng hiện tại của Miu' : 'Miu’s current energy'} /></div>
      </dl><small>{vi ? 'Trạng thái của nhân vật hư cấu Miu. Thay đổi từ cuộc trò chuyện được lưu sau khi đọc hoặc phát xong câu trả lời.' : 'Miu’s fictional character state. Conversation changes save after the answer finishes being read or played.'}</small></section>}
      <div className="memory-grid">
        <section className="memory-card"><h3>{vi ? 'Tên riêng & nhân vật' : 'Names & characters'}</h3>{context.entities.length ? <ul className="memory-list">{context.entities.map(entity => <li key={entity.id}><strong>{entity.name}</strong><span>{entity.kind.replaceAll('_', ' ')}{entity.species ? ` · ${entity.species}` : ''}</span><small>{expiry(entity.expiresAt)}</small></li>)}</ul> : <p className="memory-empty">{empty}</p>}</section>
        <section className="memory-card"><h3>{vi ? 'Sở thích & điều đã chia sẻ' : 'Interests & shared preferences'}</h3>{context.preferences.length ? <ul className="memory-list">{context.preferences.map(item => <li key={item.id}><strong>{item.value}</strong><span>{item.category.replaceAll('_', ' ')}</span><small>{expiry(item.expiresAt)}</small></li>)}</ul> : <p className="memory-empty">{empty}</p>}</section>
        <section className="memory-card"><h3>{vi ? 'Những người xung quanh' : 'Social circle'}</h3>{context.socialCircle.length ? <ul className="memory-list">{context.socialCircle.map(person => <li key={person.id}><strong>{person.name}</strong><span>{person.relation}</span><small>{expiry(person.expiresAt)}</small></li>)}</ul> : <p className="memory-empty">{empty}</p>}</section>
        <section className="memory-card"><h3>{vi ? 'Sự kiện được kể' : 'Reported events'}</h3>{context.events.length ? <ul className="memory-list">{context.events.map(item => <li key={item.id}><strong>{item.subjectName ? `${item.subjectName} · ` : ''}{item.value}</strong><span>{item.evidenceKind === 'reported_plan' ? (vi ? 'Kế hoạch được kể' : 'Reported plan') : (vi ? 'Do trẻ kể' : 'Child reported')} · {item.localDate}</span></li>)}</ul> : <p className="memory-empty">{empty}</p>}</section>
        <section className="memory-card memory-diary"><span className="eyebrow">{vi ? 'Thế giới tưởng tượng của Miu' : 'Miu’s fictional world'}</span><h3>{vi ? 'Nhật ký hôm nay' : 'Today’s diary'}</h3><p>{context.daily.diary[language]}</p><div className="memory-tags"><span>{affect ? affectMoodLabel(affect.dailyMood, language) : context.daily.mood}</span><span>{context.daily.growthTheme}</span></div><small>{vi ? 'Phát triển qua những chủ đề hư cấu được viết sẵn; không chấm điểm cảm xúc của trẻ.' : 'Authored fictional growth; children’s emotions are not scored.'}</small></section>
        <section className="memory-card"><h3>{vi ? 'Câu chuyện đang lớn' : 'Growing stories'}</h3><p className="memory-story">{context.daily.storyEpisode[language]}</p>{context.storyProgress && <div className="story-checkpoint"><strong>{context.storyProgress.title[language]}</strong><span>{vi ? 'Cảnh' : 'Scene'} {context.storyProgress.chapter} · {context.storyProgress.status}</span></div>}{context.stories.map(story => <div className="story-checkpoint" key={story.id}><strong>{story.title}</strong><p>{story.summary}</p><span>{story.castNames.join(', ')}</span></div>)}<small>{vi ? 'Tiến độ truyện chỉ được lưu sau khi câu trả lời đã được phát trọn vẹn.' : 'Story progress commits after the reply finishes playing.'}</small></section>
      </div>
      {lastTurn && <details className="memory-diagnostics"><summary>{vi ? 'Trạng thái lượt trả lời gần nhất' : 'Latest turn details'}</summary><dl><div><dt>Engine</dt><dd>{lastTurn.engine_mode}</dd></div><div><dt>{vi ? 'Biểu cảm' : 'Expression'}</dt><dd>{presentation?.emotion ?? '—'} · {presentation?.delivery ?? '—'}</dd></div><div><dt>{vi ? 'Nhịp trong ngày' : 'Daily rhythm'}</dt><dd>{presentation?.rhythm ?? '—'}</dd></div><div><dt>{vi ? 'Thời gian máy chủ' : 'Server time'}</dt><dd>{times ? `${Math.round(times.server_total)} ms` : '—'}</dd></div></dl></details>}
      {responseAffect && <p className="memory-reply-affect">{vi ? 'Cách thể hiện ở câu trả lời gần nhất' : 'Latest reply delivery'} · {affectMoodLabel(responseAffect.currentMood, language)} · {vi ? 'năng lượng' : 'energy'} {Math.round(responseAffect.energy * 100)}%</p>}
      <div className="memory-next-day"><div><h3>{vi ? 'Một ngày mới cùng Miu' : 'A new day with Miu'}</h3><p>{vi ? 'Chuyển đồng hồ demo sang ngày kế tiếp. Dữ liệu hết hạn được dọn, nhật ký và truyện hư cấu được cập nhật.' : 'Advance the demo clock. Expired memories are cleaned up; Miu’s fictional diary and story move forward.'}</p></div><button className="button button-primary" disabled={busy || advancing || loading || context.clock.mode !== 'demo'} onClick={() => onNextDay(data!.clock_version)}>{advancing ? (vi ? 'Đang sang ngày…' : 'Advancing…') : (vi ? 'Ngày tiếp theo' : 'Next day')}<Icon name="arrow" /></button></div>
    </>}
  </Dialog>;
}
