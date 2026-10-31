import { isSafeProjection } from '../evidence.js';
import { canonicalDependencies } from './projections.js';
import {
  MAX_QUERY_BYTES, VECTOR_LIMITS, VECTOR_PROJECTION_VERSION,
  type RankHybridInput, type RankHybridResult, type RankedVectorCandidate,
  type RetrievalActionShape, type SemanticQueryEligibility, type SemanticQueryInput,
  type TypedRetrievalDisposition, type VectorSearchHit,
} from './types.js';

const STOP_WORDS = new Set(`a an the i me my we our us you your miu do does did can could would will shall should is are was were have has had be been to of for from with about on in at and or that this these those what which who when where why how tell remember recall said say some something anything please today yesterday
mình tôi tớ con em bạn cậu chúng ta của về với cho một các những có không đã đang sẽ là ở vào trong trên và hay gì nào sao thế này đó ấy kể nhớ nhắc nói điều cái hôm nay qua trước lại nhé ạ việc làm bằng`.split(/\s+/u));

export function normalizeLexical(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('vi').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}
function tokens(value: string): string[] {
  return [...new Set(normalizeLexical(value).split(' ').filter(word => [...word].length >= 2 && !STOP_WORDS.has(word)))];
}
function projectionLiteralText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (!['event', 'preference', 'child_story'].includes(String(record.kind))) return '';
      const values: string[] = [];
      for (const key of ['literal_value', 'literal_title', 'literal_text', 'subject']) if (typeof record[key] === 'string') values.push(record[key] as string);
      for (const key of ['conditions', 'cast']) if (Array.isArray(record[key])) values.push(...(record[key] as unknown[]).filter((value): value is string => typeof value === 'string'));
      if (record.qualifiers && typeof record.qualifiers === 'object') {
        const qualifiers = record.qualifiers as Record<string, unknown>;
        for (const key of ['time_relation', 'exact_time']) if (typeof qualifiers[key] === 'string') values.push(qualifiers[key] as string);
      }
      return values.join(' ');
    }
  } catch { /* Callers may also score a validated literal source value. */ }
  return text;
}

const LANGUAGE_REQUEST = String.raw`(?:(?:please\s+)?(?:(?:answer|reply|respond|speak)(?:\s+to me)?\s+in|(?:use|switch to))\s+(?:English|Vietnamese)(?:\s+(?:only|please))?|(?:(?:vui lòng|làm ơn|hãy|bạn hãy|miu hãy)\s+)?(?:trả lời|nói|dùng|chuyển sang|đổi sang)(?:\s+bằng)?\s+tiếng\s+(?:Anh|Việt)(?:\s+(?:nhé|nha|giúp mình))?)`;
const PREFIX_LANGUAGE_REQUEST = new RegExp(`^${LANGUAGE_REQUEST}\\s*(?:[.!?。！？;,:—–-]+\\s*|$)`, 'iu');
const SUFFIX_LANGUAGE_REQUEST = new RegExp(`(?:[.!?。！？;,:—–-]+\\s*)${LANGUAGE_REQUEST}[.!?。！？\\s]*$`, 'iu');

/** Delete only explicit presentation and recall framing. The remaining topic
 * stays literal: no translation, synonym expansion, or generated summary. */
export function extractMemorySearchTopic(text: string): string | null {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2048) return null;
  let topic = text.normalize('NFC').trim();
  for (let pass = 0; pass < 3; pass++) {
    const previous = topic;
    topic = topic.replace(PREFIX_LANGUAGE_REQUEST, '').replace(SUFFIX_LANGUAGE_REQUEST, '').trim();
    topic = topic.replace(/(?:,\s*|\s+)(?:please|thanks|thank you|nhé|nha|giúp mình|cảm ơn(?: bạn)?|ạ)[.!?。！？\s]*$/iu, '').trim();
    if (topic === previous) break;
  }
  let inner = topic.replace(/[.!?。！？]+$/u, '').trim();
  if (!inner
    || /[.!?。！？;\r\n]/u.test(inner)
    || /[,—–]\s*(?:and|also|but|however|và|nhưng|i(?:['’]m)?|my|we|our|mình|tớ|con|em)\b/iu.test(inner)) return null;
  const beforeRecall = inner;
  inner = inner
    .replace(/^(?:please\s+)?(?:(?:do|can|could|would)\s+you\s+)?(?:recall|remember|remind me (?:of|about))\s+what\s+i\s+(?:said|told you|shared|mentioned)\s+about\s+/iu, '')
    .replace(/^(?:what (?:did|have) i (?:tell|told|say|said|share|shared|mention|mentioned)(?: you)? about)\s+/iu, '')
    .replace(/^(?:please\s+)?(?:(?:do|can|could|would|will)\s+you\s+)?(?:still\s+)?(?:remember|recall|recollect|remind me (?:of|about))\s+/iu, '')
    .replace(/^(?:(?:bạn|miu|cậu)\s+)?(?:hãy\s+)?(?:nhắc lại|kể lại)\s+(?:điều|chuyện)\s+(?:mình|tớ|tôi|con|em)\s+(?:(?:đã|từng)\s+)?(?:kể|nói|chia sẻ)\s+về\s+/iu, '')
    .replace(/^(?:(?:bạn|miu|cậu)\s+)?(?:(?:có|còn|có còn)\s+)?(?:nhớ|nhắc lại|kể lại)\s+(?:về\s+)?(?:chuyện\s+)?/iu, '');
  if (inner !== beforeRecall) {
    inner = inner
      .replace(/\s+(?:that\s+)?i\s+(?:told you|talked to you|shared|mentioned)(?:\s+with you)?\s+about$/iu, '')
      .replace(/\s+(?:mình|tớ|tôi|con|em)\s+(?:(?:đã|từng)\s+)?(?:kể|nói|chia sẻ)(?:\s+(?:với|cho)\s+bạn)?(?:\s+không)?$/iu, '')
      .replace(/\s+không$/iu, '').trim();
  }
  if (!inner || Buffer.byteLength(inner, 'utf8') > MAX_QUERY_BYTES) return null;
  return inner;
}

/** Defense when a broad router has not identified a protected exact slot.
 * Pet/fiction keywords alone are deliberately insufficient to block episodes. */
export function isTypedMemoryTopic(text: string): boolean {
  return /\b(?:who (?:is|was|are)|who am i|identity|(?:what|which).{0,35}\b(?:name|nickname|spelling|species|kind of|type of)|(?:know|remember|recall|repeat|preserve|spell).{0,35}\b(?:name|nickname|spelling|diacritics?|accents?)|(?:what|which).{0,25}\b(?:is|was|are).{0,20}\b(?:called|named)|my name|your name)\b/iu.test(text)
    || /\b(?:permission|consent|nickname|preferred address|address me|call me|allowed? to|revok(?:e|ed)|forget|do not (?:save|remember)|don['’]t (?:save|remember))\b/iu.test(text)
    || /\b(?:favou?rite|preferred|preferences?|hobbies|hobby|routine|habit|schedule)\b|\b(?:what|which).{0,35}\b(?:do i|i do).{0,20}\b(?:like|love|enjoy|prefer|dislike|hate|fear)\b/iu.test(text)
    || /\b(?:what|which) (?:day|date|time|month|year)\b|\bwhen (?:did|was|were|have)\b|\bhow long ago\b|\b\d{4}-\d{2}-\d{2}\b/iu.test(text)
    || /(?<![\p{L}\p{M}])tên(?!\s+lửa)(?![\p{L}\p{M}])|(?:là ai|loài gì|loại gì|chính tả|biệt danh|cho phép|được phép|thu hồi|đừng (?:nhớ|lưu)|hãy quên|sở thích|thói quen|thích gì|ghét gì|sợ gì|yêu thích nhất|màu yêu thích|ngày nào|ngày mấy|ngày bao nhiêu|mấy giờ|giờ nào|khi nào (?:đã|mình|tớ|con|em))/iu.test(text);
}

const NON_NAME_WORDS = new Set([...STOP_WORDS, ...`answer reply respond speak use switch english vietnamese yes no okay ok hi hello thanks thank last earlier previous first then next before after still now again during once one two three new old tell recall remember remind recollect picture drawing cardboard water tumble fictional pretend pet dog cat rabbit animal event plan story stories memory memories topic place where what who how when why do did does can could would have has am im ive its bạn mình tớ con em cậu hôm hồi lần lúc liệu còn trước sau kể nhớ nhắc tiếng anh việt bức tranh chuyện truyện xin vui lòng hãy trả lời cảm ơn`.split(/\s+/u)]);

/** Current-query anchors only; no remembered-name list, aliases, or history.
 * These are discovery constraints, never evidence of identity by themselves. */
export function extractProperNameAnchors(text: string): string[] {
  const topic = extractMemorySearchTopic(text);
  if (!topic) return [];
  const anchors = new Set<string>();
  for (const match of topic.matchAll(/["“]([^"”]{1,80})["”]/gu)) {
    const literal = match[1]!.trim();
    if (/^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u.test(literal) && tokens(literal).length) anchors.add(literal);
  }
  for (const match of topic.matchAll(/(?<![\p{L}\p{M}])\p{Lu}[\p{L}\p{M}]*(?![\p{L}\p{M}])/gu)) {
    if (!NON_NAME_WORDS.has(match[0].toLocaleLowerCase('vi')) && match[0] !== 'Miu') anchors.add(match[0]);
  }
  return [...anchors];
}

export function matchesProperNameAnchors(documentText: string, anchors: readonly string[]): boolean {
  const source = projectionLiteralText(documentText).normalize('NFC').toLocaleLowerCase('vi');
  return anchors.every(anchor => {
    const literal = anchor.normalize('NFC').toLocaleLowerCase('vi').replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${literal}(?![\\p{L}\\p{M}\\p{N}])`, 'u').test(source);
  });
}

/** Literal token coverage, not truth confidence or an embedding-quality score. */
export function lexicalScore(query: string, documentText: string): number {
  const queryTerms = tokens(query);
  if (!queryTerms.length) return 0;
  const documentTerms = new Set(tokens(projectionLiteralText(documentText)));
  const matches = queryTerms.filter(term => documentTerms.has(term)).length;
  return matches ? matches / queryTerms.length * (.85 + .15 * matches / Math.max(1, documentTerms.size)) : 0;
}

function wordPattern(words: readonly string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{M}])(?:${words.join('|')})(?![\\p{L}\\p{M}])`, 'iu');
}
// These are predicate/ontology aliases, never names or answer text. A recognized
// query constraint requires canonical support; an embedding score cannot add it.
const SPECIES_ALIASES = [
  ['dog', 'dogs', 'puppy', 'puppies', 'chó', 'cún'],
  ['cat', 'cats', 'kitten', 'kittens', 'mèo'],
  ['rabbit', 'rabbits', 'bunny', 'bunnies', 'thỏ'],
  ['bird', 'birds', 'chim'], ['fish', 'fishes', 'cá'],
  ['hamster', 'hamsters', 'chuột hamster'], ['turtle', 'turtles', 'rùa'],
] as const;
const OUTCOMES = [
  ['fall', 'falls', 'fell', 'fallen', 'tumble', 'tumbles', 'tumbled', 'tumbling', 'ngã'],
  ['bath', 'baths', 'bathe', 'bathed', 'bathing', 'wash', 'washed', 'washing', 'tắm', 'rửa'],
  ['break', 'breaks', 'broke', 'broken', 'breaking', 'shatter', 'shattered', 'shattering', 'smash', 'smashed', 'vỡ', 'bể'],
  ['swim', 'swims', 'swam', 'swimming', 'bơi'],
] as const;
const PLAN_CUE = wordPattern(['plan', 'plans', 'planned', 'planning', 'intend', 'intended', 'will', 'tomorrow', 'going to', 'dự định', 'kế hoạch', 'sẽ', 'ngày mai']);
const COMPLETED_CUE = wordPattern(['did', 'happened', 'occurred', 'actually', 'already', 'completed', 'finished', 'đã', 'xảy ra', 'xong']);
const NEGATIVE_OR_UNCERTAIN = wordPattern(['not', 'never', 'no', 'cannot', 'can’t', "can't", "didn't", 'didn’t', "doesn't", 'doesn’t', "hasn't", 'hasn’t', "wasn't", 'wasn’t', 'without', 'maybe', 'perhaps', 'might', 'could', 'unsure', 'uncertain', 'không', 'chưa', 'chẳng', 'chả', 'đừng', 'có thể', 'có lẽ', 'chắc gì']);
const CONDITIONAL = wordPattern(['if', 'unless', 'would', 'nếu', 'giá như']);

function affirmedOutcome(literal: string, outcome: readonly string[], allowPlan: boolean): boolean {
  // Check the clause containing the predicate, never JSON tags, titles or a
  // separate condition. Explicit denial/uncertainty is not affirmative support.
  const clauses = literal.split(/[.!?;\r\n]+|\b(?:and|but|however)\b|(?<![\p{L}\p{M}])(?:và|nhưng)(?![\p{L}\p{M}])/iu)
    .filter(clause => wordPattern(outcome).test(clause));
  return clauses.length > 0 && clauses.every(clause => !NEGATIVE_OR_UNCERTAIN.test(clause)
    && (allowPlan || !PLAN_CUE.test(clause) && !CONDITIONAL.test(clause)));
}

/** Conservative compatibility filter over freshly rehydrated canonical JSON.
 * It cannot prove arbitrary entailment. Unknown support abstains for explicit
 * actor/scope/outcome constraints instead of converting similarity into truth. */
export function matchesQuerySourceConstraints(canonicalText: string, topic: string): boolean {
  let source: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(canonicalText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    source = parsed as Record<string, unknown>;
  } catch { return false; }
  if (!['event', 'preference', 'child_story'].includes(String(source.kind))
    || !['reported_real', 'fictional'].includes(String(source.scope))
    || !['child_reported', 'reported_plan'].includes(String(source.evidence_kind))) return false;
  const query = topic.normalize('NFC');
  const literal = source.kind === 'child_story' ? source.literal_text : source.literal_value;
  if (typeof literal !== 'string') return false;
  const notReal = /\b(?:not real|isn['’]t real|make-believe)\b|không có thật/iu;
  const fictional = notReal.test(query)
    || /\b(?:fictional|fiction|pretend|imaginary|make-believe)\b|\bin (?:my|our|the) story\b|(?:tưởng tượng|hư cấu|trong (?:câu )?(?:chuyện|truyện))/iu.test(query);
  const realQuery = query.replace(/\b(?:not real|isn['’]t real)\b|không có thật/giu, '');
  const real = /\breal(?:[ -]life)?\b|\bactually (?:happened|occurred)\b|(?:ngoài đời|có thật|thật sự (?:đã )?xảy ra)/iu.test(realQuery);
  if (fictional && source.scope !== 'fictional' || real && source.scope !== 'reported_real') return false;

  const species = SPECIES_ALIASES.filter(aliases => wordPattern(aliases).test(query));
  if (species.length) {
    if (source.kind === 'child_story' && source.scope === 'fictional') {
      if (species.some(aliases => !wordPattern(aliases).test(literal))) return false;
    } else {
      if (source.kind !== 'event' || source.subject_kind !== 'pet' && source.subject_kind !== 'story_character'
        || typeof source.subject_species !== 'string'
        || species.some(aliases => !aliases.some(alias => normalizeLexical(alias) === normalizeLexical(source.subject_species as string)))) return false;
    }
  }
  if (wordPattern(['pet', 'pets', 'thú cưng']).test(query)
    && (source.kind !== 'event' || source.subject_kind !== 'pet')) return false;
  if (wordPattern(['person', 'people', 'friend', 'friends', 'người bạn']).test(query)
    && (source.kind !== 'event' || source.subject_kind !== 'person')) return false;

  const requestedOutcomes = OUTCOMES.filter(outcome => wordPattern(outcome).test(query));
  const queryingPlan = PLAN_CUE.test(query) && (!COMPLETED_CUE.test(query)
    || /\b(?:did|have)\s+(?:i|we|you)\s+(?:plan|intend)\b/iu.test(query));
  if (source.evidence_kind === 'reported_plan' || source.event_type === 'planned_activity') {
    if (!queryingPlan && (COMPLETED_CUE.test(query) || requestedOutcomes.length > 0)) return false;
  }
  if (requestedOutcomes.length) {
    if (source.kind !== 'event' && source.kind !== 'child_story'
      || !queryingPlan && Array.isArray(source.conditions) && source.conditions.length > 0
      || NEGATIVE_OR_UNCERTAIN.test(query)) return false;
    if (requestedOutcomes.some(outcome => !affirmedOutcome(literal, outcome, queryingPlan))) return false;
  }
  return true;
}

/** An exact query owns its missing/ambiguous outcome as well as known answers. */
export function typedDispositionForAction(action: RetrievalActionShape | null | undefined): TypedRetrievalDisposition {
  if (action?.domain !== 'memory') return 'not_applicable';
  return action.target?.status ?? 'missing';
}

export function semanticQueryEligibility(input: SemanticQueryInput): SemanticQueryEligibility {
  if (input.typedDisposition !== 'not_applicable') return { eligible: false, reason: 'typed_lane' };
  if (!input.safetyApproved || input.suppressLearning || !isSafeProjection(input.topic)) return { eligible: false, reason: 'unsafe_or_private' };
  if (isTypedMemoryTopic(input.topic)) return { eligible: false, reason: 'typed_lane' };
  const recallCue = /\b(?:remember|recall|recollect|remind me|what (?:did|have) (?:i|we).{0,30}(?:tell|share|talk|say)|(?:i|we) (?:told|shared|talked|mentioned)|our (?:old|earlier|previous))\b|(?:nhớ|nhắc lại|kể lại|hồi trước|lần trước|hôm trước|chuyện cũ|(?:đã|từng).{0,30}(?:kể|nói|chia sẻ))/iu.test(input.topic);
  if (input.actionDomain !== 'conversation' || !['chat', 'share'].includes(input.intent)
    || input.recallRequested !== true && !recallCue) return { eligible: false, reason: 'task_boundary' };
  if (!tokens(input.topic).length) return { eligible: false, reason: 'empty_topic' };
  const topic = extractMemorySearchTopic(input.topic);
  if (!topic) return { eligible: false, reason: Buffer.byteLength(input.topic, 'utf8') > MAX_QUERY_BYTES ? 'query_oversize' : 'non_minimal_topic' };
  if (!tokens(topic).length) return { eligible: false, reason: 'empty_topic' };
  if (Buffer.byteLength(topic, 'utf8') > MAX_QUERY_BYTES) return { eligible: false, reason: 'query_oversize' };
  return { eligible: true, topic };
}

function validIdentifier(value: string): boolean { return typeof value === 'string' && !!value.trim() && value.length <= 200; }
function hitKey(hit: VectorSearchHit): string {
  return JSON.stringify([hit.sourceRevision, hit.contentHash, hit.projectionKey, hit.kind, hit.scope, canonicalDependencies(hit.dependencies)]);
}

/** Return IDs and revision guards only. Rehydrate current canonical evidence
 * after this step; a fused score never grants permission or supplies an answer. */
export function rankHybridCandidates(input: RankHybridInput): RankHybridResult {
  if (input.typedDisposition !== 'not_applicable') return { status: 'typed_lane', reason: 'typed_lane', candidates: [], considered: 0, rejected: 0 };
  if (!validIdentifier(input.profileId) || !validIdentifier(input.generationId)
    || !Array.isArray(input.lexical) || !Array.isArray(input.dense)
    || input.lexical.length > 1000 || input.dense.length > 1000
    || !input.allowedScopes.length || input.allowedScopes.some(scope => !['reported_real', 'fictional'].includes(scope))) throw new RangeError('invalid_vector_ranking_input');
  if (!tokens(input.query).length) return { status: 'no_answer', reason: 'empty_topic', candidates: [], considered: 0, rejected: 0 };
  if (Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES) return { status: 'no_answer', reason: 'query_oversize', candidates: [], considered: 0, rejected: 0 };
  const minimumDense = input.minDenseSimilarity ?? .35;
  const minimumLexical = input.minLexicalScore ?? .10;
  const requestedLimit = input.limit ?? VECTOR_LIMITS.results;
  if (!Number.isFinite(minimumDense) || minimumDense < -1 || minimumDense > 1
    || !Number.isFinite(minimumLexical) || minimumLexical < 0
    || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new RangeError('invalid_vector_ranking_threshold');
  const limit = Math.min(VECTOR_LIMITS.results, requestedLimit);
  const version = input.projectionVersion ?? VECTOR_PROJECTION_VERSION;
  let rejected = 0;
  let considered = 0;
  const sourceVersions = new Map<string, string>();
  const conflictingSources = new Set<string>();
  const lanes = (['lexical', 'dense'] as const).map(method => {
    const values = input[method].filter(hit => {
      considered++;
      let valid = !!hit && hit.profileId === input.profileId && hit.method === method
        && validIdentifier(hit.documentId) && validIdentifier(hit.sourceId) && validIdentifier(hit.projectionKey)
        && Number.isSafeInteger(hit.sourceRevision) && hit.sourceRevision >= 1 && /^[a-f0-9]{64}$/u.test(hit.contentHash)
        && Number.isSafeInteger(hit.rank) && hit.rank >= 1 && hit.rank <= VECTOR_LIMITS[method] && Number.isFinite(hit.score)
        && ['event', 'preference', 'child_story'].includes(hit.kind) && input.allowedScopes.includes(hit.scope)
        && hit.projectionVersion === version
        && (method === 'dense' ? hit.generationId === input.generationId && hit.score >= minimumDense && hit.score <= 1 : hit.score > 0 && hit.score >= minimumLexical);
      if (valid) { try { canonicalDependencies(hit.dependencies); } catch { valid = false; } }
      if (!valid) rejected++;
      else {
        const versionKey = hitKey(hit);
        const prior = sourceVersions.get(hit.sourceId);
        if (prior !== undefined && prior !== versionKey) conflictingSources.add(hit.sourceId);
        sourceVersions.set(hit.sourceId, versionKey);
      }
      return valid;
    }).sort((left, right) => left.rank - right.rank || left.sourceId.localeCompare(right.sourceId, 'en'));
    // Multiple documents/hits for the same source cannot multiply its vote.
    const unique = new Map<string, VectorSearchHit>();
    for (const hit of values) if (!unique.has(hit.sourceId)) unique.set(hit.sourceId, hit);
    return [...unique.values()].slice(0, VECTOR_LIMITS[method]);
  });
  const grouped = new Map<string, VectorSearchHit[]>();
  for (const lane of lanes) for (const hit of lane) grouped.set(hit.sourceId, [...(grouped.get(hit.sourceId) ?? []), hit]);
  const ranked: RankedVectorCandidate[] = [];
  for (const [sourceId, hits] of grouped) {
    if (conflictingSources.has(sourceId) || new Set(hits.map(hitKey)).size !== 1) { rejected += hits.length; continue; }
    const source = hits[0]!;
    const methods = hits.map(hit => hit.method).sort() as ('lexical' | 'dense')[];
    const lexicalRank = hits.find(hit => hit.method === 'lexical')?.rank;
    const denseRank = hits.find(hit => hit.method === 'dense')?.rank;
    ranked.push({ sourceId, sourceRevision: source.sourceRevision, contentHash: source.contentHash,
      projectionKey: source.projectionKey, kind: source.kind, scope: source.scope,
      dependencies: canonicalDependencies(source.dependencies), methods,
      ...(lexicalRank !== undefined ? { lexicalRank } : {}), ...(denseRank !== undefined ? { denseRank } : {}),
      rrfScore: hits.reduce((sum, hit) => sum + 1 / (VECTOR_LIMITS.rrfK + hit.rank), 0),
    });
  }
  ranked.sort((left, right) => right.rrfScore - left.rrfScore || left.sourceId.localeCompare(right.sourceId, 'en'));
  const union = ranked.slice(0, VECTOR_LIMITS.union);
  const candidates = union.slice(0, limit);
  return { status: candidates.length ? 'candidates' : 'no_answer', candidates,
    ...(!candidates.length ? { reason: 'no_relevant_candidate' as const } : {}), considered, rejected };
}
