import type { TurnResponse } from '../application.js';
import type { AgeBand, GenerationDiagnostics, MemoryContext, Personality, LanguageMode, Role, NightJobResult } from '../shared/types.js';
import type { OpenAIClassificationEvidence, OpenAIReplyEvidence, OpenAIRequestTelemetry } from '../pipeline/providers.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface Assertion {
  /** Product specification requirement ID, such as MEM-01 or SAFE-01. */
  requirement: string;
  description: string;
  /** Dot path into {response,before,after,delivery,error,retry}; arrays support .length. */
  target: string;
  op: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'contains_one_of' | 'matches' | 'not_matches' | 'not_affirmative' | 'one_of' | 'exists' | 'gte' | 'lte' | 'equals_before';
  /** contains on arrays accepts a partial object; matches uses a Unicode case-insensitive regex. */
  value?: JsonValue;
}
export interface ScenarioTurn {
  id: string;
  kind?: 'utterance' | 'greeting';
  text?: string;
  delivery?: 'completed' | 'interrupted' | 'canceled';
  retry?: 'turn' | 'receipt';
  assertions: Assertion[];
  /** Semantic acceptance criteria are evaluated separately, never silently marked passed by a regex. */
  rubric: string[];
}
export interface ScenarioConversation {
  id: string;
  profile: 'an' | 'binh';
  /** Desired narrative instant. Ordinary gaps advance privacy time too; next_day changes narrative time only. */
  at: string;
  transition?: 'next_day' | 'next_day_retry' | 'reload';
  config?: { personality?: Personality; role?: Role; languageMode?: LanguageMode; voiceId?: string };
  turns: ScenarioTurn[];
}
export interface Scenario {
  id: string;
  title: string;
  category: string;
  requirements: string[];
  age_band?: AgeBand;
  /** Replay only user messages from these existing historical sessions before the scenario. */
  history_dates: string[];
  /** Deliberately corrupt legacy state for repair tests; never learning evidence. */
  initial_memory?: {
    provenance: 'synthetic_legacy_fixture_not_learning_evidence';
    profile: 'an' | 'binh';
    pet: { name: string; species: 'dog' | 'cat' | 'rabbit' };
    event: { value: string; local_date: string };
  };
  conversations: ScenarioConversation[];
}
export interface ProviderEvent {
  stage: 'classify' | 'reply' | 'check';
  elapsed_ms: number;
  outcome: 'ok' | 'error';
  details?: unknown;
  error_code?: string;
}
export interface TurnLog {
  schema_version: 'miu-engine-evaluation-v1';
  run_kind?: 'character_memory_evaluation' | 'harness_self_test';
  run_id: string;
  phase: 'history' | 'scenario' | 'scenario_history';
  scenario_id: string | null;
  conversation_id: string;
  turn_spec_id: string;
  profile_key: 'an' | 'binh';
  source_message_id?: string;
  input: { kind: 'utterance' | 'greeting'; text?: string };
  at: string;
  wall_at?: string;
  elapsed_ms: number;
  provider_mode: 'fake' | 'real';
  response: TurnResponse | null;
  before: MemoryContext;
  after: MemoryContext;
  delivery: { status: string; receipt_status?: string; learning_status?: string } | null;
  retry: unknown;
  error: { code: string; stage: string } | null;
  /** If set, after is the last known before snapshot, not evidence of post-turn state. */
  after_snapshot_error?: string;
  provider_events: ProviderEvent[];
  api_calls?: OpenAIRequestTelemetry[];
  reply_origin?: 'model' | 'unavailable' | 'authored_bypass' | 'test_double';
  classification_evidence?: OpenAIClassificationEvidence | null;
  model_reply?: OpenAIReplyEvidence | null;
  generation?: GenerationDiagnostics;
  transition?: { type: string; first?: NightJobResult; retry?: NightJobResult };
  assertions: Assertion[];
  rubric: string[];
}
export interface CheckResult {
  id: string;
  requirement: string;
  description: string;
  status: 'pass' | 'fail' | 'not_applicable' | 'needs_review' | 'not_tested';
  evidence: string;
}
export interface TurnEvaluation {
  scenario_id: string | null;
  conversation_id: string;
  turn_spec_id: string;
  phase: TurnLog['phase'];
  checks: CheckResult[];
  status: 'pass' | 'fail' | 'needs_review';
}
export interface RequirementCoverage {
  id: string;
  priority: 'P0' | 'P1';
  title: string;
  scope: 'text_engine' | 'voice_or_ui' | 'mixed';
  status: 'pass' | 'fail' | 'needs_review' | 'not_tested';
  checks: { pass: number; fail: number; needs_review: number; not_tested: number };
  note: string;
}

export interface SemanticReview {
  key: string;
  evidence_sha256: string;
  source: 'human' | 'model';
  reviewer: string;
  criteria: { index: number; criterion: string; status: 'pass' | 'fail' | 'needs_review'; evidence: string }[];
  overall: { status: 'pass' | 'fail' | 'needs_review'; evidence: string };
}
