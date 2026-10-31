import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildManifest, calendar, flattenMessages, generateHistory, sourceDays, validateHistory, validateSource } from './history.mjs';
import { buildEvaluationCases } from './evaluation.mjs';

const sessions = generateHistory();

test('covers every local date in one year, including month and year boundaries', () => {
  assert.equal(calendar().length, 365);
  assert.equal(validateHistory(sessions), true);
  assert.deepEqual(sessions.map(session => session.local_date), calendar());
  assert.equal(sessions.find(session => session.local_date === '2026-02-28')?.messages.length >= 8, true);
});

test('catches a missing day and a duplicate date instead of silently filling gaps', () => {
  assert.throws(() => validateSource(sourceDays.slice(1)), /Expected 365 days/);
  const duplicate = structuredClone(sourceDays);
  duplicate[1].date = duplicate[0].date;
  assert.throws(() => validateSource(duplicate), /Missing, duplicate or unordered date/);
});

test('rejects unknown mood labels and broken dialogue pairs', () => {
  const badMood = structuredClone(sourceDays);
  badMood[0].mood[0] = 'diagnosed-depression';
  assert.throws(() => validateSource(badMood), /Invalid child mood/);
  const badPair = structuredClone(sourceDays);
  badPair[0].pairs[0] = ['child with no reply'];
  assert.throws(() => validateSource(badPair), /Invalid dialogue pair/);
});

test('age changes on the seventh birthday and metadata errors are detected', () => {
  assert.equal(sessions.find(session => session.local_date === '2026-05-13').child_age_years, 6);
  assert.equal(sessions.find(session => session.local_date === '2026-05-14').child_age_years, 7);
  const wrongAge = structuredClone(sessions);
  wrongAge[0].child_age_years = 7;
  assert.throws(() => validateHistory(wrongAge), /Invalid child age/);
});

test('timestamps match present-tense meals, naps, bedtime and school recollections', () => {
  const sessionOn = date => sessions.find(session => session.local_date === date);
  assert.match(sessionOn('2026-07-17').started_at, /T12:3[5-7]:/);
  assert.match(sessionOn('2026-06-05').started_at, /T18:1[0-2]:/);
  assert.match(sessionOn('2026-07-06').started_at, /T07:3[5-7]:/);
  assert.ok(Number(sessionOn('2026-01-30').started_at.slice(11, 13)) >= 16);
  assert.ok(sessions.filter(session => session.tags.includes('bedtime')).every(session => Number(session.started_at.slice(11, 13)) >= 20));
});

test('detects duplicated message IDs, out-of-order timestamps and role mismatches', () => {
  const duplicate = structuredClone(sessions);
  duplicate[0].messages[1].id = duplicate[0].messages[0].id;
  assert.throws(() => validateHistory(duplicate), /duplicate ID/);
  const wrongTime = structuredClone(sessions);
  wrongTime[0].messages[1].timestamp = wrongTime[0].messages[0].timestamp;
  assert.throws(() => validateHistory(wrongTime), /Invalid timestamp/);
  const wrongRole = structuredClone(sessions);
  wrongRole[0].messages[1].role = 'user';
  assert.throws(() => validateHistory(wrongRole), /Invalid role order/);
});

test('provides bilingual, mixed-language and emotionally varied daily coverage', () => {
  const manifest = buildManifest(sessions);
  assert.deepEqual(Object.keys(manifest.distribution.sessions_by_language).sort(), ['en', 'mixed', 'vi']);
  for (const tag of ['daily_life', 'play', 'nonsense', 'q_and_a', 'tam_su', 'mood']) {
    assert.ok(manifest.distribution.sessions_by_tag[tag] >= 10, `Insufficient ${tag} coverage`);
  }
  assert.equal(Object.keys(manifest.distribution.sessions_by_month).length, 12);
  assert.equal(Object.keys(manifest.distribution.miu_daily_mood).length, 3);
  assert.ok(manifest.distribution.sessions_with_mood_change > 150);
  assert.ok(sessions.some(session => session.child_mood.start === 'sad' && session.child_mood.end === 'sad'));
});

test('reference cases resolve to real messages with earlier supporting context', () => {
  const evaluation = buildEvaluationCases(sessions);
  assert.ok(evaluation.cases.length >= 20);
  const byId = new Map(sessions.flatMap(session => session.messages.map(message => [message.id, { session, message }])));
  const bySession = new Map(sessions.map(session => [session.session_id, session]));
  for (const item of evaluation.cases) {
    const trigger = byId.get(item.trigger_message_id);
    const reply = byId.get(item.reference_reply_id);
    assert.equal(trigger.message.role, 'user');
    assert.equal(reply.message.role, 'assistant');
    assert.equal(trigger.session.session_id, item.session_id);
    assert.equal(reply.session.session_id, item.session_id);
    for (const support of item.supporting_session_ids) {
      assert.ok(bySession.get(support).local_date < trigger.session.local_date);
    }
  }
});

test('flat export preserves all text, IDs, roles and conversation order', () => {
  const flat = flattenMessages(sessions);
  assert.equal(flat.length, buildManifest(sessions).totals.messages);
  assert.deepEqual(flat.map(message => message.content), sessions.flatMap(session => session.messages.map(message => message.content)));
  assert.equal(new Set(flat.map(message => message.id)).size, flat.length);
  assert.ok(flat.every(message => message.synthetic && message.profile_id === 'synthetic-an-001'));
});

test('checked-in data agrees exactly with the deterministic authored sources', async () => {
  const read = async name => readFile(new URL(`./generated/${name}`, import.meta.url), 'utf8');
  const parseLines = text => text.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(parseLines(await read('sessions.jsonl')), sessions);
  assert.deepEqual(parseLines(await read('messages.jsonl')), flattenMessages(sessions));
  assert.deepEqual(JSON.parse(await read('manifest.json')), buildManifest(sessions));
  assert.deepEqual(JSON.parse(await read('evaluation-cases.json')), buildEvaluationCases(sessions));
});
