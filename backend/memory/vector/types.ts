/** Derived retrieval metadata only. Canonical sources remain the authority. */
export const VECTOR_PROJECTION_VERSION = 'atomic-memory-v2';
export const VECTOR_NORMALIZER_VERSION = 'nfc-lexical-v2';
export const MAX_DOCUMENT_BYTES = 512;
export const MAX_QUERY_BYTES = 256;
export const VECTOR_LIMITS = Object.freeze({ lexical: 20, dense: 20, union: 30, results: 3, rrfK: 60 });

export type VectorDocumentKind = 'event' | 'preference' | 'child_story';
export type VectorScope = 'reported_real' | 'fictional';
export interface VectorDependency { sourceId: string; revision: number }
export interface VectorDocumentCandidate {
  profileId: string;
  sourceId: string;
  sourceRevision: number;
  contentHash: string;
  projectionVersion: string;
  projectionKey: string;
  text: string;
  kind: VectorDocumentKind;
  scope: VectorScope;
  dependencies: VectorDependency[];
  learnedLocalDate?: string;
  embeddingEligible: boolean;
  embeddingSkipReason?: 'projection_oversize';
}

interface ProjectionSourceBase {
  profileId: string;
  sourceId: string;
  sourceRevision: number;
  /** Only currently eligible, completed canonical learning may be projected. */
  origin: 'canonical_live' | 'synthetic_archive' | 'session';
  eligible: boolean;
  scope: VectorScope;
  evidenceKind: 'child_reported' | 'reported_plan';
  dependencies: readonly VectorDependency[];
  learnedLocalDate?: string;
  /** Legacy age expiry is deliberately not used as durable-source eligibility. */
  expiresAt?: string | null;
}
export type VectorProjectionSource = ProjectionSourceBase & (
  | { kind: 'event'; value: string; eventType: string; subjectName: string | null;
      /** Joined canonical entity fields only, never inferred from the name. */
      subjectKind?: 'person' | 'pet' | 'object' | 'story_character' | null; subjectSpecies?: string | null;
      localDate: string; conditions?: readonly string[] }
  | { kind: 'preference'; value: string; category: string; slot?: string; qualifiers?: { frequency?: string; timeRelation?: string; exactTime?: string | null } }
  | { kind: 'child_story'; title: string; literalText: string; castNames: readonly string[] }
);

/** score is cosine similarity for dense; positive relevance for lexical.
 * Their numeric scales are never added together. rank starts at one. */
export interface VectorSearchHit {
  profileId: string;
  documentId: string;
  sourceId: string;
  sourceRevision: number;
  contentHash: string;
  projectionKey: string;
  projectionVersion: string;
  generationId?: string;
  method: 'lexical' | 'dense';
  score: number;
  rank: number;
  dependencies: readonly VectorDependency[];
  kind: VectorDocumentKind;
  scope: VectorScope;
  learnedLocalDate?: string;
}
export type TypedRetrievalDisposition = 'not_applicable' | 'resolved' | 'missing' | 'ambiguous';
export interface RetrievalActionShape { domain: string; target?: { status?: 'resolved' | 'missing' | 'ambiguous' } }
export interface SemanticQueryInput {
  /** Minimal topic selected by trusted application code, never a whole session. */
  topic: string;
  typedDisposition: TypedRetrievalDisposition;
  actionDomain: string;
  intent: string;
  safetyApproved: boolean;
  suppressLearning: boolean;
  /** Trusted route decision when topic extraction removed the recall wording. */
  recallRequested?: boolean;
}
export type SemanticQueryEligibility =
  | { eligible: true; topic: string }
  | { eligible: false; reason: 'typed_lane' | 'task_boundary' | 'unsafe_or_private' | 'empty_topic' | 'query_oversize' | 'non_minimal_topic' };
export interface RankHybridInput {
  profileId: string;
  generationId: string;
  projectionVersion?: string;
  typedDisposition: TypedRetrievalDisposition;
  /** The query guard must already have approved this bounded topic. */
  query: string;
  lexical: readonly VectorSearchHit[];
  dense: readonly VectorSearchHit[];
  allowedScopes: readonly VectorScope[];
  minDenseSimilarity?: number;
  minLexicalScore?: number;
  limit?: number;
}
export interface RankedVectorCandidate {
  sourceId: string;
  sourceRevision: number;
  contentHash: string;
  projectionKey: string;
  kind: VectorDocumentKind;
  scope: VectorScope;
  dependencies: VectorDependency[];
  methods: ('lexical' | 'dense')[];
  lexicalRank?: number;
  denseRank?: number;
  rrfScore: number;
}
export interface RankHybridResult {
  status: 'candidates' | 'no_answer' | 'typed_lane';
  candidates: RankedVectorCandidate[];
  reason?: 'typed_lane' | 'empty_topic' | 'query_oversize' | 'no_relevant_candidate';
  considered: number;
  rejected: number;
}
