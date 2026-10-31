import type { TurnResponse } from '../../application.js';
import type { MemoryContext, Observation, Provider } from '../../shared/types.js';
import type { ReferenceSession } from '../../memory/import-history.js';

export interface GrowthCheck { id: string; status: 'pass' | 'fail'; evidence: string; expected?: unknown; actual?: unknown }
export type GrowthRunKind = 'character_memory_evaluation' | 'harness_self_test';
export interface GrowthModelIds { classify: string; reply: string; check: string; moderation?: string }
export interface GrowthProviderCall {
  stage: 'classify' | 'reply' | 'check'; outcome: 'ok' | 'error'; elapsedMs: number;
  model: string | null; authoredBypass: boolean; errorCode?: string;
}
export interface GrowthAPICall {
  sequence: number; stage: 'classify' | 'reply' | 'check' | 'moderation_input' | 'moderation_output';
  api: 'responses' | 'moderations'; requestedModel: string; returnedModel: string | null;
  responseId: string | null; requestId: string | null; startedAt: string; elapsedMs: number;
  outcome: 'completed' | 'failed'; inputTokens: number | null; outputTokens: number | null;
  totalTokens: number | null; reasoningTokens: number | null; errorCode: string | null; httpStatus: number | null;
}
export interface GrowthBlockedReason { date: string; sourceMessageId: string; stage: string; code: string }
export interface GrowthModelReply { text: string; requestedModel: string; returnedModel: string | null; responseId: string | null }
export interface GrowthRecord {
  id: string; kind: string; sourceTurnId: string; sourceMessageId: string | null;
  evidenceKind: string; scope: string; createdAt: string; expiresAt: string;
}
export interface GrowthDatabaseEvidence {
  records: GrowthRecord[];
  dependencies: { sourceId: string; derivedId: string }[];
  followups: { id: string; sourceId: string; dueDate: string; status: string; questionEn: string; questionVi: string }[];
  checkpoints: { id: string; templateId: string; chapter: number; status: string }[];
  promises: { id: string; checkpointId: string; status: string }[];
  nightJobs: { date: string; completedAt: string }[];
  diaryEntries: { id: string; date: string; templateId: string }[];
  dailyStateRows: number;
  learningReceiptCount: number;
  kindCounts: Record<string, number>;
}
export interface GrowthSnapshot { at: string; context: MemoryContext; evidence: GrowthDatabaseEvidence }
export interface GrowthMaintenanceEvidence {
  nightJobCount: number; currentDateJobCount: number; currentDateDiaryCount: number;
  currentDailyRows: number; dailyDate: string | null; growthDays: number | null;
  dailyMood: string | null; diaryTemplateId: string | null; episodeTemplateId: string | null;
  stateVersion: number; deletionEpoch: number;
}
export interface GrowthTurnLog {
  schemaVersion: 'miu-growth-replay-v1'; dayIndex: number; date: string;
  run_kind: GrowthRunKind; character_memory_quality_evidence: boolean;
  sourceSessionId: string; sourceMessageId: string; referenceMessageId: string;
  sourceUserTimestamp: string; referenceTimestamp: string; referenceReply: string;
  turnId: string; input: { kind: 'utterance'; text: string }; at: string;
  providerMode: Provider['mode']; elapsedMs: number;
  providerCalls: GrowthProviderCall[]; apiCalls: GrowthAPICall[];
  replyOrigin: 'model' | 'authored_bypass' | 'unverified' | 'unavailable' | 'test_double';
  classificationEvidence: unknown | null;
  modelReply: GrowthModelReply | null;
  response: TurnResponse | null; before: MemoryContext; after: MemoryContext;
  localObservation: Observation; providerObservation: Observation | null;
  delivery: { status: 'completed' | 'failed'; started: boolean; completed: boolean; receiptStatus: string | null; learningStatus: string | null };
  error: { code: string; stage: string } | null;
  recoveryError: string | null; afterSnapshotError: string | null;
  createdRecordIds: string[]; removedRecordIds: string[]; recordCountBefore: number; recordCountAfter: number;
}
export interface GrowthDayLog {
  schemaVersion: 'miu-growth-replay-v1'; dayIndex: number; date: string; sourceSessionId: string;
  sourceAnnotation: { language: string; childMood: ReferenceSession['child_mood']; miuMood: string; tags: string[] };
  maintenance: { at: string; before: GrowthMaintenanceEvidence; after: GrowthMaintenanceEvidence; repeated: GrowthMaintenanceEvidence; repeatedJobApplied: boolean | null; errors: { stage: string; code: string }[] };
  before: MemoryContext; after: MemoryContext;
  beforeRecordIds: string[]; afterRecordIds: string[];
  expiredSincePreviousDay: string[]; removedSincePreviousDay: string[];
  sourceTurns: number; completedTurns: number; errors: number;
  createdRecordIds: string[]; checks: GrowthCheck[];
}
export interface GrowthReplaySummary {
  schemaVersion: 'miu-growth-replay-v1'; runId: string; synthetic: true; provider: Provider['mode'];
  run_kind: GrowthRunKind; character_memory_quality_evidence: boolean;
  status: 'complete' | 'blocked'; blocked: GrowthBlockedReason | null; processedSessions: number;
  models: Readonly<GrowthModelIds> | null;
  providerCallCounts: { classify: number; reply: number; check: number };
  apiCallCounts: { classify: number; reply: number; check: number; moderation_input: number; moderation_output: number };
  modelAuthoredTurns: number; authoredReplyBypasses: number; unverifiedReplyTurns: number;
  outputDir: string; from: string; to: string; sessions: number; sourceTurns: number;
  attemptedTurns: number; completedTurns: number; turnErrors: number;
  firstGrowthDay: number; finalGrowthDay: number; nightJobCount: number;
  distinctDiaryTemplates: number; distinctGrowthThemes: number; friendshipStages: Record<string, number>;
  recordsCreatedDuringTurns: number; recordsRemovedDuringTurns: number; finalActiveRecords: number;
  dayChecks: { pass: number; fail: number }; failures: { date: string; id: string; evidence: string }[];
  errorCodes: Record<string, number>; checks: GrowthCheck[];
  limitations: string[];
}
export interface GrowthReplayOptions {
  sessions: ReferenceSession[]; outputDir: string;
  /** Defaults to real evaluation. Self-tests require Node's unit-test process
   * context and an explicitly injected double; the behavioral CLI cannot select them. */
  runKind?: GrowthRunKind;
  /** Required at runtime. Model evaluation accepts only the real OpenAI adapter
   * with evaluationMode enabled; unit doubles must use harness_self_test. */
  providerInstance?: Provider;
  /** Configured model IDs; actual request/response model IDs are logged separately. */
  models?: Readonly<GrowthModelIds>;
  turnTimeoutMs?: number;
  /** Metadata clock only. Simulation always follows source dates/timestamps. */
  now?: () => Date;
  progress?: (progress: { day: number; total: number; date: string; turns: number; errors: number }) => void;
}
export interface GrowthReplayResult {
  outputDir: string; summary: GrowthReplaySummary; days: GrowthDayLog[]; turns: GrowthTurnLog[]; finalSnapshot: GrowthSnapshot;
}
