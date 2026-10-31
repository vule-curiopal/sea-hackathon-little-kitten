import { createHash } from 'node:crypto';
import { isSafeProjection } from '../evidence.js';
import type { Queryable } from '../database.js';
import {
  MAX_DOCUMENT_BYTES, VECTOR_PROJECTION_VERSION,
  type VectorDependency, type VectorDocumentCandidate, type VectorProjectionSource,
} from './types.js';

const CATEGORIES = new Set(['hobby', 'like', 'dislike', 'fear', 'self_description', 'story_preference', 'routine']);
const EVENT_TYPES = new Set(['fell_in_puddle', 'reported_event', 'planned_activity']);
const SUBJECT_KINDS = new Set(['person', 'pet', 'object', 'story_character']);
const FREQUENCIES = new Set(['sometimes', 'usually', 'often', 'always']);

function identifier(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RangeError('invalid_vector_identifier');
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('invalid_vector_source_revision');
}
function literal(value: string, maximum: number): boolean {
  return typeof value === 'string' && !!value.trim() && value.length <= maximum && isSafeProjection(value);
}
function date(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new RangeError('invalid_vector_local_date');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new RangeError('invalid_vector_local_date');
}
function sqlDate(value: unknown): string {
  // Native pg keeps SQL DATE as YYYY-MM-DD; PGlite versions may return a
  // UTC-midnight Date. Avoid locale-dependent String(Date) serialization.
  const result = value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString().slice(0, 10) : typeof value === 'string' ? value : '';
  date(result);
  return result;
}
export function canonicalDependencies(dependencies: readonly VectorDependency[]): VectorDependency[] {
  if (!Array.isArray(dependencies) || dependencies.length > 64) throw new RangeError('invalid_vector_dependencies');
  const result = new Map<string, number>();
  for (const dependency of dependencies) {
    if (!dependency) throw new RangeError('invalid_vector_dependencies');
    identifier(dependency.sourceId); revision(dependency.revision);
    const previous = result.get(dependency.sourceId);
    if (previous !== undefined && previous !== dependency.revision) throw new RangeError('conflicting_vector_dependency_revision');
    result.set(dependency.sourceId, dependency.revision);
  }
  return [...result].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([sourceId, value]) => ({ sourceId, revision: value }));
}
export function projectionContentHash(text: string, dependencies: readonly VectorDependency[], projectionVersion = VECTOR_PROJECTION_VERSION): string {
  return createHash('sha256').update(JSON.stringify({ projectionVersion, text, dependencies: canonicalDependencies(dependencies) })).digest('hex');
}

/** One completed canonical source, one literal document. Never summarize,
 * translate, truncate, renew, or embed identifiers/transcripts here. */
export function projectVectorDocument(source: VectorProjectionSource): VectorDocumentCandidate | null {
  if (!source || source.origin !== 'canonical_live' || source.eligible !== true
    || !['event', 'preference', 'child_story'].includes(source.kind)) return null;
  identifier(source.profileId); identifier(source.sourceId); revision(source.sourceRevision);
  if (!['reported_real', 'fictional'].includes(source.scope)
    || !['child_reported', 'reported_plan'].includes(source.evidenceKind)) return null;
  if (source.learnedLocalDate !== undefined) date(source.learnedLocalDate);
  const dependencies = canonicalDependencies(source.dependencies);
  if (dependencies.some(dependency => dependency.sourceId === source.sourceId && dependency.revision !== source.sourceRevision)) {
    throw new RangeError('conflicting_vector_dependency_revision');
  }
  const externalDependencies = dependencies.filter(dependency => dependency.sourceId !== source.sourceId);
  let payload: Record<string, unknown>;
  const tags = { kind: source.kind, scope: source.scope, evidence_kind: source.evidenceKind };
  if (source.kind === 'event') {
    if (!EVENT_TYPES.has(source.eventType) || !literal(source.value, 500)
      || source.subjectName !== null && !literal(source.subjectName, 80)
      || source.subjectKind !== undefined && source.subjectKind !== null && !SUBJECT_KINDS.has(source.subjectKind)
      || source.subjectSpecies !== undefined && source.subjectSpecies !== null && !literal(source.subjectSpecies, 80)
      || source.conditions !== undefined && (!Array.isArray(source.conditions) || source.conditions.length > 8 || source.conditions.some(condition => !literal(condition, 200)))) return null;
    date(source.localDate);
    payload = { ...tags, event_type: source.eventType, subject: source.subjectName,
      subject_kind: source.subjectKind ?? null, subject_species: source.subjectSpecies ?? null,
      local_date: source.localDate, conditions: [...(source.conditions ?? [])], literal_value: source.value };
  } else if (source.kind === 'preference') {
    if (source.scope !== 'reported_real' || source.evidenceKind !== 'child_reported'
      || !CATEGORIES.has(source.category) || !literal(source.value, 300)
      || source.category === 'self_description' || source.slot !== undefined) return null;
    const qualifiers = source.qualifiers;
    if (qualifiers && (qualifiers.frequency !== undefined && !FREQUENCIES.has(qualifiers.frequency)
      || qualifiers.timeRelation !== undefined && !literal(qualifiers.timeRelation, 200)
      || qualifiers.exactTime !== undefined && qualifiers.exactTime !== null && !literal(qualifiers.exactTime, 80))) return null;
    payload = { ...tags, category: source.category, ...(source.slot !== undefined ? { slot: source.slot } : {}),
      ...(qualifiers ? { qualifiers: {
        ...(qualifiers.frequency !== undefined ? { frequency: qualifiers.frequency } : {}),
        ...(qualifiers.timeRelation !== undefined ? { time_relation: qualifiers.timeRelation } : {}),
        ...(qualifiers.exactTime !== undefined ? { exact_time: qualifiers.exactTime } : {}),
      } } : {}), literal_value: source.value };
  } else {
    // literalText must be an existing source-validated child excerpt. In the
    // canonical store the field named summary is required to occur in evidence.
    if (source.scope !== 'fictional' || source.evidenceKind !== 'child_reported'
      || !literal(source.title, 100) || !literal(source.literalText, 500)
      || !Array.isArray(source.castNames) || source.castNames.length > 8 || source.castNames.some(name => !literal(name, 80))) return null;
    payload = { ...tags, literal_title: source.title, literal_text: source.literalText, cast: [...source.castNames] };
  }
  const text = JSON.stringify(payload);
  if (!isSafeProjection(text)) return null;
  const embeddingEligible = Buffer.byteLength(text, 'utf8') <= MAX_DOCUMENT_BYTES;
  const contentHash = projectionContentHash(text, externalDependencies);
  return {
    profileId: source.profileId, sourceId: source.sourceId, sourceRevision: source.sourceRevision,
    contentHash, projectionVersion: VECTOR_PROJECTION_VERSION, projectionKey: 'atomic', text,
    kind: source.kind, scope: source.scope, dependencies: externalDependencies,
    ...(source.learnedLocalDate !== undefined ? { learnedLocalDate: source.learnedLocalDate } : {}),
    embeddingEligible, ...(!embeddingEligible ? { embeddingSkipReason: 'projection_oversize' as const } : {}),
  };
}

/** Load the bounded live canonical corpus in the caller's profile-locked
 * transaction. No archive table, raw turn, age filter, or inferred text is read.
 * The full dependency closure includes entity revisions, never entity documents.
 */
export async function projectCanonicalProfile(tx: Queryable, profileId: string, options: { limit?: number } = {}): Promise<VectorDocumentCandidate[]> {
  identifier(profileId);
  const limit = options.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_vector_corpus_limit');
  const result = await tx.query<Record<string, unknown>>(`SELECT
      r.id,r.kind,r.scope,r.evidence_kind,r.content_revision,r.learned_local_date,r.expires_at,
      f.category,f.value AS preference_value,f.slot,f.qualifiers,
      e.event_type,e.value AS event_value,e.local_date,e.conditions,subject.name AS subject_name,
      subject.kind AS subject_kind,subject.species AS subject_species,
      s.title,s.summary,s.cast_names
    FROM memory_records r
    LEFT JOIN facts f ON f.profile_id=r.profile_id AND f.id=r.id
    LEFT JOIN events e ON e.profile_id=r.profile_id AND e.id=r.id
    LEFT JOIN entities subject ON subject.profile_id=e.profile_id AND subject.id=e.subject_id
    LEFT JOIN child_stories s ON s.profile_id=r.profile_id AND s.id=r.id
    WHERE r.profile_id=$1 AND (
      (r.kind='preference' AND f.id IS NOT NULL AND f.slot IS NULL AND f.category<>'self_description')
      OR (r.kind='event' AND e.id IS NOT NULL)
      OR (r.kind='story' AND s.id IS NOT NULL))
    ORDER BY r.id LIMIT $2`, [profileId, limit + 1]);
  if (result.rows.length > limit) throw new RangeError('vector_corpus_limit_exceeded');
  if (!result.rows.length) return [];
  const sourceIds = result.rows.map(row => String(row.id));
  const dependencyRows = await tx.query<{ root_id: string; source_id: string; content_revision: number | string | null; address_permission: boolean }>(`
    WITH RECURSIVE dependencies(root_id,source_id) AS (
      SELECT d.derived_id,d.source_id FROM memory_dependencies d
      WHERE d.profile_id=$1 AND d.derived_id=ANY($2::uuid[])
      UNION
      SELECT prior.root_id,d.source_id FROM dependencies prior
      JOIN memory_dependencies d ON d.profile_id=$1 AND d.derived_id=prior.source_id
    ) SELECT deps.root_id,deps.source_id,r.content_revision,
      EXISTS(SELECT 1 FROM address_preferences a WHERE a.profile_id=$1 AND a.id=deps.source_id) AS address_permission
    FROM dependencies deps LEFT JOIN memory_records r ON r.profile_id=$1 AND r.id=deps.source_id
    ORDER BY deps.root_id,deps.source_id`, [profileId, sourceIds]);
  const dependencies = new Map<string, VectorDependency[]>();
  const excluded = new Set<string>();
  for (const row of dependencyRows.rows) {
    // Session/day address validity requires its typed lane, not a profile-only
    // semantic scan. Missing dependencies also cannot authorize copied prose.
    if (row.address_permission || row.content_revision === null) { excluded.add(row.root_id); continue; }
    dependencies.set(row.root_id, [...(dependencies.get(row.root_id) ?? []), { sourceId: row.source_id, revision: Number(row.content_revision) }]);
  }
  const documents: VectorDocumentCandidate[] = [];
  for (const row of result.rows) {
    const sourceId = String(row.id);
    if (excluded.has(sourceId)) continue;
    const common = {
      profileId, sourceId, sourceRevision: Number(row.content_revision), origin: 'canonical_live' as const, eligible: true,
      scope: row.scope as VectorProjectionSource['scope'], evidenceKind: row.evidence_kind as VectorProjectionSource['evidenceKind'],
      dependencies: dependencies.get(sourceId) ?? [], learnedLocalDate: sqlDate(row.learned_local_date),
      expiresAt: row.expires_at === null ? null : row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    };
    let source: VectorProjectionSource;
    if (row.kind === 'event') source = { ...common, kind: 'event', value: row.event_value as string,
      eventType: row.event_type as string, subjectName: row.subject_name as string | null,
      subjectKind: row.subject_kind as Extract<VectorProjectionSource, { kind: 'event' }>['subjectKind'],
      subjectSpecies: row.subject_species as string | null,
      localDate: sqlDate(row.local_date), conditions: row.conditions as string[] };
    else if (row.kind === 'preference') source = { ...common, kind: 'preference', value: row.preference_value as string,
      category: row.category as string, ...(row.slot !== null && row.slot !== undefined ? { slot: row.slot as string } : {}),
      ...(row.qualifiers ? { qualifiers: row.qualifiers as Extract<VectorProjectionSource, { kind: 'preference' }>['qualifiers'] } : {}) };
    else source = { ...common, kind: 'child_story', title: row.title as string, literalText: row.summary as string, castNames: row.cast_names as string[] };
    const document = projectVectorDocument(source);
    if (document) documents.push(document);
  }
  return documents;
}
