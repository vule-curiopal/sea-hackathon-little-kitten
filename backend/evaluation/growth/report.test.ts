import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TurnResponse } from '../../application.js';
import type { MemoryContext, Observation } from '../../shared/types.js';
import { GROWTH_EXPECTATIONS, type GrowthExpectation } from './expectations.js';
import { evaluateGrowthExpectations, growthEvidenceValidity, growthMechanismChecks, writeGrowthReport } from './report.js';
import type { GrowthReplayResult, GrowthTurnLog } from './types.js';

/**
 * Pure grader unit fixtures only. Every state/reply below is explicitly fabricated
 * to exercise grading branches. No application, database, provider, or model runs;
 * these objects must never be archived as model-performance evaluation evidence.
 * The provider label is schema metadata, not proof of an API call.
 */
const UNIT_NOTICE = 'Fabricated grader unit fixture; no provider execution or model-performance evidence.';

function context(date = '2025-11-01'): MemoryContext {
  return {
    profile: { id: 'unit-profile', demoKey: 'unit-an', displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh', stateVersion: 1, deletionEpoch: 0 },
    config: { personality: 'ENFP', role: 'friend', voiceId: 'unit-voice', canonVersion: 'miu-v1' },
    clock: { mode: 'demo', effectiveNow: `${date}T02:00:00.000Z`, localDate: date, timezone: 'Asia/Ho_Chi_Minh', version: 1 },
    daily: {
      localDate: date, mood: 'content', growthDays: 0, growthTheme: 'unit fixture theme',
      diary: { templateId: 'unit-diary', en: 'Unit fixture diary.', vi: 'Nhật ký giả lập cho kiểm thử bộ chấm.' },
      storyEpisode: { templateId: 'unit-episode', chapter: 0, en: 'Unit fixture episode.', vi: 'Chương giả lập cho kiểm thử bộ chấm.' },
    },
    entities: [], preferences: [], socialCircle: [], events: [], stories: [], storyProgress: null,
    friendship: 'getting_acquainted',
  };
}

function response(sourceMessageId: string, snapshot: MemoryContext): TurnResponse {
  return {
    session_id: 'unit-session', turn_id: `unit-turn-${sourceMessageId}`,
    input_mode: 'text', provider_mode: 'real',
    state_version: snapshot.profile.stateVersion, clock_version: snapshot.clock.version,
    reply: { text: 'Unit fixture acknowledgment.', sentences: ['Unit fixture acknowledgment.'], language: 'en' },
    presentation: {
      purpose: 'chat', language: 'en', ageBand: '6-8', personality: 'ENFP', role: 'friend',
      emotion: 'neutral', dailyMood: 'content', rhythm: 'morning', delivery: 'normal',
      allowGiggle: false, allowPurr: false, face: { expression: 'neutral', gesture: 'none' },
      memoryReferenceId: null, allowedFacts: [], allowedQuestion: null, exactText: null,
      maxSentences: 3, maxQuestions: 1, ruleTrace: [], comfortActive: false,
    },
    memory: { reference_id: null, learning_status: 'awaiting_playback', invalidate_replay: false },
  };
}

function turn(sourceMessageId: string, sourceText: string, before: MemoryContext, after: MemoryContext): GrowthTurnLog {
  const observation: Observation = { intent: 'chat', language: 'en', statedFeeling: null, uncertain: false, candidates: [], forgetTarget: null, suppressLearning: false };
  const at = `${after.clock.localDate}T02:00:00.000Z`;
  return {
    schemaVersion: 'miu-growth-replay-v1', dayIndex: 0, date: after.clock.localDate,
    run_kind: 'harness_self_test', character_memory_quality_evidence: false,
    sourceSessionId: `unit-session-${after.clock.localDate}`, sourceMessageId,
    referenceMessageId: `unit-reference-${sourceMessageId}`, sourceUserTimestamp: at,
    referenceTimestamp: at, referenceReply: UNIT_NOTICE,
    turnId: `unit-turn-${sourceMessageId}`, input: { kind: 'utterance', text: sourceText }, at,
    providerMode: 'real', elapsedMs: 0, providerCalls: [], apiCalls: [],
    replyOrigin: 'unverified', classificationEvidence: null, modelReply: null,
    response: response(sourceMessageId, after), before: structuredClone(before), after: structuredClone(after),
    localObservation: observation, providerObservation: null,
    delivery: { status: 'completed', started: true, completed: true, receiptStatus: 'completed', learningStatus: 'complete' },
    error: null, recoveryError: null, afterSnapshotError: null,
    createdRecordIds: [], removedRecordIds: [], recordCountBefore: 0, recordCountAfter: 0,
  };
}

function replay(turns: GrowthTurnLog[]): GrowthReplayResult {
  const first = turns[0]!;
  const last = turns.at(-1)!;
  const dates = new Set(turns.map(item => item.date));
  return {
    outputDir: 'unit-fixture-no-files-written',
    summary: {
      schemaVersion: 'miu-growth-replay-v1', runId: 'unit-grader-fixture-no-model-run', synthetic: true, provider: 'real',
      run_kind: 'harness_self_test', character_memory_quality_evidence: false,
      status: 'complete', blocked: null, processedSessions: dates.size, models: null,
      providerCallCounts: { classify: 0, reply: 0, check: 0 },
      apiCallCounts: { classify: 0, reply: 0, check: 0, moderation_input: 0, moderation_output: 0 },
      modelAuthoredTurns: 0, authoredReplyBypasses: 0, unverifiedReplyTurns: turns.length,
      outputDir: 'unit-fixture-no-files-written', from: first.date, to: last.date,
      sessions: dates.size, sourceTurns: turns.length, attemptedTurns: turns.length,
      completedTurns: turns.length, turnErrors: 0, firstGrowthDay: 0, finalGrowthDay: 0,
      nightJobCount: 0, distinctDiaryTemplates: 0, distinctGrowthThemes: 0, friendshipStages: {},
      recordsCreatedDuringTurns: 0, recordsRemovedDuringTurns: 0, finalActiveRecords: 0,
      dayChecks: { pass: 0, fail: 0 }, failures: [], errorCodes: {}, checks: [], limitations: [UNIT_NOTICE],
    },
    days: [], turns,
    finalSnapshot: {
      at: last.at, context: structuredClone(last.after),
      evidence: {
        records: [], dependencies: [], followups: [], checkpoints: [], promises: [], nightJobs: [], diaryEntries: [],
        dailyStateRows: 0, learningReceiptCount: 0, kindCounts: {},
      },
    },
  };
}

test('pure growth grader distinguishes positive state, missing prerequisites, and unjudged dialogue', () => {
  const empty = context();
  const withDog = structuredClone(empty);
  withDog.entities.push({ id: 'unit-mochi', kind: 'pet', name: 'Mochi', species: 'dog', aliases: [], expiresAt: '2025-12-01T02:00:00.000Z' });
  const capture = turn('unit-child-1', 'My dog Mochi is happy', empty, withDog);
  const withStory = structuredClone(withDog);
  withStory.storyProgress = {
    id: 'unit-checkpoint', templateId: 'unit-story', chapter: 0, status: 'active',
    title: { en: 'Unit fixture story', vi: 'Truyện giả lập kiểm thử' },
    scene: { en: 'Unit fixture story scene.', vi: 'Cảnh giả lập cho kiểm thử bộ chấm.' },
  };
  const story = turn('unit-child-2', 'Tell me a story', withDog, withStory);
  story.response!.presentation.purpose = 'story';
  story.response!.reply.text = withStory.storyProgress.scene.en;
  story.response!.reply.sentences = [withStory.storyProgress.scene.en];
  const fixture = replay([capture, story]);
  const base: GrowthExpectation = {
    id: 'capture', date: capture.date, sourceMessageId: capture.sourceMessageId, sourceText: capture.input.text,
    description: 'Grade a fabricated positive pet snapshot.', category: 'capture', expectedBehavior: ['Save Mochi.'], scope: 'state', level: 'P0',
    checks: [{ requirement: 'MEM-01', description: 'Mochi is present in the unit snapshot.', target: 'after.entities', op: 'contains', value: { name: 'Mochi' } }],
  };
  const results = evaluateGrowthExpectations([
    base,
    { ...base, id: 'missed', checks: [{ ...base.checks![0]!, value: { name: 'NeverIntroduced' } }] },
    { ...base, id: 'vacuous-delete', preconditions: [{ requirement: 'MEM-03', description: 'Ben must exist before deletion can be established.', target: 'before.entities', op: 'contains', value: { name: 'Ben' } }],
      checks: [{ requirement: 'MEM-03', description: 'Ben is absent afterward.', target: 'after.entities', op: 'not_contains', value: { name: 'Ben' } }] },
    { ...base, id: 'dependency', dependsOn: ['missed'] },
    { ...base, id: 'dialogue', scope: 'dialogue' },
    { ...base, id: 'wrong-source', sourceText: 'An invented source anchor' },
  ], fixture);
  assert.deepEqual(results.map(result => [result.id, result.status]), [
    ['capture', 'pass'], ['missed', 'fail'], ['vacuous-delete', 'needs_review'],
    ['dependency', 'needs_review'], ['dialogue', 'needs_review'], ['wrong-source', 'fail'],
  ]);
  assert.equal(results[2]!.checks.length, 0, 'A missing positive precursor cannot establish successful deletion.');
  assert.equal(growthMechanismChecks(fixture).length, 1);
  assert.equal(growthMechanismChecks(fixture)[0]!.status, 'pass');
  const unrelatedSpeech = structuredClone(fixture);
  unrelatedSpeech.turns[1]!.response!.presentation.purpose = 'comfort';
  assert.equal(growthMechanismChecks(unrelatedSpeech)[0]!.status, 'fail');
  assert.equal(fixture.summary.modelAuthoredTurns, 0);
  assert.equal(fixture.turns.flatMap(item => item.apiCalls).length, 0);
});

function reconfirmationFixture() {
  const expectations = GROWTH_EXPECTATIONS.filter(item => ['may-volunteered-thunder-fear', 'may-explicit-thunder-reconfirmation', 'jul-thunder-retention-expiry'].includes(item.id));
  const captureExpectation = expectations[0]!;
  const reconfirmExpectation = expectations[1]!;
  const expiryExpectation = expectations[2]!;
  const oldFear = { id: 'unit-thunder-fear', category: 'fear' as const, value: 'sấm', expiresAt: '2026-06-06T11:40:29.000Z' };
  const firstBefore = context(captureExpectation.date);
  const firstAfter = structuredClone(firstBefore);
  firstAfter.preferences.push(oldFear);
  const capture = turn(captureExpectation.sourceMessageId, captureExpectation.sourceText, firstBefore, firstAfter);
  const reconfirmBefore = context(reconfirmExpectation.date);
  reconfirmBefore.preferences.push(oldFear);
  const reconfirmation = turn(reconfirmExpectation.sourceMessageId, reconfirmExpectation.sourceText, reconfirmBefore, reconfirmBefore);
  const expired = context(expiryExpectation.date);
  const expiry = turn(expiryExpectation.sourceMessageId, expiryExpectation.sourceText, expired, expired);
  return { expectations, fixture: replay([capture, reconfirmation, expiry]) };
}

test('pure grader rejects a still-present fear as reconfirmation unless its exact expiry was renewed', () => {
  const { expectations, fixture } = reconfirmationFixture();
  const results = evaluateGrowthExpectations(expectations, fixture);
  assert.deepEqual(results.map(result => [result.id, result.status]), [
    ['may-volunteered-thunder-fear', 'pass'],
    ['may-explicit-thunder-reconfirmation', 'fail'],
    ['jul-thunder-retention-expiry', 'needs_review'],
  ]);
  assert.ok(results[1]!.checks.some(check => check.status === 'fail' && check.evidence.includes('2026-06-30T11:41:18.000Z')));
  const renewed = structuredClone(fixture);
  renewed.turns[1]!.after.preferences[0]!.expiresAt = '2026-06-30T11:41:18.000Z';
  assert.deepEqual(evaluateGrowthExpectations(expectations, renewed).map(result => result.status), ['pass', 'pass', 'pass']);
  const duplicate = structuredClone(renewed);
  duplicate.turns[1]!.after.preferences.push({ ...duplicate.turns[1]!.after.preferences[0]!, id: 'unit-duplicate-fear' });
  const duplicateResult = evaluateGrowthExpectations(expectations, duplicate)[1]!;
  assert.equal(duplicateResult.status, 'fail');
  assert.ok(duplicateResult.checks.some(check => check.status === 'fail' && check.evidence.includes('after.preferences.length')));
});

test('pure grader leaves unattempted anchors unreviewed after a blocked run', () => {
  const first = turn('unit-attempted', 'Unit fixture input.', context(), context());
  const fixture = replay([first]);
  fixture.summary.status = 'blocked';
  fixture.summary.blocked = { date: '2025-11-02', sourceMessageId: 'unit-unattempted', stage: 'reply', code: 'unit_block_reason' };
  const expectations: GrowthExpectation[] = [{
    id: 'unattempted', date: '2025-11-02', sourceMessageId: 'unit-unattempted', sourceText: 'Unit fixture not executed.',
    description: 'An unattempted anchor has no performance result.', category: 'coverage', expectedBehavior: ['Do not infer a result.'], scope: 'state', level: 'P0',
  }];
  const [result] = evaluateGrowthExpectations(expectations, fixture);
  assert.equal(result!.status, 'needs_review');
  assert.match(result!.notes.join(' '), /not attempted/i);
  assert.deepEqual(result!.checks, []);
});

test('pure report formatter excludes harness and legacy fake passes without rewriting original diagnostics', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'miu-growth-report-policy-'));
  try {
    const before = context();
    const after = structuredClone(before);
    after.entities.push({ id: 'unit-pet', kind: 'pet', name: 'Mochi', species: 'dog', aliases: [], expiresAt: '2025-12-01T02:00:00.000Z' });
    const item = turn('unit-capture', 'My dog is named Mochi.', before, after);
    const fixture = replay([item]);
    fixture.outputDir = parent;
    fixture.summary.outputDir = parent;
    const expectation: GrowthExpectation = {
      id: 'unit-capture', date: item.date, sourceMessageId: item.sourceMessageId, sourceText: item.input.text,
      description: 'Check a fabricated report-state branch.', category: 'unit_fixture', expectedBehavior: ['Recognize the fixture pet snapshot.'], scope: 'state', level: 'P0',
      checks: [{ requirement: 'MEM-01', description: 'The fabricated fixture includes Mochi.', target: 'after.entities', op: 'contains', value: { name: 'Mochi' } }],
    };
    const original = 'Preserved unit fixture diagnostics; no provider execution.\n';
    await writeFile(join(parent, 'turns.jsonl'), original);
    assert.equal(growthEvidenceValidity(fixture).character_memory_quality_evidence, false);
    const report = await writeGrowthReport(fixture, [expectation], null, { origin: 'harness_unit_fixture', checksum: 'unit-test-only', datasetId: null, originalArchiveModified: false });
    assert.equal(report.evidenceClassification, 'diagnostics_not_model_evaluation');
    assert.equal(report.character_memory_quality_evidence, false);
    assert.equal(report.modelEvidence.modelAuthoredTurns, 0);
    assert.equal(report.modelEvidence.approvedCompletedTurns, 0);
    assert.equal(report.expectations.includedInModelEvaluation, false);
    assert.equal(report.expectations.statuses.pass ?? 0, 0);
    assert.equal(report.expectations.results[0]!.status, 'needs_review');
    assert.equal(report.diagnosticOnly!.expectations[0]!.status, 'pass');
    assert.equal(await readFile(join(parent, 'turns.jsonl'), 'utf8'), original);
    assert.match(await readFile(join(parent, 'report.md'), 'utf8'), /Excluded from character and memory acceptance/);
    const legacy = structuredClone(fixture);
    legacy.summary.provider = 'fake';
    Reflect.deleteProperty(legacy.summary, 'run_kind');
    assert.equal(growthEvidenceValidity(legacy).character_memory_quality_evidence, false);
    const relabeled = structuredClone(fixture);
    relabeled.summary.character_memory_quality_evidence = true;
    assert.equal(growthEvidenceValidity(relabeled).character_memory_quality_evidence, false, 'A claimed quality flag cannot promote a harness fixture.');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
