export const PERSONALITIES = ['ISTJ', 'ISFJ', 'INFJ', 'INTJ', 'ISTP', 'ISFP', 'INFP', 'INTP', 'ESTP', 'ESFP', 'ENFP', 'ENTP', 'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ'] as const;
export type Personality = typeof PERSONALITIES[number];
export type Language = 'vi' | 'en';
export type LanguageMode = Language | 'follow_child';
export type AgeBand = '4-5' | '6-8';
export type Role = 'friend' | 'big_sibling' | 'teacher';
export type Mood = 'content' | 'curious' | 'mellow';
export type Emotion = 'neutral' | 'happy' | 'curious' | 'gentle' | 'sleepy';
export type PreferenceCategory = 'hobby' | 'like' | 'dislike' | 'fear' | 'self_description' | 'story_preference' | 'routine';

export interface ChildProfile {
  id: string;
  demoKey: string;
  displayName: string;
  ageBand: AgeBand;
  languageMode: LanguageMode;
  timezone: string;
  stateVersion: number;
  deletionEpoch: number;
}
export interface MiuConfig {
  personality: Personality;
  role: Role;
  voiceId: string;
  canonVersion: string;
  assignedStoryId?: string;
}
export interface Entity {
  id: string;
  kind: 'person' | 'pet' | 'object' | 'story_character';
  name: string;
  species: string | null;
  aliases: string[];
  /** Scoped hashes support recognizing a corrected spelling supplied anew by the child. */
  retiredNameHashes?: string[];
  expiresAt: string;
}
export interface Preference {
  id: string;
  category: PreferenceCategory;
  value: string;
  expiresAt: string;
}
export interface SocialConnection {
  id: string;
  entityId: string;
  name: string;
  relation: string;
  expiresAt: string;
}
export interface MemoryEvent {
  id: string;
  subjectId: string | null;
  subjectName: string | null;
  eventType: string;
  value: string;
  localDate: string;
  evidenceKind: 'child_reported' | 'reported_plan';
  expiresAt: string;
  source?: AssertionEvidence & { turnId: string };
}
export interface AssertionEvidence {
  clause: string;
  start: number;
  end: number;
  speechAct: 'assertion';
  polarity: 'affirmed';
}
export interface ChildStory {
  id: string;
  title: string;
  summary: string;
  castNames: string[];
  expiresAt: string;
}
export interface DailyState {
  localDate: string;
  mood: Mood;
  growthDays: number;
  growthTheme: string;
  diary: { templateId: string; en: string; vi: string };
  storyEpisode: { templateId: string; chapter: number; en: string; vi: string };
}
export interface ClockState {
  mode: 'real' | 'demo';
  effectiveNow: string;
  localDate: string;
  timezone: string;
  version: number;
}
export interface RecallHook {
  id: string;
  sourceIds: string[];
  evidenceKind: 'child_reported' | 'reported_plan' | 'inferred_question';
  fact: string;
  question: { en: string; vi: string } | null;
  claim?: { en: string; vi: string };
}
export interface StoryProgress {
  id: string;
  templateId: string;
  chapter: number;
  status: 'active' | 'complete';
  title: { en: string; vi: string };
  scene: { en: string; vi: string };
}
export interface MemoryContext {
  profile: ChildProfile;
  config: MiuConfig;
  clock: ClockState;
  daily: DailyState;
  entities: Entity[];
  preferences: Preference[];
  socialCircle: SocialConnection[];
  events: MemoryEvent[];
  stories: ChildStory[];
  storyProgress: StoryProgress | null;
  friendship: 'getting_acquainted' | 'buddies' | 'best_friends';
}

export type MemoryCandidate =
  | { kind: 'entity'; entityKind: Entity['kind']; name: string; species: string | null; evidence: string }
  | { kind: 'preference'; category: PreferenceCategory; value: string; evidence: string }
  | { kind: 'relationship'; name: string; relation: string; evidence: string }
  | { kind: 'event'; subjectName: string | null; eventType: 'fell_in_puddle' | 'reported_event' | 'planned_activity'; value: string; evidence: string }
  | { kind: 'story'; title: string; summary: string; castNames: string[]; evidence: string };

export interface Observation {
  intent: 'chat' | 'share' | 'comfort' | 'forget' | 'correct' | 'story' | 'continue_story' | 'greeting' | 'stop' | 'unsafe';
  language: Language;
  statedFeeling: 'sad' | 'scared' | 'happy' | null;
  uncertain: boolean;
  uncertainty?: 'name' | 'event' | 'prior_report' | 'meaning' | null;
  correctionTarget?: string | null;
  entityCorrection?: { oldName: string; newName: string; entityKind: Entity['kind']; evidence: string } | null;
  candidates: MemoryCandidate[];
  forgetTarget: string | null;
  suppressLearning: boolean;
}
export interface SessionExchange {
  user: string;
  assistant: string;
  referenceId: string | null;
}
export interface MemoryOperation {
  type: 'forgotten' | 'clarify_forget' | 'confirmed_forget_all' | 'corrected' | 'correction_noted' | 'clarify_correction' | 'renamed' | 'capture_suppressed';
  detail?: string;
  reportStatus?: 'denied_by_child';
}
export interface ActivityBoundaries { noGames: boolean; noQuestions: boolean }
export interface ProviderClassificationContext {
  entities: ReadonlyArray<Pick<Entity, 'id' | 'kind' | 'name' | 'aliases'>>;
  recent: readonly SessionExchange[];
}
export interface DirectorInput {
  context: MemoryContext;
  observation: Observation;
  text: string;
  recall: RecallHook | null;
  comfortActive: boolean;
  history: SessionExchange[];
  operation?: MemoryOperation;
  boundaries?: ActivityBoundaries;
  turnEvidence?: { kind: 'current_turn'; facts: string[]; persistable: boolean };
}
export interface DirectorPlan {
  purpose: 'chat' | 'comfort' | 'clarify' | 'follow_up' | 'story' | 'farewell' | 'refusal' | 'acknowledge_forget';
  language: Language;
  ageBand: AgeBand;
  personality: Personality;
  role: Role;
  emotion: Emotion;
  dailyMood: Mood;
  rhythm: 'morning' | 'daytime' | 'evening' | 'bedtime';
  delivery: 'gentle' | 'normal' | 'playful' | 'sleepy';
  allowGiggle: boolean;
  allowPurr: boolean;
  face: { expression: Emotion; gesture: 'none' | 'head_tilt' | 'slow_blink' | 'small_bounce' | 'yawn' };
  memoryReferenceId: string | null;
  allowedFacts: string[];
  allowedQuestion: string | null;
  exactText: string | null;
  responseGoal?: string;
  boundaries?: ActivityBoundaries;
  maxSentences: number;
  maxQuestions: number;
  ruleTrace: string[];
  comfortActive: boolean;
}
export interface ReplyPrompt { instructions: string; input: string }
export interface ValidationResult { approved: boolean; violations: string[]; sentences: string[] }
export interface Provider {
  readonly mode: 'fake' | 'real';
  classify(text: string, language: Language, signal?: AbortSignal, context?: ProviderClassificationContext): Promise<Observation>;
  reply(prompt: ReplyPrompt, plan: DirectorPlan, signal?: AbortSignal): Promise<string>;
  check(text: string, plan: DirectorPlan, signal?: AbortSignal, context?: ReplyPrompt): Promise<{ approved: boolean; violations: string[] }>;
}

export interface LearningInput {
  profileId: string;
  turnId: string;
  deletionEpoch: number;
  localDate: string;
  /** Full current input, used transiently to validate the scope of each excerpt. */
  sourceText: string;
  candidates: MemoryCandidate[];
  storyTransition?: 'start' | 'continue';
}
export interface ForgetResult { deletedIds: string[]; deletionEpoch: number; stateVersion: number }
export interface NightJobResult { daily: DailyState; clock: ClockState; stateVersion: number; applied: boolean }

export class AppError extends Error {
  invalidation?: { state_version: number; clock_version: number; memory: { invalidate_replay: true } };
  constructor(public code: string, public status = 400, message = code) { super(message); }
}
