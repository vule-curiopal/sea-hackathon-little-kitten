import { createHash } from 'node:crypto';
import novemberToJanuary from './source/2025-11_2026-01.mjs';
import februaryToApril from './source/2026-02_2026-04.mjs';
import mayToJuly from './source/2026-05_2026-07.mjs';
import augustToOctober from './source/2026-08_2026-10.mjs';

export const VERSION = 'miu-synthetic-year-v1';
export const START_DATE = '2025-11-01';
export const END_DATE = '2026-10-31';
export const PROFILE_ID = 'synthetic-an-001';
export const TIMEZONE = 'Asia/Ho_Chi_Minh';
export const CHILD_MOODS = new Set([
  'happy', 'sad', 'angry', 'frustrated', 'anxious', 'scared', 'excited',
  'curious', 'tired', 'calm', 'bored', 'shy', 'proud', 'lonely', 'disappointed', 'content',
]);
export const TAGS = new Set([
  'daily_life', 'school', 'family', 'friendship', 'pet', 'play', 'nonsense',
  'q_and_a', 'tam_su', 'mood', 'bedtime', 'story', 'language_learning', 'memory',
  'correction', 'boundary', 'stop', 'holiday', 'creativity', 'health', 'routine',
]);
export const sourceDays = [...novemberToJanuary, ...februaryToApril, ...mayToJuly, ...augustToOctober];

const hash = value => createHash('sha256').update(value).digest();
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const ageOn = date => date < '2026-05-14' ? 6 : 7;
const textKey = text => text.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/gu, ' ').trim();
// Present-tense meals/rest and the after-school-event break have authored time overrides.
const TIME_OVERRIDES = {
  '2025-11-02': [7, 40],
  '2026-02-01': [8, 10],
  '2026-05-01': [8, 5],
  '2026-06-05': [18, 10],
  '2026-07-06': [7, 35],
  '2026-07-17': [12, 35],
  '2026-08-02': [7, 40],
  '2026-09-05': [11, 40],
  '2026-09-20': [19, 50],
};

export function calendar() {
  const dates = [];
  for (let at = Date.parse(`${START_DATE}T00:00:00Z`); at <= Date.parse(`${END_DATE}T00:00:00Z`); at += 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

export function validateSource(days) {
  const dates = calendar();
  requireThat(days.length === dates.length, `Expected ${dates.length} days; got ${days.length}`);
  const titles = new Set();
  const transcripts = new Set();
  for (const [index, day] of days.entries()) {
    const label = day.date ?? `index ${index}`;
    requireThat(day.date === dates[index], `Missing, duplicate or unordered date at ${label}; expected ${dates[index]}`);
    requireThat(nonempty(day.title) && !titles.has(textKey(day.title)), `Empty or duplicate title at ${label}`);
    titles.add(textKey(day.title));
    requireThat(['vi', 'en', 'mixed'].includes(day.language), `Invalid language at ${label}`);
    requireThat(Array.isArray(day.tags) && day.tags.length > 0 && day.tags.every(tag => TAGS.has(tag)), `Invalid tags at ${label}`);
    requireThat(new Set(day.tags).size === day.tags.length, `Duplicate tags at ${label}`);
    requireThat(Array.isArray(day.mood) && day.mood.length === 2 && day.mood.every(mood => CHILD_MOODS.has(mood)), `Invalid child mood at ${label}`);
    requireThat(Array.isArray(day.pairs) && day.pairs.length >= 4 && day.pairs.length <= 6, `Expected 4–6 pairs at ${label}`);
    for (const [pairIndex, pair] of day.pairs.entries()) {
      requireThat(Array.isArray(pair) && pair.length === 2 && pair.every(nonempty), `Invalid dialogue pair at ${label}/${pairIndex + 1}`);
      requireThat(pair.every(text => text === text.normalize('NFC')), `Text must be Unicode NFC at ${label}/${pairIndex + 1}`);
      const reply = pair[1];
      requireThat((reply.match(/\?/gu) ?? []).length <= 1, `Too many Miu questions at ${label}/${pairIndex + 1}`);
      requireThat(reply.trim().split(/\s+/u).length <= 60, `Long Miu reply at ${label}/${pairIndex + 1}`);
    }
    const transcript = textKey(day.pairs.flat().join('\n'));
    requireThat(!transcripts.has(transcript), `Duplicate full conversation at ${label}`);
    transcripts.add(transcript);
  }
  return true;
}

function timestamp(date, seconds) {
  return `${date}T${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}+07:00`;
}

export function generateHistory(days = sourceDays) {
  validateSource(days);
  const starts = [16 * 3600 + 25 * 60, 18 * 3600 + 40 * 60, 19 * 3600 + 25 * 60];
  return days.map(day => {
    const seed = hash(`${VERSION}:${day.date}`);
    const sessionId = `an_${day.date}_01`;
    // Recollections of today's school events default to afternoon/evening, never pre-school.
    let seconds = day.tags.includes('bedtime') ? 20 * 3600 + 35 * 60 : starts[seed[0] % starts.length];
    const override = TIME_OVERRIDES[day.date];
    if (override) seconds = override[0] * 3600 + override[1] * 60;
    seconds += seed[1] % 180;
    const messages = day.pairs.flatMap((pair, pairIndex) => pair.map((content, speakerIndex) => {
      const messageIndex = pairIndex * 2 + speakerIndex;
      const result = {
        id: `${sessionId}_m${String(messageIndex + 1).padStart(2, '0')}`,
        role: speakerIndex === 0 ? 'user' : 'assistant',
        speaker: speakerIndex === 0 ? 'An' : 'Miu',
        timestamp: timestamp(day.date, seconds),
        content,
      };
      seconds += 14 + seed[(messageIndex + 2) % seed.length] % 33;
      return result;
    }));
    return {
      schema_version: VERSION,
      synthetic: true,
      response_origin: 'authored_reference',
      session_id: sessionId,
      profile_id: PROFILE_ID,
      local_date: day.date,
      timezone: TIMEZONE,
      started_at: messages[0].timestamp,
      ended_at: messages.at(-1).timestamp,
      child_age_years: ageOn(day.date),
      language: day.language,
      title: day.title,
      tags: [...day.tags],
      child_mood: { source: 'author_annotation', start: day.mood[0], end: day.mood[1] },
      miu_daily_mood: ['content', 'curious', 'mellow'][seed[17] % 3],
      messages,
    };
  });
}

export function validateHistory(sessions) {
  const dates = calendar();
  requireThat(sessions.length === dates.length, 'History must contain exactly 365 sessions');
  const ids = new Set();
  const addId = id => {
    requireThat(nonempty(id) && !ids.has(id), `Missing or duplicate ID: ${id}`);
    ids.add(id);
  };
  for (const [index, session] of sessions.entries()) {
    const label = session.local_date;
    requireThat(label === dates[index], `Invalid session date ${label}`);
    requireThat(session.schema_version === VERSION && session.synthetic === true && session.response_origin === 'authored_reference', `Invalid provenance at ${label}`);
    requireThat(session.profile_id === PROFILE_ID && session.timezone === TIMEZONE, `Invalid profile at ${label}`);
    requireThat(session.child_age_years === ageOn(label), `Invalid child age at ${label}`);
    requireThat(['content', 'curious', 'mellow'].includes(session.miu_daily_mood), `Invalid Miu daily mood at ${label}`);
    requireThat(CHILD_MOODS.has(session.child_mood?.start) && CHILD_MOODS.has(session.child_mood?.end) && session.child_mood?.source === 'author_annotation', `Invalid annotated mood at ${label}`);
    requireThat(['vi', 'en', 'mixed'].includes(session.language), `Invalid session language at ${label}`);
    requireThat(Array.isArray(session.tags) && session.tags.length > 0 && session.tags.every(tag => TAGS.has(tag)), `Invalid session tags at ${label}`);
    addId(session.session_id);
    requireThat(Array.isArray(session.messages) && session.messages.length >= 8 && session.messages.length <= 12 && session.messages.length % 2 === 0, `Invalid message count at ${label}`);
    let previous = -Infinity;
    for (const [messageIndex, message] of session.messages.entries()) {
      addId(message.id);
      requireThat(message.role === (messageIndex % 2 === 0 ? 'user' : 'assistant'), `Invalid role order at ${message.id}`);
      requireThat(message.speaker === (messageIndex % 2 === 0 ? 'An' : 'Miu'), `Invalid speaker at ${message.id}`);
      requireThat(nonempty(message.content), `Empty content at ${message.id}`);
      const at = Date.parse(message.timestamp);
      requireThat(message.timestamp.startsWith(`${label}T`) && message.timestamp.endsWith('+07:00') && Number.isFinite(at) && at > previous, `Invalid timestamp at ${message.id}`);
      previous = at;
    }
    requireThat(session.started_at === session.messages[0].timestamp && session.ended_at === session.messages.at(-1).timestamp, `Invalid session boundaries at ${label}`);
  }
  return true;
}

const counts = values => Object.fromEntries([...values.reduce((result, value) => result.set(value, (result.get(value) ?? 0) + 1), new Map())].sort(([a], [b]) => a.localeCompare(b)));

export function buildManifest(sessions) {
  const messageCount = sessions.reduce((sum, session) => sum + session.messages.length, 0);
  return {
    schema_version: VERSION,
    synthetic: true,
    purpose: 'Offline testing of long-term conversation context, recall, mood handling, and dialogue behavior; no real child data.',
    response_origin: 'authored_reference',
    period: { start: START_DATE, end: END_DATE, inclusive: true, days: sessions.length, timezone: TIMEZONE },
    persona: {
      profile_id: PROFILE_ID, display_name: 'An', fictional: true, birth_date: '2019-05-14',
      age_at_start: 6, age_at_end: 7, language_mode: 'follow_child', age_band: '6-8',
      family: ['mẹ', 'bố', 'bà ngoại'], dog: 'Mochi', friend: 'Bình', cousin: 'Na',
      school: { first_grade_teacher: 'cô Hạnh', second_grade_teacher: 'cô Mai', second_grade_from: '2026-09-01' },
      evolving_preferences: [
        { since: START_DATE, favorite_color: 'xanh lá (green)' },
        { since: '2026-06-10', favorite_color: 'xanh ngọc (turquoise)' },
        { since: '2026-06-18', preferred_address: 'An; retired banana captain nickname' },
      ],
    },
    miu: {
      canon_version: 'miu-v1', personality: 'ENFP', role: 'friend',
      identity: 'AI kitten with an explicitly imaginary indoor life',
      daily_mood_values: ['content', 'curious', 'mellow'],
      daily_mood_source: 'Deterministic fixture annotation keyed by date; not extracted from dialogue or evidence of runtime state.',
    },
    totals: { sessions: sessions.length, messages: messageCount, exchanges: messageCount / 2 },
    distribution: {
      sessions_by_month: counts(sessions.map(session => session.local_date.slice(0, 7))),
      sessions_by_language: counts(sessions.map(session => session.language)),
      sessions_by_tag: counts(sessions.flatMap(session => session.tags)),
      child_mood_start: counts(sessions.map(session => session.child_mood.start)),
      child_mood_end: counts(sessions.map(session => session.child_mood.end)),
      miu_daily_mood: counts(sessions.map(session => session.miu_daily_mood)),
      sessions_with_mood_change: sessions.filter(session => session.child_mood.start !== session.child_mood.end).length,
    },
    files: {
      sessions: 'sessions.jsonl', messages: 'messages.jsonl', evaluation_cases: 'evaluation-cases.json',
    },
    limitations: [
      'One fictional child, one session every day, four to six exchanges per session; not a representative usage distribution.',
      'Text only; no audio, STT errors, latency, cancellation receipts, or provider-generated responses.',
      'Mood and topic labels are authored test annotations, not clinical assessments or model predictions.',
      'Historical dates are simulated and must be replayed with an isolated demo clock; runtime memory retention still applies.',
      'Reference replies are examples, not guaranteed output of MiuApplication or evidence that learning, deletion, or other operations occurred.',
    ],
  };
}

export function flattenMessages(sessions) {
  return sessions.flatMap(session => session.messages.map(message => ({
    schema_version: VERSION, synthetic: true, profile_id: session.profile_id,
    session_id: session.session_id, local_date: session.local_date,
    language: session.language, ...message,
  })));
}
