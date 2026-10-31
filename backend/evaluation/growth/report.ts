import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateTurn } from '../evaluate.js';
import type { CheckResult, TurnLog } from '../types.js';
import type { GrowthExpectation } from './expectations.js';
import type { GrowthReplayResult, GrowthTurnLog } from './types.js';
import type { auditCapture } from './capture-audit.js';

type Status = 'pass' | 'fail' | 'needs_review';
export interface GrowthExpectationResult {
  id: string; date: string; category: string; description: string;
  level: string; scope: string; sourceMessageId: string; sourceText: string;
  expectedBehavior: string[]; status: Status; checks: CheckResult[];
  preconditions: CheckResult[];
  actualReply: string | null; notes: string[];
}
export interface GrowthSourceEvidence {
  origin: string; checksum: string; datasetId: string | null;
  originalArchiveModified: false;
}
type CaptureAudit = ReturnType<typeof auditCapture>;

function evaluationLog(turn: GrowthTurnLog, runId: string): TurnLog {
  return {
    schema_version: 'miu-engine-evaluation-v1', run_id: runId, run_kind: turn.run_kind, phase: 'history', scenario_id: null,
    conversation_id: turn.sourceSessionId, turn_spec_id: turn.sourceMessageId, source_message_id: turn.sourceMessageId,
    profile_key: 'an', input: turn.input, at: turn.at, wall_at: turn.at,
    elapsed_ms: turn.elapsedMs, provider_mode: turn.providerMode,
    response: turn.response, before: turn.before, after: turn.after,
    delivery: { status: turn.delivery.status, ...(turn.delivery.receiptStatus ? { receipt_status: turn.delivery.receiptStatus } : {}), ...(turn.delivery.learningStatus ? { learning_status: turn.delivery.learningStatus } : {}) },
    error: turn.error, ...(turn.afterSnapshotError ? { after_snapshot_error: turn.afterSnapshotError } : {}),
    retry: null, provider_events: (turn.providerCalls ?? []).map(call => ({
      stage: call.stage, elapsed_ms: call.elapsedMs, outcome: call.outcome,
      ...(call.errorCode ? { error_code: call.errorCode } : {}),
      details: { model: call.model, authored_bypass: call.authoredBypass },
    })), assertions: [], rubric: [],
  };
}

export function evaluateGrowthExpectations(expectations: readonly GrowthExpectation[], replay: GrowthReplayResult): GrowthExpectationResult[] {
  const byMessage = new Map(replay.turns.map(turn => [turn.sourceMessageId, turn]));
  const results = expectations.map(expectation => {
    const turn = byMessage.get(expectation.sourceMessageId);
    const result: GrowthExpectationResult = {
      id: expectation.id, date: expectation.date, category: expectation.category, description: expectation.description,
      level: expectation.level, scope: expectation.scope, sourceMessageId: expectation.sourceMessageId,
      sourceText: expectation.sourceText, expectedBehavior: expectation.expectedBehavior,
      status: 'needs_review', checks: [], preconditions: [], actualReply: turn?.response?.reply.text ?? null, notes: [],
    };
    if (!turn) {
      const outsideRequestedRange = expectation.date < replay.summary.from || expectation.date > replay.summary.to;
      result.status = replay.summary.status === 'blocked' || outsideRequestedRange ? 'needs_review' : 'fail';
      result.notes.push(replay.summary.status === 'blocked' || outsideRequestedRange
        ? 'Not attempted in the completed coverage of this real-model replay. No result is inferred for this source anchor.'
        : 'The exact independently authored source anchor was not replayed.');
      return result;
    }
    if (turn.input.text !== expectation.sourceText || turn.date !== expectation.date) {
      result.status = 'fail';
      result.notes.push('The exact independently authored source anchor was not replayed.');
      return result;
    }
    if (turn.error || turn.afterSnapshotError || !turn.delivery.completed) {
      result.status = 'fail';
      result.notes.push(`Turn was not completed with a valid state snapshot: ${turn.error?.code ?? turn.afterSnapshotError ?? 'undelivered'}.`);
    }
    if (expectation.preconditions?.length) {
      result.preconditions = evaluateTurn({ ...evaluationLog(turn, replay.summary.runId), assertions: expectation.preconditions }).checks.filter(check => check.id.startsWith('assertion:'));
      if (result.preconditions.some(check => check.status !== 'pass')) {
        result.notes.push('The required prior positive state was not established, so this lifecycle operation is not demonstrated.');
        return result;
      }
    }
    const assertions = expectation.checks ?? [];
    if (assertions.length) {
      const checked = evaluateTurn({ ...evaluationLog(turn, replay.summary.runId), assertions });
      result.checks = checked.checks.filter(check => check.id.startsWith('assertion:'));
      if (result.checks.length !== assertions.length || result.checks.some(check => check.status === 'fail')) result.status = 'fail';
      else if (result.status !== 'fail' && expectation.scope === 'state') result.status = 'pass';
    }
    if (result.status !== 'fail' && expectation.scope !== 'state') {
      result.status = 'needs_review';
      result.notes.push('Observable checks do not establish full dialogue quality. No independent semantic review is attached to this expectation; a generation-time safety verdict is not a full rubric assessment.');
    }
    if (!assertions.length) result.notes.push('This expectation has no complete automatic assertion; inspect the linked source and actual reply.');
    return result;
  });
  const byId = new Map(results.map(result => [result.id, result]));
  for (const expectation of expectations) {
    const result = byId.get(expectation.id)!;
    for (const prerequisite of expectation.dependsOn ?? []) {
      const prior = byId.get(prerequisite);
      if (!prior || prior.status !== 'pass') {
        result.notes.push(`Lifecycle prerequisite ${prerequisite} was not demonstrated. An absent memory alone cannot establish successful deletion, expiry, or reconfirmation.`);
        if (result.status === 'pass') result.status = 'needs_review';
      }
    }
  }
  return results;
}

export function growthMechanismChecks(replay: GrowthReplayResult) {
  return replay.turns.filter(turn => {
    const before = turn.before.storyProgress;
    const after = turn.after.storyProgress;
    return after && (!before || before.id !== after.id || before.chapter !== after.chapter || before.status !== after.status);
  }).map(turn => {
    const progress = turn.after.storyProgress!;
    const response = turn.response;
    const valid = turn.delivery.completed && response?.presentation.purpose === 'story'
      && response.reply.text === progress.scene[response.reply.language];
    return {
      sourceMessageId: turn.sourceMessageId, date: turn.date,
      check: 'story_progress_requires_completed_story_scene', status: valid ? 'pass' as const : 'fail' as const,
      evidence: { input: turn.input.text, purpose: response?.presentation.purpose ?? null, reply: response?.reply.text ?? null, chapter: progress.chapter, templateId: progress.templateId },
    };
  });
}

const cell = (value: unknown) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const short = (value: string, length = 180) => value.length > length ? value.slice(0, length) + '…' : value;
const countBy = <T>(values: T[], label: (value: T) => string) => Object.fromEntries([...values.reduce((map, value) => map.set(label(value), (map.get(label(value)) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b)));

/** Provider labels and method counts alone cannot establish model authorship.
 * Old artifacts with no matching transport evidence remain diagnostics. */
export function growthEvidenceValidity(replay: GrowthReplayResult) {
  const { summary, turns } = replay;
  const realRun = String(summary.provider) === 'real' && summary.run_kind === 'character_memory_evaluation'
    && turns.length > 0 && turns.every(turn => turn.run_kind === 'character_memory_evaluation' && turn.providerMode === 'real');
  const verified = turns.filter(turn => {
    if (turn.replyOrigin !== 'model' || !turn.modelReply || !Array.isArray(turn.apiCalls)) return false;
    const id = turn.modelReply.responseId;
    return typeof id === 'string' && id.trim().length > 0
      && (!turn.response || turn.response.reply.text === turn.modelReply.text)
      && turn.apiCalls.some(call => call.api === 'responses' && call.stage === 'reply' && call.outcome === 'completed' && call.responseId === id);
  });
  const verifiedIds = new Set(verified.map(turn => turn.turnId));
  const unverifiedPublishedReplies = turns.filter(turn => turn.response !== null && !verifiedIds.has(turn.turnId)).length;
  const eligible = realRun && verified.length > 0 && unverifiedPublishedReplies === 0;
  return {
    character_memory_quality_evidence: eligible,
    run_kind: summary.run_kind ?? 'legacy_unverified',
    verifiedModelReplyTurns: realRun ? verified.length : 0,
    unverifiedPublishedReplies,
    reason: eligible
      ? 'Real-model run with matching completed reply Responses IDs and model-output evidence; semantic quality still requires independent review.'
      : summary.run_kind === 'harness_self_test'
        ? 'Harness self-test only: injected doubles provide no character, memory, or model quality evidence.'
        : String(summary.provider) !== 'real'
          ? 'Archived fake/development run: excluded from character and memory acceptance and model-quality comparisons.'
          : 'Real-model provenance is incomplete or no matching reply API evidence exists; provider labels alone do not establish model execution.',
  };
}

export async function writeGrowthReport(replay: GrowthReplayResult, expectations: readonly GrowthExpectation[], audit: CaptureAudit | null, source: GrowthSourceEvidence) {
  const validity = growthEvidenceValidity(replay);
  const modelEvaluationEligible = validity.character_memory_quality_evidence;
  const diagnosticResults = evaluateGrowthExpectations(expectations, replay);
  const diagnosticMechanisms = growthMechanismChecks(replay);
  // Retain diagnostic calculations separately without counting their results as
  // behavioral acceptance. Never alter the underlying replay logs.
  const results = modelEvaluationEligible ? diagnosticResults : diagnosticResults.map(result => ({
    ...result, status: 'needs_review' as const, checks: [], preconditions: [],
    notes: [...result.notes, validity.reason, 'Diagnostic checks are retained separately and excluded from behavioral acceptance counts.'],
  }));
  const mechanisms = modelEvaluationEligible ? diagnosticMechanisms : [];
  const summary = replay.summary;
  const evidenceClassification = modelEvaluationEligible ? 'real_model_replay' : 'diagnostics_not_model_evaluation';
  const modelEvidence = {
    provider: summary.provider, run_kind: summary.run_kind ?? 'legacy_unverified',
    models: summary.models ?? null,
    providerCallCounts: summary.providerCallCounts ?? { classify: 0, reply: 0, check: 0 },
    apiCallCounts: summary.apiCallCounts ?? null,
    modelAuthoredTurns: validity.verifiedModelReplyTurns,
    approvedCompletedTurns: modelEvaluationEligible ? replay.turns.filter(turn => turn.delivery.completed && turn.replyOrigin === 'model').length : 0,
    authoredReplyBypasses: summary.authoredReplyBypasses ?? 0,
    unverifiedReplyTurns: summary.unverifiedReplyTurns ?? 0,
    testDoubleTurns: replay.turns.filter(turn => turn.run_kind === 'harness_self_test' || turn.replyOrigin === 'test_double').length,
    tokenUsage: replay.turns.flatMap(turn => turn.apiCalls ?? []).reduce((sum, call) => ({ input: sum.input + (call.inputTokens ?? 0), output: sum.output + (call.outputTokens ?? 0) }), { input: 0, output: 0 }),
    methodCallsAreNotIndependentSemanticJudgments: true,
  };
  const compatibilityDiagnostic = audit ? {
    evidenceClassification: 'local_parser_compatibility_diagnostic',
    includedInModelEvaluation: false,
    notice: 'Local parser/evidence-validator observations only. These are not real-model accuracy measurements or independently authored expected facts.',
    audit,
  } : null;
  const statuses = countBy(results, result => result.status);
  const machineChecks = results.flatMap(result => result.checks);
  const uniqueReplies = countBy(replay.turns.filter(turn => !!turn.response), turn => turn.response!.reply.text);
  const mostCommonReplies = Object.entries(uniqueReplies).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const peak = {
    entities: Math.max(0, ...replay.days.map(day => day.after.entities.length)),
    preferences: Math.max(0, ...replay.days.map(day => day.after.preferences.length)),
    socialConnections: Math.max(0, ...replay.days.map(day => day.after.socialCircle.length)),
    events: Math.max(0, ...replay.days.map(day => day.after.events.length)),
    childStories: Math.max(0, ...replay.days.map(day => day.after.stories.length)),
  };
  const final = replay.finalSnapshot.context;
  const findingSpecs = [
    { sourceMessageId: 'an_2026-02-16_01_m05', expectation: 'The child explicitly declines a story and asks to vent. Respect that request without starting or advancing a story.',
      state: (turn: GrowthTurnLog) => ({ purpose: turn.response?.presentation.purpose, beforeCheckpoint: turn.before.storyProgress, afterCheckpoint: turn.after.storyProgress }) },
    { sourceMessageId: 'an_2026-05-31_01_m01', expectation: 'An explicit reconfirmation should renew the thunder fear to 2026-06-30T11:41:18.000Z. An unchanged May 7 record is insufficient.',
      state: (turn: GrowthTurnLog) => ({ beforeFear: turn.before.preferences.filter(preference => preference.category === 'fear'), afterFear: turn.after.preferences.filter(preference => preference.category === 'fear') }) },
    { sourceMessageId: 'an_2026-07-08_01_m05', expectation: 'Recognize the contextual deletion request. Commit a resolved operation or give a focused clarification; do not credit an absent, never-learned target as a successful delete.',
      state: (turn: GrowthTurnLog) => ({ observedIntent: turn.providerObservation?.intent, beforeEpoch: turn.before.profile.deletionEpoch, afterEpoch: turn.after.profile.deletionEpoch, invalidation: turn.response?.memory.invalidate_replay }) },
    { sourceMessageId: 'an_2026-07-21_01_m01', expectation: 'Use the paper key, toy-box door, and jingling checkpoint explicitly restated in the child request. Advancing an unrelated assigned story is not evidence of that continuity.',
      state: (turn: GrowthTurnLog) => ({ purpose: turn.response?.presentation.purpose, activeStory: turn.after.storyProgress?.title, chapter: turn.after.storyProgress?.chapter }) },
    { sourceMessageId: 'an_2026-10-16_01_m01', expectation: 'Accept the explicit correction that quiet speech does not mean sadness. Keep any emotional hypothesis transient.',
      state: (turn: GrowthTurnLog) => ({ observedFeeling: turn.providerObservation?.statedFeeling, purpose: turn.response?.presentation.purpose }) },
  ];
  const findings = findingSpecs.flatMap(specification => {
    const turn = replay.turns.find(turn => turn.sourceMessageId === specification.sourceMessageId);
    return turn ? [{ sourceMessageId: turn.sourceMessageId, date: turn.date, sourceText: turn.input.text, expectation: specification.expectation, actualReply: turn.response?.reply.text ?? null, state: specification.state(turn) }] : [];
  });
  const monthly = [...new Set(replay.days.map(day => day.date.slice(0, 7)))].map(month => {
    const days = replay.days.filter(day => day.date.startsWith(month));
    const turns = replay.turns.filter(turn => turn.date.startsWith(month));
    const last = days.at(-1)!;
    return { month, days: days.length, sourceTurns: turns.length, errors: turns.filter(turn => turn.error).length,
      growthDay: last.after.daily.growthDays, entities: last.after.entities.length, preferences: last.after.preferences.length,
      socialCircle: last.after.socialCircle.length, events: last.after.events.length, stories: last.after.stories.length,
      createdRecordIds: new Set(turns.flatMap(turn => turn.createdRecordIds)).size,
    };
  });
  const categories = [...new Set(results.map(result => result.category))].sort().map(category => {
    const counts = countBy(results.filter(result => result.category === category), result => result.status);
    return { category, pass: counts.pass ?? 0, fail: counts.fail ?? 0, needs_review: counts.needs_review ?? 0 };
  });
  const report = {
    schemaVersion: 'miu-growth-analysis-v1', synthetic: true, provider: summary.provider, source,
    run_kind: summary.run_kind ?? 'legacy_unverified',
    character_memory_quality_evidence: modelEvaluationEligible,
    evidenceClassification, validity, replayStatus: summary.status, modelEvidence,
    replay: summary, expectations: { includedInModelEvaluation: modelEvaluationEligible, total: results.length, statuses, automaticChecks: countBy(machineChecks, check => check.status), categories, results },
    mechanisms, findings, peakPersonalMemory: peak, monthly, finalPersonalMemory: {
      entities: final.entities.length, preferences: final.preferences.length, socialConnections: final.socialCircle.length,
      events: final.events.length, childStories: final.stories.length, friendship: final.friendship,
    },
    replyDistribution: { distinct: Object.keys(uniqueReplies).length, mostCommon: mostCommonReplies },
    diagnosticOnly: modelEvaluationEligible ? null : { includedInModelEvaluation: false, expectations: diagnosticResults, mechanisms: diagnosticMechanisms },
    compatibilityDiagnostic: compatibilityDiagnostic ? { file: 'capture-audit.json', includedInModelEvaluation: false } : null,
  };
  const lines = [
    '# Miu Daily Growth Replay Results', '',
    ...(modelEvaluationEligible ? [] : ['> **Diagnostic only — diagnostics_not_model_evaluation. Excluded from character and memory acceptance, quality conclusions, and model-performance comparisons.**', '', validity.reason, '']),
    `Requested source scope: **${summary.sessions} daily sessions and ${summary.sourceTurns} child turns**, from **${summary.from} through ${summary.to}**. Source: ${source.origin}; dataset checksum \`${source.checksum}\`.`, '',
    `Replay status: **${summary.status}**. Processed sessions: **${summary.processedSessions} / ${summary.sessions}**. Attempted child turns: **${summary.attemptedTurns} / ${summary.sourceTurns}**. Provider: **${summary.provider}**.`, '',
    ...(summary.blocked ? [`> Replay stopped at \`${summary.blocked.sourceMessageId}\` on ${summary.blocked.date}, stage \`${summary.blocked.stage}\`, code \`${summary.blocked.code}\`. Later source turns were not attempted and have no measured result.`, ''] : []),
    `Recorded daily invariant checks: **${summary.dayChecks.pass} passed, ${summary.dayChecks.fail} failed**. Source-grounded state assertions and unresolved dialogue criteria are reported separately; partial execution does not establish full-year behavior.`, '',
    `The source ${source.origin === 'verified_database_archive' ? 'database archive was read and verified' : 'exports were loaded and validated'}. The replay used a separate isolated PostgreSQL engine, one profile lifetime, the application, and simulated completed text delivery. Narrative and privacy clocks follow historical timestamps. Reference assistant replies and authored mood labels are inspection material, never runtime output or learned truth.`, '',
    '## Model execution evidence', '',
    '| Evidence | Observed |', '| --- | --- |',
    `| Provider | ${cell(summary.provider)} |`,
    `| Configured models | ${cell(JSON.stringify(modelEvidence.models))} |`,
    `| Provider method calls: classification / dialogue / safety check | ${modelEvidence.providerCallCounts.classify} / ${modelEvidence.providerCallCounts.reply} / ${modelEvidence.providerCallCounts.check} |`,
    `| Turns with model-authored candidates, including rejected output | ${modelEvidence.modelAuthoredTurns} |`,
    `| Approved completed model replies | ${modelEvidence.approvedCompletedTurns} |`,
    `| Actual API calls | ${cell(JSON.stringify(modelEvidence.apiCallCounts))} |`,
    `| Input / output tokens | ${modelEvidence.tokenUsage.input} / ${modelEvidence.tokenUsage.output} |`,
    `| Unverified replies | ${modelEvidence.unverifiedReplyTurns} |`,
    `| Authored reply bypasses | ${modelEvidence.authoredReplyBypasses} |`, '',
    'Per-turn provider calls and reply origins are recorded in turns.jsonl. Provider method counts describe execution paths; they do not replace transport evidence or an independent semantic assessment. A real provider label alone does not prove that a particular reply was generated by a model.', '',
    ...(modelEvidence.modelAuthoredTurns === 0 ? ['**No model-authored replies were recorded. This run cannot support conclusions about actual model dialogue performance.**', ''] : []),
    '## What the replay demonstrates', '',
    '| Measure | Observed |', '| --- | --- |',
    `| Child turns attempted / completed / errors | ${summary.attemptedTurns} / ${summary.completedTurns} / ${summary.turnErrors} |`,
    `| First / final growth counter | ${summary.firstGrowthDay} / ${summary.finalGrowthDay} |`,
    `| Daily job receipts | ${summary.nightJobCount} |`,
    `| Daily invariant checks passed / failed | ${summary.dayChecks.pass} / ${summary.dayChecks.fail} |`,
    `| Distinct authored diaries / themes across the year | ${summary.distinctDiaryTemplates} / ${summary.distinctGrowthThemes} |`,
    `| Peak entities / preferences / social connections / events / child stories | ${peak.entities} / ${peak.preferences} / ${peak.socialConnections} / ${peak.events} / ${peak.childStories} |`,
    `| Friendship stages by day | ${cell(JSON.stringify(summary.friendshipStages))} |`,
    `| Source-grounded expectation cases passed / failed / require review | ${statuses.pass ?? 0} / ${statuses.fail ?? 0} / ${statuses.needs_review ?? 0} |`,
    `| Story-progress transitions with a completed matching scene / violations | ${mechanisms.filter(check => check.status === 'pass').length} / ${mechanisms.filter(check => check.status === 'fail').length} |`, '',
    'The counter is zero-based: 365 consecutive calendar dates span 364 elapsed days. An increasing counter demonstrates scheduling; it does not demonstrate learned personality, growing familiarity, or successful recall.', '',
    modelEvaluationEligible
      ? 'This is a real-provider text replay. Only actually attempted model calls and recorded approved output count as evidence. Failed or blocked requests remain visible; no fake reply is a substitute for a failed real request. Audio, speech recognition, synthesis, and audible latency are not measured.'
      : 'This archived/development run measures local application behavior and authored output only. It supplies no live-model dialogue evidence. Audio and voice latency are not measured.', '',
    '## Source-anchored observations', '',
    ...findings.flatMap(finding => [
      `### ${finding.date} ${finding.sourceMessageId}`, '',
      `Child: ${finding.sourceText}`, '', `Expected: ${finding.expectation}`, '',
      `Actual Miu reply: ${finding.actualReply ?? '[no approved reply]'}`, '',
      '```json', JSON.stringify(finding.state, null, 2), '```', '',
    ]),
    'These examples interpret the recorded application behavior. They do not convert the remaining semantic-review cases into automatic passes or failures.', '',
    '## Growth expectations from the conversations', '',
    'The independently authored expectation catalog uses exact child-message anchors. It requires grounded acquisition of pets, names, interests and relationships; later corrections and preferences that replace outdated details; suitable next-day recall; stories that resume an actual heard checkpoint; respected privacy and stopping; and retention driven by real simulated time. A child turning seven remains in the configured 6–8 age band. Days or visit counts alone must not increase friendship.', '',
    'The catalog does not require retaining every fact for a year. An old preference may expire after 30 days, and a later volunteered mention can establish it again. A negative check is not credited as successful forgetting or expiry when its positive-capture prerequisite failed. A state-case pass means its included automatic state checks passed; it does not certify every prose expectation. Dialogue cases without a full semantic review remain marked for review even when individual observable assertions pass.', '',
    '| Category | Passed | Failed | Requires review |', '| --- | --- | --- | --- |',
    ...categories.map(category => `| ${cell(category.category)} | ${category.pass ?? 0} | ${category.fail ?? 0} | ${category.needs_review ?? 0} |`), '',
    '## Month by month', '',
    '| Month | Days | Child turns | Errors | Growth counter | Active entities | Active preferences | Active social connections | New records during turns |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...monthly.map(month => `| ${month.month} | ${month.days} | ${month.sourceTurns} | ${month.errors} | ${month.growthDay} | ${month.entities} | ${month.preferences} | ${month.socialCircle} | ${month.createdRecordIds} |`), '',
    '“New records” includes activity checkpoints; it is not a count of independently learned personal facts. Active counts can decrease through expiry or deletion and should not rise simply because time passed.', '',
    '## Concrete expectation evidence', '',
    ...results.flatMap(result => [
      `### ${result.id} ${result.status}`, '',
      `${result.date} · \`${result.sourceMessageId}\` · ${result.level} · ${result.scope}`, '',
      `Child: ${result.sourceText}`, '',
      ...result.expectedBehavior.map(expected => `- Expected: ${expected}`), '',
      `Actual Miu reply: ${result.actualReply ?? '[no approved reply]'}`, '',
      ...result.preconditions.map(check => `- Precondition ${check.status}: ${check.description}. ${check.evidence}`),
      ...result.checks.map(check => `- ${check.status}: ${check.description}. ${check.evidence}`),
      ...result.notes.map(note => `- Review note: ${note}`), '',
    ]),
    ...(compatibilityDiagnostic ? [
      '## Separate local compatibility diagnostic', '',
      'A local parser/evidence-validator diagnostic is saved separately in capture-audit.json. It is excluded from model evaluation and does not establish model extraction accuracy, independently expected facts, or successful storage.', '',
    ] : []),
    '## Interpretation and implementation priorities', '',
    `Assess the ${summary.attemptedTurns} attempted turns and the recorded daily checks at their observed scope. Personal growth also requires the independently source-grounded checks above. A blocked or partial run cannot establish results for unattempted dates.`, '',
    '1. Compare actual model extraction and stored memories against the hand-curated Vietnamese introductions, names, family/pets, and interest anchors. Local parser compatibility statistics are separate development evidence.',
    '2. Review refusals, stopping, privacy requests, and feeling corrections against their exact source messages. A request not to hear a story must not become a story-progress milestone.',
    '3. Inspect corrections, current preferences, nickname permissions and withdrawals, and renewed expiry through actual state transitions. Missing precursor data cannot establish a successful deletion or reconfirmation.',
    '4. Require verified shared experiences and welcomed familiarity for relationship progression. A day counter or static stage alone establishes neither relationship quality nor growing friendship.',
    '5. Report diary/theme variety at its measured coverage. A changing date or rotating authored template demonstrates scheduling, while sustained novelty and useful adaptation require separate evidence.', '',
    'These review priorities do not change the engine to make historical results pass. Independent dialogue judgments remain unreviewed unless explicitly supplied.', '',
    '## Evidence files', '',
    '- [Machine-readable analysis](analysis.json)',
    '- [Replay summary](summary.json)',
    '- [Daily updates and invariant checks](days.jsonl)',
    '- [Actual application turns and state changes](turns.jsonl)',
    '- [Database snapshots](snapshots.jsonl)',
    '- [Independent expectations](expectations.json)',
    ...(compatibilityDiagnostic ? ['- [Separate local compatibility diagnostic](capture-audit.json)'] : []),
    '- [Final isolated state](final-snapshot.json)', '',
    'All raw conversation evidence in these artifacts is fictional test data.', '',
  ];
  await Promise.all([
    writeFile(join(replay.outputDir, 'analysis.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(join(replay.outputDir, 'report.md'), lines.join('\n')),
    writeFile(join(replay.outputDir, 'expectations.json'), JSON.stringify(expectations, null, 2) + '\n'),
    ...(compatibilityDiagnostic ? [writeFile(join(replay.outputDir, 'capture-audit.json'), JSON.stringify(compatibilityDiagnostic, null, 2) + '\n')] : []),
  ]);
  return report;
}
