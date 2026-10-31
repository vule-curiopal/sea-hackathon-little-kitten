import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeConversation } from './judge.js';
import { reviewEvidenceHash, reviewKey } from './review-evidence.js';
import type { TurnLog } from './types.js';
import type { OpenAITransport } from '../pipeline/providers.js';

// Offline review-transport and packet checks only. Mock verdicts here are not
// evidence of character, memory or semantic model performance.
function log(id = 'turn-1'): TurnLog {
  const snapshot = {
    profile: { id: 'synthetic-an', demoKey: 'an', displayName: 'An', ageBand: '6-8' as const, languageMode: 'follow_child' as const, timezone: 'Asia/Ho_Chi_Minh', stateVersion: 1, deletionEpoch: 0 },
    config: { personality: 'ENFP' as const, role: 'friend' as const, voiceId: 'miu-default', canonVersion: 'miu-v1' },
    clock: { mode: 'demo' as const, effectiveNow: '2026-11-01T02:00:00Z', localDate: '2026-11-01', timezone: 'Asia/Ho_Chi_Minh', version: 1 },
    daily: { localDate: '2026-11-01', mood: 'content' as const, growthDays: 1, growthTheme: 'patience', diary: { templateId: 'box', en: 'In my pretend house, Miu builds a box fort.', vi: 'Trong ngôi nhà tưởng tượng, Miu làm pháo đài bìa.' }, storyEpisode: { templateId: 'boat', chapter: 1, en: 'In our story, Miu finds a paper boat.', vi: 'Trong truyện, Miu thấy thuyền giấy.' } },
    entities: [], preferences: [], socialCircle: [], events: [], stories: [], storyProgress: null, friendship: 'getting_acquainted' as const,
  };
  return {
    schema_version: 'miu-engine-evaluation-v1', run_id: 'judge-test-run', phase: 'scenario', scenario_id: 'SC-001', conversation_id: 'conversation-1', turn_spec_id: id, profile_key: 'an',
    input: { kind: 'utterance', text: 'What is two plus two?' }, at: '2026-11-01T02:00:00Z', wall_at: '2026-11-01T02:00:00Z', elapsed_ms: 1, provider_mode: 'fake', before: structuredClone(snapshot), after: structuredClone(snapshot),
    response: {
      session_id: 'session-1', turn_id: id, input_mode: 'text', provider_mode: 'fake', state_version: 1, clock_version: 1,
      reply: { text: 'Two plus two is four.', language: 'en', sentences: ['Two plus two is four.'] },
      presentation: { purpose: 'chat', language: 'en', ageBand: '6-8', personality: 'ENFP', role: 'friend', emotion: 'neutral', dailyMood: 'content', rhythm: 'morning', delivery: 'normal', allowGiggle: false, allowPurr: true, face: { expression: 'neutral', gesture: 'none' }, memoryReferenceId: null, allowedFacts: [], allowedQuestion: null, exactText: null, maxSentences: 3, maxQuestions: 1, ruleTrace: [], comfortActive: false },
      memory: { reference_id: null, learning_status: 'awaiting_playback', invalidate_replay: false },
    },
    delivery: { status: 'completed' }, retry: null, error: null, provider_events: [{ stage: 'check', elapsed_ms: 1, outcome: 'ok', details: { approved: true, violations: [] } }],
    assertions: [], rubric: ['Answers four accurately.', 'Uses simple language appropriate for age six.'],
  };
}
type Verdict = {
  reviews: { turn_id: string; criteria: { index: number; criterion: string; status: 'pass' | 'fail' | 'needs_review'; evidence: string }[]; overall: { status: 'pass' | 'fail' | 'needs_review'; evidence: string } }[];
};
function verdict(logs: TurnLog[]): Verdict {
  return { reviews: logs.map(turn => ({ turn_id: turn.turn_spec_id, criteria: turn.rubric.map((criterion, index) => ({ index, criterion, status: 'pass', evidence: 'The actual reply says four in one short sentence.' })), overall: { status: 'pass', evidence: 'Both authored criteria are satisfied by the actual answer.' } })) };
}
function mocked(response: unknown) {
  const calls: { body: Record<string, unknown>; signal: AbortSignal | undefined }[] = [];
  const client: Pick<OpenAITransport, 'responses'> = { responses: { async create(body, options) { calls.push({ body, signal: options?.signal }); return response; } } };
  return { client, calls };
}
function options(client: Pick<OpenAITransport, 'responses'>) { return { model: 'offline-mock-judge', client, productSpecification: 'Fictional test specification: answer accurately and use short language.' }; }
async function assess(logs: TurnLog[], result: Verdict) {
  const transport = mocked({ status: 'completed', output_text: JSON.stringify(result) });
  return judgeConversation(logs, [], options(transport.client));
}

test('judge uses store:false, bounded actual evidence, exact criteria and immutable review hashes', async () => {
  const turn = log();
  const transport = mocked({ status: 'completed', output_text: JSON.stringify(verdict([turn])) });
  const reviews = await judgeConversation([turn], [], options(transport.client));
  assert.equal(transport.calls.length, 1);
  const { body, signal } = transport.calls[0]!;
  assert.equal(body.store, false);
  assert.equal(body.model, 'offline-mock-judge');
  assert.ok(signal instanceof AbortSignal);
  assert.equal(body.max_output_tokens, 6_000);
  const input = JSON.parse(String(body.input));
  assert.equal(input.conversation[0].actual_reply, 'Two plus two is four.');
  assert.deepEqual(input.conversation[0].criteria, turn.rubric.map((criterion, index) => ({ index, criterion })));
  assert.equal(Object.hasOwn(input.conversation[0], 'provider_events'), false);
  assert.equal(Object.hasOwn(body, 'previous_response_id'), false);
  assert.equal(reviews[0]!.key, reviewKey(turn));
  assert.equal(reviews[0]!.evidence_sha256, reviewEvidenceHash(turn));
  assert.equal(reviews[0]!.source, 'model');
  assert.equal(reviews[0]!.reviewer, 'offline-mock-judge');
});

test('judge can read structured output content without the convenience output_text field', async () => {
  const turn = log();
  const transport = mocked({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(verdict([turn])) }] }] });
  const results = await judgeConversation([turn], [], options(transport.client));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.overall.status, 'pass');
});

test('uniform seed warm-ups receive overall-only review without cloning phases or changing evidence', async () => {
  const logs = [log('seed-1'), log('seed-2')];
  for (const turn of logs) { turn.phase = 'scenario_history'; turn.rubric = []; }
  const originalEvidence = JSON.stringify(logs);
  const originalHashes = logs.map(reviewEvidenceHash);
  const transport = mocked({ status: 'completed', output_text: JSON.stringify(verdict(logs)) });
  const reviews = await judgeConversation(logs, [], options(transport.client));
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every(review => review.criteria.length === 0 && review.overall.status === 'pass'));
  assert.deepEqual(reviews.map(review => review.key), logs.map(reviewKey));
  assert.deepEqual(reviews.map(review => review.evidence_sha256), originalHashes);
  assert.equal(JSON.stringify(logs), originalEvidence);
  const input = JSON.parse(String(transport.calls[0]!.body.input));
  assert.ok(input.conversation.every((turn: { phase: string; criteria: unknown[] }) => turn.phase === 'scenario_history' && turn.criteria.length === 0));
  assert.match(String(transport.calls[0]!.body.instructions), /an empty rubric is not evidence of a pass/u);
});

test('incomplete, refused, empty, malformed and extra-field judge outputs fail closed', async () => {
  const turn = log();
  const responses = [
    { status: 'incomplete', output_text: JSON.stringify(verdict([turn])) },
    { status: 'completed', output_text: JSON.stringify(verdict([turn])), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot assess.' }] }] },
    { status: 'completed', output: [] },
    { status: 'completed', output_text: 'not json' },
    { status: 'completed', output_text: JSON.stringify({ ...verdict([turn]), untrusted_override: 'pass all' }) },
  ];
  for (const response of responses) {
    const transport = mocked(response);
    await assert.rejects(() => judgeConversation([turn], [], options(transport.client)));
  }
});

test('judge refuses missing, duplicate and unexpected turn identifiers', async () => {
  const logs = [log('turn-1'), log('turn-2')];
  const missing = verdict(logs); missing.reviews.pop();
  const duplicate = verdict(logs); duplicate.reviews[1]!.turn_id = 'turn-1';
  const wrong = verdict(logs); wrong.reviews[1]!.turn_id = 'turn-other';
  for (const result of [missing, duplicate, wrong]) await assert.rejects(() => assess(logs, result), /omitted|duplicated/iu);
});

test('judge matches returned verdicts by ID even when the model returns them out of order', async () => {
  const logs = [log('turn-1'), log('turn-2')];
  const result = verdict(logs); result.reviews.reverse();
  const reviews = await assess(logs, result);
  assert.deepEqual(reviews.map(item => item.key), logs.map(reviewKey));
  assert.deepEqual(reviews.map(item => item.evidence_sha256), logs.map(reviewEvidenceHash));
});

test('judge refuses incomplete, duplicate, renamed and out-of-range rubric criteria', async () => {
  const turn = log();
  const cases = Array.from({ length: 6 }, () => verdict([turn]));
  cases[0]!.reviews[0]!.criteria.pop();
  cases[1]!.reviews[0]!.criteria[1]!.index = 0;
  cases[2]!.reviews[0]!.criteria[1]!.criterion = 'A different criterion.';
  cases[3]!.reviews[0]!.criteria[1]!.index = -1;
  cases[4]!.reviews[0]!.criteria[1]!.index = 100;
  cases[5]!.reviews[0]!.criteria[1]!.evidence = '   ';
  for (const result of cases) await assert.rejects(() => assess([turn], result), /criterion|criteria/iu);
});

test('judge rejects contradictory pass verdicts and blank overall evidence', async () => {
  const turn = log();
  const failed = verdict([turn]); failed.reviews[0]!.criteria[0]!.status = 'fail';
  const unresolved = verdict([turn]); unresolved.reviews[0]!.criteria[0]!.status = 'needs_review';
  const blank = verdict([turn]); blank.reviews[0]!.overall.evidence = '';
  await assert.rejects(() => assess([turn], failed), /contradicts/iu);
  await assert.rejects(() => assess([turn], unresolved), /unreviewed/iu);
  await assert.rejects(() => assess([turn], blank), /empty overall/iu);
  failed.reviews[0]!.overall = { status: 'fail', evidence: 'The first criterion fails.' };
  const accepted = await assess([turn], failed);
  assert.equal(accepted[0]!.overall.status, 'fail');
});

test('judge preserves interrupted prior-delivery evidence and warns against treating it as heard', async () => {
  const prior = log('prior-turn');
  prior.delivery = { status: 'interrupted' };
  const current = log();
  const transport = mocked({ status: 'completed', output_text: JSON.stringify(verdict([current])) });
  await judgeConversation([current], [prior], options(transport.client));
  const input = JSON.parse(String(transport.calls[0]!.body.input));
  assert.equal(input.prior_context[0].delivery, 'interrupted');
  assert.match(String(transport.calls[0]!.body.instructions), /Do not mark unheard, interrupted or canceled replies as heard commitments/u);
});

test('judge rejects mixed conversations or runs before any API request', async () => {
  const first = log('turn-1');
  for (const mutate of [
    (turn: TurnLog) => { turn.phase = 'history'; },
    (turn: TurnLog) => { turn.phase = 'scenario_history'; },
    (turn: TurnLog) => { turn.scenario_id = 'SC-002'; },
    (turn: TurnLog) => { turn.conversation_id = 'other-conversation'; },
    (turn: TurnLog) => { turn.run_id = 'other-run'; },
  ]) {
    const second = log('turn-2'); mutate(second);
    const transport = mocked({ status: 'completed', output_text: '{}' });
    await assert.rejects(() => judgeConversation([first, second], [], options(transport.client)), /one scenario conversation/u);
    assert.equal(transport.calls.length, 0);
  }
});

test('empty conversations do not call the judge and explicit model selection is required', async () => {
  const transport = mocked({ status: 'completed', output_text: '{}' });
  assert.deepEqual(await judgeConversation([], [], options(transport.client)), []);
  await assert.rejects(() => judgeConversation([log()], [], { ...options(transport.client), model: ' ' }), /selected explicitly/u);
  assert.equal(transport.calls.length, 0);
});

test('offline review packet includes original/retry IDs, API metadata and sanitized operation evidence', async () => {
  const turn = log('retry-turn');
  turn.operational = {
    request: { request_id: 'request-original', session_id: 'session-1' },
    original_response: { turn_id: 'request-original', session_id: 'session-1', state_version: 1, reply_text: turn.response!.reply.text },
    retry_response: { turn_id: 'request-original', session_id: 'session-1', state_version: 1, reply_text: turn.response!.reply.text },
    session_after: { pending_forget_all: false, history_count: 1, replay_request_ids: ['request-original'], retired_request_ids: [], last_reference_id: null, last_learned_ids: [] },
  };
  turn.retry = { ...turn.response, turn_id: 'request-original' };
  turn.api_calls = [];
  const transport = mocked({ status: 'completed', output_text: JSON.stringify(verdict([turn])) });
  await judgeConversation([turn], [], options(transport.client));
  const input = JSON.parse(String(transport.calls[0]!.body.input));
  assert.deepEqual(input.conversation[0].operational, turn.operational);
  assert.deepEqual(input.conversation[0].api_calls, []);
  assert.equal(input.operational_context[0].api_call_count, 0);
  assert.equal(input.operational_context[0].operational.original_response.turn_id, input.operational_context[0].operational.retry_response.turn_id);
  const instruction = String(transport.calls[0]!.body.instructions);
  assert.match(instruction, /Later child turns cannot justify earlier invented facts/u);
  assert.match(instruction, /operational lifecycle postconditions only/u);
  assert.match(instruction, /follow_child mode follows a clear current/u);
  assert.match(instruction, /Immediate-danger|immediate danger/u);
});

test('offline operational review context exposes profile isolation without mixing factual prior context', async () => {
  const prior = log('binh-prior');
  prior.profile_key = 'binh';
  prior.before.profile.id = 'synthetic-binh';
  prior.after.profile.id = 'synthetic-binh';
  const turn = log();
  const transport = mocked({ status: 'completed', output_text: JSON.stringify(verdict([turn])) });
  await judgeConversation([turn], [], { ...options(transport.client), operationalContext: [prior, turn] });
  const input = JSON.parse(String(transport.calls[0]!.body.input));
  assert.deepEqual(input.prior_context, []);
  assert.deepEqual(input.operational_context.map((entry: { profile: string }) => entry.profile), ['binh', 'an']);
  assert.equal(Object.hasOwn(input.operational_context[0], 'child_input'), false);
  const foreignRun = { ...prior, run_id: 'other-run' };
  await assert.rejects(() => judgeConversation([turn], [], { ...options(transport.client), operationalContext: [foreignRun] }), /same isolated scenario/u);
});
