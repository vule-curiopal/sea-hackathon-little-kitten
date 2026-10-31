import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { growthHistory, growthMilestones, growthMonths, summarizeMonth } from './growth-history.ts';

test('the frontend archive preserves every original message and its fictional provenance', async () => {
  const source = await readFile(new URL('../../../backend/fixtures/conversations/generated/sessions.jsonl', import.meta.url), 'utf8');
  const sessions = source.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(growthHistory.provenance.synthetic, true);
  assert.equal(growthHistory.provenance.responseOrigin, 'authored_reference');
  assert.equal(growthHistory.sessions.length, 365);
  for (const [index, original] of sessions.entries()) {
    const exported = growthHistory.sessions[index];
    assert.equal(exported.id, original.session_id);
    assert.equal(exported.date, original.local_date);
    assert.deepEqual(exported.messages, original.messages.map((message: { id: string; role: string; content: string }) => ({
      id: message.id, role: message.role, content: message.content,
    })));
  }
});

test('month summaries span the year boundary and count conversations rather than inferred growth', () => {
  assert.equal(growthMonths.length, 12);
  assert.equal(growthMonths[0], '2025-11');
  assert.equal(growthMonths.at(-1), '2026-10');
  assert.equal(summarizeMonth('2025-12').cumulativeSessions, 61);
  assert.equal(summarizeMonth('2026-02').sessionCount, 28);
  assert.equal(summarizeMonth('2026-02').cumulativeSessions, 120);
  assert.equal(summarizeMonth('2026-10').cumulativeSessions, 365);
  assert.equal(summarizeMonth('2026-10').cumulativeMessages, 2932);
  assert.equal(growthMonths.reduce((sum, month) => sum + summarizeMonth(month).exchangeCount, 0), 1466);
  assert.equal(growthHistory.sessions.find(session => session.date === '2026-05-13')?.age, 6);
  assert.equal(growthHistory.sessions.find(session => session.date === '2026-05-14')?.age, 7);
});

test('each bilingual monthly milestone cites original child messages from its actual date', () => {
  assert.deepEqual(growthMilestones.map(milestone => milestone.month), growthMonths);
  for (const milestone of growthMilestones) {
    const session = growthHistory.sessions.find(session => session.date === milestone.date);
    assert.ok(session);
    assert.ok(milestone.title.en && milestone.title.vi && milestone.description.en && milestone.description.vi);
    assert.equal(milestone.date.slice(0, 7), milestone.month);
    assert.ok(milestone.messageIds.length);
    for (const id of milestone.messageIds) assert.ok(session.messages.some(message => message.id === id && message.role === 'user'));
  }
});
