import { z } from 'zod';
import type { Language, MemoryCandidate, Observation, PreferenceCategory, ProviderClassificationContext } from '../shared/types.js';
import { validateCandidate } from '../memory/evidence.js';
import { assertionEvidence } from '../memory/assertions.js';
import { affirmativeSpeech, speechClauses } from '../shared/semantic-speech.js';
import { socialFormulaLanguage } from './language.js';

const boundedText = z.string().min(1).max(500);
const qualifierSchema = z.object({
  frequency: z.enum(['sometimes', 'usually', 'often', 'always']).optional(),
  timeRelation: z.string().min(1).max(160).optional(),
  exactTime: z.string().min(1).max(80).nullable().optional(),
}).strict();
export const MemoryCandidateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entityKind: z.enum(['person', 'pet', 'object', 'story_character']), name: z.string().min(1).max(80), species: z.string().max(40).nullable(), objectType: z.string().min(1).max(80).optional(), represents: z.string().min(1).max(80).optional(), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('preference'), category: z.enum(['hobby', 'like', 'dislike', 'fear', 'self_description', 'story_preference', 'routine']), value: z.string().min(1).max(160), slot: z.string().min(1).max(80).optional(), qualifiers: qualifierSchema.optional(), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('relationship'), name: z.string().min(1).max(80), relation: z.string().min(1).max(40), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('event'), subjectName: z.string().max(80).nullable(), eventType: z.enum(['fell_in_puddle', 'reported_event', 'planned_activity']), value: z.string().min(1).max(300), conditions: z.array(z.string().min(1).max(200)).max(4).optional(), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('story'), title: z.string().min(1).max(100), summary: boundedText, castNames: z.array(z.string().min(1).max(80)).max(8), evidence: boundedText }).strict(),
]);
export const EntityCorrectionSchema = z.object({
  oldName: z.string().min(1).max(80), newName: z.string().min(1).max(80),
  entityKind: z.enum(['person', 'pet', 'object', 'story_character']), evidence: boundedText,
}).strict();
export const ObservationSchema = z.object({
  intent: z.enum(['chat', 'share', 'comfort', 'forget', 'correct', 'story', 'continue_story', 'greeting', 'stop', 'unsafe']),
  language: z.enum(['vi', 'en']),
  statedFeeling: z.enum(['sad', 'scared', 'happy', 'angry', 'frustrated', 'disappointed', 'tired']).nullable(),
  unsafeKind: z.enum(['harm_instructions', 'harm_disclosure']).nullable().optional(),
  urgency: z.enum(['immediate', 'unclear']).nullable().optional(),
  uncertain: z.boolean(),
  uncertainty: z.enum(['name', 'event', 'prior_report', 'meaning']).nullable(),
  correctionTarget: z.string().max(300).nullable(),
  entityCorrection: EntityCorrectionSchema.nullable(),
  candidates: z.array(MemoryCandidateSchema).max(12),
  forgetTarget: z.string().max(100).nullable(),
  suppressLearning: z.boolean(),
}).strict();

/** OpenAI strict output requires every transport property to be present. The
 * canonical memory contract uses absent optional metadata rather than nulls. */
const transportCandidates = [
  MemoryCandidateSchema.options[0].extend({ objectType: z.string().min(1).max(80).nullable(), represents: z.string().min(1).max(80).nullable() }),
  MemoryCandidateSchema.options[1].extend({
    slot: z.string().min(1).max(80).nullable(),
    qualifiers: z.object({ frequency: z.enum(['sometimes', 'usually', 'often', 'always']).nullable(), timeRelation: z.string().min(1).max(160).nullable(), exactTime: z.string().min(1).max(80).nullable() }).strict().nullable(),
  }),
  MemoryCandidateSchema.options[2],
  MemoryCandidateSchema.options[3].extend({ conditions: z.array(z.string().min(1).max(200)).max(4).nullable() }),
  MemoryCandidateSchema.options[4],
] as const;
export const ObservationTransportSchema = ObservationSchema.extend({
  unsafeKind: z.enum(['harm_instructions', 'harm_disclosure']).nullable(),
  urgency: z.enum(['immediate', 'unclear']).nullable(),
  candidates: z.discriminatedUnion('kind', transportCandidates).array().max(12),
});

export function normalizeObservationTransport(input: unknown): Observation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ObservationSchema.parse(input);
  const value = { ...input } as Record<string, unknown>;
  value.unsafeKind ??= null;
  value.urgency ??= null;
  if (Array.isArray(value.candidates)) value.candidates = value.candidates.map(raw => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const candidate = { ...raw } as Record<string, unknown>;
    for (const key of ['objectType', 'represents', 'slot', 'conditions']) if (candidate[key] === null) delete candidate[key];
    if (candidate.qualifiers === null) delete candidate.qualifiers;
    else if (candidate.qualifiers && typeof candidate.qualifiers === 'object' && !Array.isArray(candidate.qualifiers)) {
      const qualifiers = { ...candidate.qualifiers } as Record<string, unknown>;
      for (const key of ['frequency', 'timeRelation']) if (qualifiers[key] === null) delete qualifiers[key];
      if (Object.values(qualifiers).every(item => item === null)) delete candidate.qualifiers;
      else candidate.qualifiers = qualifiers;
    }
    return candidate;
  });
  return ObservationSchema.parse(value);
}

/** Wire aliases reduce repeated output keys; they do not change the canonical
 * observation or grant model proposals any additional persistence authority. */
export const COMPACT_OBSERVATION_FIELDS = Object.freeze({
  i: 'intent', l: 'language', f: 'statedFeeling', h: 'unsafeKind', g: 'urgency',
  u: 'uncertain', q: 'uncertainty', t: 'correctionTarget', r: 'entityCorrection',
  c: 'candidates', d: 'forgetTarget', s: 'suppressLearning',
} as const);

export const CompactObservationTransportSchema = z.object({
  i: ObservationTransportSchema.shape.intent.describe('intent: the current utterance intent.'),
  l: ObservationTransportSchema.shape.language.describe('language: vi or en for the current reply.'),
  f: ObservationTransportSchema.shape.statedFeeling.describe('statedFeeling: explicitly expressed feeling, or null.'),
  h: ObservationTransportSchema.shape.unsafeKind.describe('unsafeKind: harm instruction request or harm disclosure, or null.'),
  g: ObservationTransportSchema.shape.urgency.describe('urgency: immediate or unclear for harm, or null.'),
  u: ObservationTransportSchema.shape.uncertain.describe('uncertain: independent ambiguity flag, including uncertainty without a named category.'),
  q: ObservationTransportSchema.shape.uncertainty.describe('uncertainty: name, event, prior_report, meaning, or null.'),
  t: ObservationTransportSchema.shape.correctionTarget.describe('correctionTarget: literal disputed proposition, or null.'),
  r: ObservationTransportSchema.shape.entityCorrection.describe('entityCorrection: literal old and new names with source evidence, or null.'),
  c: ObservationTransportSchema.shape.candidates.describe('candidates: literal current-utterance memory proposals; historical context is not new assertion evidence.'),
  d: ObservationTransportSchema.shape.forgetTarget.describe('forgetTarget: literal deletion target, all for everything, or null when absent or unresolved.'),
  s: ObservationTransportSchema.shape.suppressLearning.describe('suppressLearning: disable capture for no-save requests, private disclosures, or unsafe input.'),
}).strict();

/** Legacy injected contract fixtures may use canonical candidates, strict
 * transport candidates, or a mixture of those explicit nested shapes. Unknown
 * fields are rejected before null normalization, rather than stripped away. */
const LegacyObservationWireSchema = ObservationSchema.extend({
  candidates: z.array(z.union([MemoryCandidateSchema, ObservationTransportSchema.shape.candidates.element])).max(12),
}).strict();

export function encodeCompactObservation(observation: Observation): z.infer<typeof CompactObservationTransportSchema> {
  const canonical = normalizeObservationTransport(LegacyObservationWireSchema.parse(observation));
  const candidates = canonical.candidates.map(candidate => {
    if (candidate.kind === 'entity') return { ...candidate, objectType: candidate.objectType ?? null, represents: candidate.represents ?? null };
    if (candidate.kind === 'preference') return {
      ...candidate, slot: candidate.slot ?? null,
      qualifiers: candidate.qualifiers ? {
        frequency: candidate.qualifiers.frequency ?? null,
        timeRelation: candidate.qualifiers.timeRelation ?? null,
        exactTime: candidate.qualifiers.exactTime ?? null,
      } : null,
    };
    if (candidate.kind === 'event') return { ...candidate, conditions: candidate.conditions ?? null };
    return candidate;
  });
  const transport = ObservationTransportSchema.parse({ ...canonical, candidates });
  return CompactObservationTransportSchema.parse(Object.fromEntries(
    Object.entries(COMPACT_OBSERVATION_FIELDS).map(([alias, field]) => [alias, transport[field]]),
  ));
}

/** The same canonical evidence guards run after this adapter in serving and
 * evaluation. No local classifier result is substituted for a model proposal. */
export function normalizeCompactObservationTransport(input: unknown): Observation {
  const compactKeys = new Set(Object.keys(COMPACT_OBSERVATION_FIELDS));
  const hasCompactKey = input !== null && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).some(key => compactKeys.has(key));
  if (!hasCompactKey) return normalizeObservationTransport(LegacyObservationWireSchema.parse(input));
  const compact = CompactObservationTransportSchema.parse(input);
  const transport = Object.fromEntries(Object.entries(COMPACT_OBSERVATION_FIELDS)
    .map(([alias, field]) => [field, compact[alias as keyof typeof COMPACT_OBSERVATION_FIELDS]]));
  return normalizeObservationTransport(transport);
}

// Broad exclusions are intentional in this bounded demo capture flow. No emotional
// diagnosis, precise address, school identifier, contact detail, or secret is kept.
const SENSITIVE = /(?:password|passcode|phone number|email address|my address|live at|my school(?: is| name)|diagnos|depress(?:ed|ion)|anxiety disorder|medical|\b(?:adhd|autism|cancer|medication|suicide|self.harm)\b|\btrauma\b|\babuse\b|mật khẩu|địa chỉ|số điện thoại|trường của|tên trường|chẩn đoán|trầm cảm|bệnh|tự kỷ|tự tử|bị xâm hại|bí mật)/iu;
const CONTACT = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d[\d ()+-]{7,}\d\b)/iu;
const INJECTION = /(?:ignore (?:all |the )?(?:previous|system|developer)|system prompt|developer instructions?|bỏ qua (?:mọi|tất cả|hướng dẫn)|tiết lộ.*hướng dẫn)/iu;
const SUPPRESS = /(?:don['’]?t (?:remember|save)|do not (?:remember|save)|(?:ask(?:ed)?(?: you)?|told you) not to (?:remember|save)|not to save|đừng (?:nhớ|lưu)|không (?:cần |được )?(?:nhớ|lưu))/iu;
const NAME = "([\\p{Lu}][\\p{L}\\p{M}'’\\-]*(?:[ \\t]+[\\p{Lu}][\\p{L}\\p{M}'’\\-]*){0,3})";
const STOP_NAMES = new Set(['I', 'My', 'The', 'A', 'Dog', 'Cat', 'Mình', 'Tôi', 'Không', 'Chưa', 'Maybe', 'Unknown']);
const normalize = (value: string) => value.normalize('NFC').trim();
const validName = (value: string) => value.length <= 80 && !STOP_NAMES.has(value) && !/^(?:um|uh|maybe|something|ai đó)$/iu.test(value);

type EntityCorrection = NonNullable<Observation['entityCorrection']>;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
function mentions(text: string, name: string): boolean {
  return new RegExp('(?<![\\p{L}\\p{M}\\p{N}])' + escapePattern(name.normalize('NFC')) + '(?![\\p{L}\\p{M}\\p{N}])', 'iu').test(text.normalize('NFC'));
}
export function isNoSaveDirective(text: string): boolean { return SUPPRESS.test(text); }

export function analyzeInputSafety(text: string): { unsafeKind: NonNullable<Observation['unsafeKind']>; urgency: NonNullable<Observation['urgency']> } | null {
  if (/\b(?:in (?:my |a |the )?(?:pretend )?story|fictional|imaginary|quoted sentence)\b|(?:trong (?:câu )?truyện|tưởng tượng|câu trích dẫn)/iu.test(text)) return null;
  const methods = /(?:how (?:do|can|could|should) (?:i|you) (?:make|build|hurt|kill).*(?:bomb|weapon|myself|someone|people)|(?:instructions?|steps?|methods?|ways).*(?:suicide|self.harm|hurt myself|kill someone)|cách (?:làm|chế tạo) bom|cách (?:tự tử|tự làm đau|giết người))/iu;
  if (affirmativeSpeech(text, methods)) return { unsafeKind: 'harm_instructions', urgency: 'unclear' };
  const disclosure = /\bi (?:(?:really )?want|am going|plan|intend) to (?:kill|hurt) (?:myself|someone|people)\b|\bi am (?:hurting myself|in danger|not safe)\b|\bsomeone is (?:hurting|hitting) me\b|(?:mình|tớ|tôi|con) (?:(?:đang|sắp|muốn|định) )?(?:tự tử|tự làm đau|giết người|bị đánh|không an toàn)/iu;
  if (!affirmativeSpeech(text, disclosure)) return null;
  const immediate = /\b(?:right now|now|am going to|am hurting|in danger|not safe|someone is (?:hurting|hitting))\b|(?:ngay bây giờ|bây giờ|đang|sắp|không an toàn)/iu.test(text);
  return { unsafeKind: 'harm_disclosure', urgency: immediate ? 'immediate' : 'unclear' };
}

export function statedFeelingFromText(text: string): Observation['statedFeeling'] {
  const definitions: Array<[NonNullable<Observation['statedFeeling']>, string, string]> = [
    ['sad', 'sad|upset|lonely', 'buồn|cô đơn'],
    ['scared', 'scared|afraid|worried|anxious', 'sợ|lo lắng|lo'],
    ['angry', 'angry|mad', 'giận|bực'],
    ['frustrated', 'frustrated', 'nản|bực bội|khó chịu'],
    ['disappointed', 'disappointed', 'thất vọng|hụt hẫng|tiếc'],
    ['tired', 'tired|exhausted|sleepy', 'mệt|buồn ngủ'],
    ['happy', 'happy|excited|glad', 'vui|háo hức'],
  ];
  const denied = new Set<string>();
  for (const clause of speechClauses(text).reverse()) {
    for (const [feeling, en, vi] of definitions) {
      if (new RegExp("\\bi(?:['’]m| am| feel) (?:not|never) (?:really |very )?(?:" + en + ")\\b|(?:mình|tớ|tôi|con|em) (?:không|chẳng|chưa)(?: hề| còn)? (?:" + vi + ")", 'iu').test(clause)) denied.add(feeling);
    }
    for (const [feeling, en, vi] of definitions) {
      if (denied.has(feeling)) continue;
      const enPattern = new RegExp("\\bi(?:['’]m| am| feel) (?:(?:really|very|still|a little|quite|also) )?(?:" + en + ")\\b", 'iu');
      const viPattern = new RegExp("(?:mình|tớ|tôi|con|em)\\s+(?:(?:đang|hơi|rất|vẫn|còn|thấy|cảm thấy|thật|vừa)\\s+){0,4}(?:" + vi + ")(?![\\p{L}\\p{M}])", 'iu');
      const mixed = new RegExp("(?:mình|tớ|tôi)\\s+vừa\\s+(?:vui|buồn|sợ|giận|mệt)\\s+vừa\\s+(?:" + vi + ")(?![\\p{L}\\p{M}])", 'iu');
      if (affirmativeSpeech(clause, enPattern) || affirmativeSpeech(clause, viPattern) || affirmativeSpeech(clause, mixed)) {
        if (feeling === 'sad' && /buồn ngủ/iu.test(clause)) continue;
        return feeling;
      }
    }
    if (/(?:mình|tớ|tôi).{0,30}(?:vì|do)\s+mệt/iu.test(clause)) return 'tired';
  }
  return null;
}

export function requestedStoryAction(text: string): 'story' | 'continue_story' | null {
  // A mention in someone else's report or a quotation is not an activity request.
  if (/^(?:he|she|they|mum|mom|dad|my (?:friend|teacher)) (?:said|says|asked)\b|^(?:mẹ|bố|bạn ấy|cô giáo) (?:nói|bảo|hỏi)\b/iu.test(text.trim())) return null;
  const continuation = /\b(?:continue|finish|resume) (?:the |our )?story\b|(?:kể tiếp|tiếp tục).{0,12}(?:truyện|câu chuyện|chuyện)/iu;
  const story = /\b(?:tell (?:me )?(?:a |the )?story|let['’]?s (?:tell|make) a story)\b|(?:kể|nghe).{0,12}(?:truyện|câu chuyện|chuyện)/iu;
  if (affirmativeSpeech(text, continuation)) return 'continue_story';
  if (affirmativeSpeech(text, story)) return 'story';
  return null;
}

/** Correction scope is checked against the complete source, not just the
 * extractor's excerpt. A quoted/pretend/conditional name pair is not authority
 * to mutate a real saved entity. Ambiguous scope requires clarification. */
function assertedCorrectionScope(source: string, evidence: string, value: EntityCorrection, context?: ProviderClassificationContext): boolean {
  const start = source.indexOf(evidence);
  if (start < 0) return false;
  const left = Math.max(...['.', '!', '?', ';', '\n'].map(mark => source.lastIndexOf(mark, start - 1))) + 1;
  const after = start + evidence.length;
  const nextBoundary = /[.!?;\n]/u.exec(source.slice(after));
  const right = /[.!?;\n]$/u.test(evidence) ? after : nextBoundary ? after + nextBoundary.index + 1 : source.length;
  const clause = source.slice(left, right).trim();
  if (isPriorReportQuestion(source) || /[?？]/u.test(clause)
    || /^(?:did|do|does|is|are|was|were|has|have|had|can|could|would|will|what|who|when|where|why|how)\b|^(?:liệu|có phải)/iu.test(clause)) return false;
  if (/\b(?:if|maybe|perhaps|suppose|imagine|might|i wonder)\b|(?:có lẽ|giả sử|nếu|không chắc)/iu.test(source)) return false;
  // Quotes around an individual proper name are harmless; a quotation containing
  // the entire old/new proposition is reported content rather than a rename.
  const quotes = source.matchAll(/(?<![\p{L}\p{M}])["“‘']([^"”’'\n]*)["”’'](?![\p{L}\p{M}])/gu);
  for (const quote of quotes) if (mentions(quote[1]!, value.oldName) && mentions(quote[1]!, value.newName)) return false;
  if (/\b(?:said|says|told|asked|quoted|quote|read aloud)\b|(?:trích dẫn|đọc câu)|(?:mẹ|bố|ba|anh|chị|bạn ấy|người khác|cô ấy|thầy).{0,20}(?:bảo|nói|hỏi)/iu.test(clause)) return false;
  const fiction = /\b(?:pretend|imaginary|fictional|story|storybook|dream)\b|(?:trong (?:câu )?truyện|trong câu chuyện|tưởng tượng|giả vờ|giấc mơ)/iu.test(source);
  if (fiction) {
    const known = context?.entities.filter(entity => [entity.name, ...entity.aliases].some(name => normalize(name).toLocaleLowerCase('vi') === normalize(value.oldName).toLocaleLowerCase('vi'))) ?? [];
    if (value.entityKind !== 'story_character' || known.length !== 1 || known[0]!.kind !== 'story_character') return false;
  }
  return true;
}

/** A rename needs both literal names and a current explicit correction. Context
 * can disambiguate the known entity kind, but cannot supply missing evidence. */
export function validateEntityCorrection(text: string, input: unknown, context?: ProviderClassificationContext): EntityCorrection | null {
  const parsed = EntityCorrectionSchema.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data;
  const source = normalize(text); const evidence = normalize(value.evidence);
  if (!source.includes(evidence) || value.oldName === value.newName || !mentions(evidence, value.oldName) || !mentions(evidence, value.newName)) return null;
  if (!assertedCorrectionScope(source, evidence, value, context)) return null;
  if (![value.oldName, value.newName].every(name => /^[\p{L}\p{M}][\p{L}\p{M} .’'\-]{0,79}$/u.test(name) && validName(name))) return null;
  if (/\b(?:if|maybe|perhaps|suppose|imagine|might|i wonder)\b|(?:có lẽ|giả sử|nếu|không chắc)|(?:he|she|they|someone|bạn ấy|cô ấy|người khác).{0,16}(?:said|says|nói|bảo)/iu.test(evidence)) return null;
  const oldName = escapePattern(value.oldName); const newName = escapePattern(value.newName);
  const ownedNamePrefix = '(?:(?:my|our) (?:dog|cat|pet|rabbit|toy(?: rabbit)?|teddy bear|doll|story character)(?:[’\x27]s name is| (?:is named|is called|is|named|called))|(?:con )?(?:chó|mèo|thỏ bông|gấu bông|thỏ|thú cưng|đồ chơi|búp bê)(?: (?:nhà|của) (?:mình|tớ|tôi|con))? (?:tên là|là|tên)|nhà (?:mình|tớ|tôi) có (?:con )?(?:chó|mèo|thỏ|thú cưng))';
  const explicit = [
    ownedNamePrefix + '\\s+' + newName + '\\s*[,;:!—-]?\\s*(?:not|chứ không phải|không phải)\\s+' + oldName,
    '(?:not|không phải)\\s+' + oldName + '\\s*[,;:!—-]?\\s*(?:(?:but|mà)\\s+)?(?:it[’\x27]s|is|là|tên đúng là|đúng là)\\s+' + newName,
    '(?:(?:the )?(?:correct |right )?(?:name|spelling) is|it[’\x27]s|i meant|tên(?: đúng)? là|tên bạn(?: ấy)? là)\\s+' + newName + '.{0,30}(?:not|không phải)\\s+' + oldName,
    '^' + newName + '\\s*[,;:!—-]\\s*(?:not|không phải)\\s+' + oldName,
    oldName + '\\s*[,;:!—-]\\s*(?:i mean|i meant|ý (?:mình|tớ|tôi) là|ý là)\\s+' + newName,
    '(?:change|correct|rename|đổi|sửa).{0,25}' + oldName + '\\s+(?:to|thành)\\s+' + newName,
  ].some(pattern => new RegExp(pattern, 'iu').test(evidence));
  if (!explicit) return null;
  const known = context?.entities.filter(entity => [entity.name, ...entity.aliases].some(name => normalize(name).toLocaleLowerCase('vi') === normalize(value.oldName).toLocaleLowerCase('vi'))) ?? [];
  if (known.length > 1 || (known.length === 1 && known[0]!.kind !== value.entityKind)) return null;
  return value;
}
function localEntityCorrection(text: string, context?: ProviderClassificationContext): EntityCorrection | null {
  const ownedNamePrefix = '(?:(?:my|our) (?:dog|cat|pet|rabbit|toy(?: rabbit)?|teddy bear|doll|story character)(?:[’\x27]s name is| (?:is named|is called|is|named|called))|(?:con )?(?:chó|mèo|thỏ bông|gấu bông|thỏ|thú cưng|đồ chơi|búp bê)(?: (?:nhà|của) (?:mình|tớ|tôi|con))? (?:tên là|là|tên)|nhà (?:mình|tớ|tôi) có (?:con )?(?:chó|mèo|thỏ|thú cưng))';
  const patterns: Array<{ pattern: RegExp; reversed?: boolean }> = [
    { pattern: new RegExp(ownedNamePrefix + '\\s+' + NAME + '\\s*[,;:!—-]?\\s*(?:not|chứ không phải|không phải)\\s+' + NAME, 'iu'), reversed: true },
    { pattern: new RegExp('(?:not|không phải)\\s+' + NAME + '\\s*[,;:!—-]?\\s*(?:(?:but|mà)\\s+)?(?:it[’\x27]s|is|là|tên đúng là|đúng là)\\s+' + NAME, 'iu') },
    { pattern: new RegExp('(?:(?:the )?(?:correct |right )?(?:name|spelling) is|it[’\x27]s|i meant|tên(?: đúng)? là|tên bạn(?: ấy)? là)\\s+' + NAME + '\\s*[,;:!—-]\\s*(?:not|không phải)\\s+' + NAME, 'iu'), reversed: true },
    { pattern: new RegExp(NAME + '\\s*[,;:!—-]\\s*(?:i mean|i meant|ý (?:mình|tớ|tôi) là|ý là)\\s+' + NAME, 'iu') },
  ];
  for (const { pattern, reversed } of patterns) {
    const match = pattern.exec(text); if (!match) continue;
    const oldName = match[reversed ? 2 : 1]!; const newName = match[reversed ? 1 : 2]!;
    const known = context?.entities.filter(entity => [entity.name, ...entity.aliases].some(name => normalize(name).toLocaleLowerCase('vi') === normalize(oldName).toLocaleLowerCase('vi'))) ?? [];
    const entityKind = known.length === 1 ? known[0]!.kind : /\b(?:dog|cat|pet)\b|(?:chó|mèo|thú cưng)/iu.test(match[0]) ? 'pet'
      : /(?:story character|nhân vật)/iu.test(text) ? 'story_character' : /\b(?:toy|doll|object)\b|(?:đồ chơi|gấu bông|thỏ bông)/iu.test(text) ? 'object' : 'person';
    const correction = validateEntityCorrection(text, { oldName, newName, entityKind, evidence: match[0] }, context);
    if (correction) return correction;
  }
  return null;
}

/** An active reply-language directive is stronger evidence than the language of
 * the surrounding sentence. Quoted, reported and past requests are not orders. */
export function requestedReplyLanguage(text: string): Language | null {
  const unquoted = text.normalize('NFC').replace(/(?<![\p{L}\p{M}])["“‘']([^"”’'\n]*)["”’'](?![\p{L}\p{M}])/gu, ' ');
  let requested: Language | null = null;
  for (const raw of speechClauses(unquoted)) {
    let clause = raw.trim().replace(/^(?:miu(?: ơi)?|okay|ok|được rồi)[,:!—-]?\s*/iu, '');
    // A new sentence/contrast can make a current request after a past report.
    if (/\b(?:yesterday|previously|last time|said|says|told|asked|used to|wanted to)\b|(?:hôm qua|lần trước|đã muốn)|(?:mẹ|bố|bạn ấy|cô giáo) (?:nói|bảo|hỏi)/iu.test(clause)) continue;
    clause = clause.replace(/^(?:now|right now|giờ|bây giờ)[,:]?\s*/iu, '');
    const language = '(English|Vietnamese|tiếng Anh|tiếng Việt)';
    const patterns = [
      new RegExp('^' + language + '\\s+(?:please|now|nhé|nha|đi)(?=$|[.!?,:])', 'iu'),
      new RegExp('^(?:(?:please\\s+)?(?:answer|reply|respond|speak|talk)|(?:can|could|would) you (?:please )?(?:answer|reply|respond|speak|talk))(?:\\s+(?:(?:to|with)\\s+)?me)?(?:\\s+(?:in|using))?\\s+' + language + '(?![\\p{L}\\p{M}])', 'iu'),
      new RegExp('^I (?:want|would like) to (?:speak|talk|use)(?: in)?\\s+' + language + '(?![\\p{L}\\p{M}])', 'iu'),
      new RegExp('^(?:mình|tớ|tôi|con|em) muốn (?:nói|dùng|trả lời bằng)\\s+' + language + '(?![\\p{L}\\p{M}])', 'iu'),
      new RegExp('^(?:hãy |bạn (?:hãy |có thể )?)?(?:nói|trả lời)(?: với mình)?(?: bằng)?\\s+' + language + '(?![\\p{L}\\p{M}])', 'iu'),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(clause);
      if (!match) continue;
      const tail = clause.slice(match[0].length);
      if (/^\s*(?:means?|nghĩa là|có nghĩa|là gì)\b/iu.test(tail)) continue;
      requested = /^(?:English|tiếng Anh)$/iu.test(match[1]!) ? 'en' : 'vi';
      break;
    }
  }
  return requested;
}

function detectedLanguage(text: string, hint: Language): Language {
  if (/\b(?:my|i am|i like|i hate|hello|forget|please|tell me|continue)\b/iu.test(text)) return 'en';
  return /(?:^|\s)(?:mình|tôi|tớ|thích|ghét|sợ|của|tên|chó|mèo|kể|tiếp|quên|buồn|chào)(?:\s|$|[.!?])/iu.test(text) ? 'vi' : hint;
}

function inferForget(text: string): string | null | undefined {
  const trimmed = text.trim().replace(/[.!?]+$/u, '');
  const match = /^(?:please\s+)?(?:forget|quên|hãy quên)(?:\s+(.+))?$/iu.exec(trimmed);
  if (!match) return undefined;
  const value = match[1]?.trim();
  if (!value || /^(?:that|this|it|điều đó|chuyện đó|cái đó|điều này)$/iu.test(value)) return null;
  if (/^(?:everything(?: about me)?|all(?: about me)?|tất cả(?: về mình| về tôi)?|hết)$/iu.test(value)) return 'all';
  return value.slice(0, 100);
}

/** A real entity needs a current assertion outside a fictional or quoted
 * proposition. The general assertion guard already handles polarity and plans;
 * its event-only fiction rule is not sufficient for entity-name substrings. */
function hasCurrentCandidateAssertion(text: string, candidate: MemoryCandidate): boolean {
  if (candidate.kind !== 'entity' || candidate.entityKind === 'story_character') return assertionEvidence(text, candidate) !== null;
  const source = text.normalize('NFC');
  const excerpt = candidate.evidence.normalize('NFC');
  if (!excerpt.trim()) return false;
  const quotations = [...source.matchAll(/"([^"]*)"|“([^”]*)”|‘([^’]*)’|(?<![\p{L}\p{M}])'([^']*)'(?![\p{L}\p{M}])/gu)]
    .map(match => ({ start: match.index, end: match.index + match[0].length, value: match[1] ?? match[2] ?? match[3] ?? match[4] ?? '' }));
  for (let start = source.indexOf(excerpt); start >= 0; start = source.indexOf(excerpt, start + 1)) {
    const end = start + excerpt.length;
    // Quoting a proper name alone is ordinary naming; quoting its enclosing
    // ownership proposition does not make it the current speaker's assertion.
    if (quotations.some(quote => quote.start <= start && end <= quote.end && normalize(quote.value) !== normalize(candidate.name))) continue;
    let left = Math.max(...['.', '!', '?', ';', '\n'].map(mark => source.lastIndexOf(mark, start - 1))) + 1;
    const prefix = source.slice(left, start);
    const realityMarkers = [...prefix.matchAll(/\b(?:but\s+)?in real life[,:]?\s*|(?:còn\s+)?ngoài đời(?: thật)?[,:]?\s*/giu)];
    const reality = realityMarkers.at(-1);
    if (reality) left += reality.index + reality[0].length;
    const remaining = source.slice(end);
    const boundary = /[.!?;\n]/u.exec(remaining);
    const right = /[.!?;\n]$/u.test(excerpt) ? end : boundary ? end + boundary.index + 1 : source.length;
    const clause = source.slice(left, right);
    const throughExcerpt = source.slice(left, end);
    const fictional = /\b(?:pretend|imaginary|fictional)\b|\b(?:in|inside|within)\s+(?:(?:my|our|a|the|this|that)\s+)?(?:story|storybook|dream)\b|(?:trong (?:câu )?truyện|trong câu chuyện|tưởng tượng|giả vờ|giấc mơ)/iu.test(throughExcerpt);
    const reported = /\b(?:he|she|they|someone|mum|mom|dad|my (?:friend|teacher|mother|father|sister|brother))\s+(?:said|says|told|asked)\b|\b(?:sentence|quote|book|story)\s+(?:says|reads)\b|\b(?:quoted|read aloud)\b|(?:trích dẫn|đọc câu)|(?:mẹ|bố|ba|bạn ấy|cô giáo|thầy|người khác)\s+(?:nói|bảo|hỏi)/iu.test(throughExcerpt);
    if (!fictional && !reported && assertionEvidence(clause, candidate)) return true;
  }
  return false;
}

export function classifyLocal(text: string, languageHint: Language = 'en', context?: ProviderClassificationContext): Observation {
  const language = requestedReplyLanguage(text) ?? socialFormulaLanguage(text, context?.entities) ?? detectedLanguage(text, languageHint);
  const result: Observation = { intent: 'chat', language, statedFeeling: null, unsafeKind: null, urgency: null, uncertain: false, uncertainty: null, correctionTarget: null, entityCorrection: null, candidates: [], forgetTarget: null, suppressLearning: false };
  if (!text.trim()) return { ...result, intent: 'greeting' };
  if (/^(?:stop|goodbye|bye|dừng(?: lại)?|tạm biệt)[.!?\s]*$/iu.test(text.trim())) return { ...result, intent: 'stop', suppressLearning: true };
  const forget = inferForget(text);
  if (forget !== undefined) return { ...result, intent: 'forget', forgetTarget: forget, suppressLearning: true };
  const safety = analyzeInputSafety(text);
  if (safety) return { ...result, ...safety, intent: 'unsafe', suppressLearning: true };
  const entityCorrection = localEntityCorrection(text, context);
  if (entityCorrection) return { ...result, intent: 'correct', suppressLearning: true, entityCorrection };
  const correction = /^(?:i (?:did not|didn['’]t|never) (?:say|tell you)|(?:mình|tớ|tôi) (?:chưa|không|chẳng)(?: hề)? (?:nói|kể)(?: với (?:bạn|miu))?)\s+(.+?)[.!]*$/iu.exec(text.trim());
  if (correction) {
    const target = correction[1]!.replace(/^(?:that |rằng )/iu, '').replace(/[,;].*$/u, '').trim();
    return { ...result, intent: 'correct', suppressLearning: true, correctionTarget: /^(?:that|it|this|điều đó|chuyện đó|vậy)$/iu.test(target) ? null : target };
  }
  if (isPriorReportQuestion(text)) { result.uncertain = true; result.uncertainty = 'prior_report'; }
  const sensitive = SENSITIVE.test(text) || CONTACT.test(text);
  result.suppressLearning = sensitive || SUPPRESS.test(text) || INJECTION.test(text);
  result.statedFeeling = statedFeelingFromText(text);
  if (result.statedFeeling && result.statedFeeling !== 'happy') result.intent = 'comfort';
  if (/^(?:hello|hi|hey|chào(?: miu)?|xin chào)[.!?\s]*$/iu.test(text.trim())) result.intent = 'greeting';
  const storyAction = requestedStoryAction(text);
  if (storyAction) result.intent = storyAction;
  if (result.suppressLearning) return result;

  const add = (candidate: MemoryCandidate) => {
    const checked = MemoryCandidateSchema.safeParse(candidate);
    if (!checked.success) { result.uncertain = true; return; }
    if (!result.candidates.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) result.candidates.push(candidate);
  };
  // Case insensitive matching applies to the lead-in only: names retain a capital
  // initial so “my dog is happy” cannot become a guessed proper name.
  const enEntities = /\bmy (?:(?:toy rabbit|teddy bear)|dog|cat|rabbit|hamster|bird|doll|toy)(?:['’]s name is| (?:is (?:called|named)|named|called|is))? /giu;
  for (const lead of text.matchAll(enEntities)) {
    const tail = text.slice((lead.index ?? 0) + lead[0].length);
    const nameMatch = new RegExp('^' + NAME, 'u').exec(tail);
    if (!nameMatch || !validName(nameMatch[1]!)) continue;
    const kindText = /my (.+?)(?: is| named| called| $)/iu.exec(lead[0])?.[1] ?? lead[0].replace(/^my /iu, '').trim();
    const species = /dog/iu.test(kindText) ? 'dog' : /cat/iu.test(kindText) ? 'cat' : /rabbit/iu.test(kindText) ? 'rabbit' : /hamster/iu.test(kindText) ? 'hamster' : /bird/iu.test(kindText) ? 'bird' : null;
    const entityKind = /toy|teddy|doll/iu.test(kindText) ? 'object' : 'pet';
    add({ kind: 'entity', entityKind, name: normalize(nameMatch[1]!), species: entityKind === 'pet' ? species : null, evidence: lead[0] + nameMatch[0] });
  }
  const viEntities = /(?<![\p{L}\p{M}])(?:chó|mèo|thỏ bông|gấu bông|thỏ|đồ chơi|búp bê)(?: (?:của )?(?:mình|tôi|tớ))? (?:tên là|tên|là) /giu;
  for (const lead of text.matchAll(viEntities)) {
    const nameMatch = new RegExp('^' + NAME, 'u').exec(text.slice((lead.index ?? 0) + lead[0].length));
    if (!nameMatch || !validName(nameMatch[1]!)) continue;
    const species = /^chó/iu.test(lead[0]) ? 'dog' : /^mèo/iu.test(lead[0]) ? 'cat' : /^thỏ/iu.test(lead[0]) ? 'rabbit' : null;
    const entityKind = /bông|đồ chơi|búp bê/iu.test(lead[0]) ? 'object' : 'pet';
    add({ kind: 'entity', entityKind, name: normalize(nameMatch[1]!), species: entityKind === 'pet' ? species : null, evidence: lead[0] + nameMatch[0] });
  }
  const storyCharacters = /(?:my (?:story )?character (?:is named|is called|is)|nhân vật (?:của mình )?(?:tên là|là)) /giu;
  for (const lead of text.matchAll(storyCharacters)) {
    const nameMatch = new RegExp('^' + NAME, 'u').exec(text.slice((lead.index ?? 0) + lead[0].length));
    if (nameMatch && validName(nameMatch[1]!)) add({ kind: 'entity', entityKind: 'story_character', name: normalize(nameMatch[1]!), species: null, evidence: lead[0] + nameMatch[0] });
  }
  const enRelations = /\b(?:my|i have a) (sister|brother|mother|mom|mum|father|dad|friend|teacher|grandmother|grandfather|cousin)(?:['’]s name)? (?:is(?: called| named)?|named|called) /giu;
  for (const lead of text.matchAll(enRelations)) {
    const nameMatch = new RegExp('^' + NAME, 'u').exec(text.slice((lead.index ?? 0) + lead[0].length));
    if (!nameMatch || !validName(nameMatch[1]!)) continue;
    const rawRelation = lead[1]!.toLowerCase();
    const relation = ({ mom: 'mother', mum: 'mother', dad: 'father', sister: 'sibling', brother: 'sibling', grandmother: 'grandparent', grandfather: 'grandparent' } as Record<string, string>)[rawRelation] ?? rawRelation;
    add({ kind: 'relationship', name: normalize(nameMatch[1]!), relation, evidence: lead[0] + nameMatch[0] });
  }
  const viRelations = /(?<![\p{L}\p{M}])(?:chị gái|anh trai|em gái|em trai|chị|anh|em|mẹ|bố|ba|bạn|cô giáo|thầy giáo|bà|ông)(?: (?:của )?(?:mình|tôi|tớ)) (?:tên là|là) /giu;
  for (const lead of text.matchAll(viRelations)) {
    const nameMatch = new RegExp('^' + NAME, 'u').exec(text.slice((lead.index ?? 0) + lead[0].length));
    if (!nameMatch || !validName(nameMatch[1]!)) continue;
    const relation = /^(?:chị|anh|em)/iu.test(lead[0]) ? 'sibling' : /^mẹ/iu.test(lead[0]) ? 'mother' : /^(?:bố|ba)/iu.test(lead[0]) ? 'father' : /giáo/iu.test(lead[0]) ? 'teacher' : /^(?:ông|bà)/iu.test(lead[0]) ? 'grandparent' : 'friend';
    add({ kind: 'relationship', name: normalize(nameMatch[1]!), relation, evidence: lead[0] + nameMatch[0] });
  }

  const viIntroductions = /(?<![\p{L}\p{M}])(?:mình|tôi|tớ) có (?:một )?(?:người )?(bạn|chị gái|anh trai|em gái|em trai|chị|anh|em) tên (?:là )?/giu;
  for (const lead of text.matchAll(viIntroductions)) {
    const nameMatch = new RegExp('^' + NAME, 'u').exec(text.slice((lead.index ?? 0) + lead[0].length));
    if (nameMatch && validName(nameMatch[1]!)) add({ kind: 'relationship', name: normalize(nameMatch[1]!), relation: lead[1]!.toLowerCase() === 'bạn' ? 'friend' : 'sibling', evidence: lead[0] + nameMatch[0] });
  }

  const clauses = text.split(/[.!?;\n]+/u).map((part) => part.trim()).filter(Boolean);
  const preferencePatterns: Array<[RegExp, PreferenceCategory]> = [
    [/^(?:my routine is)\s+(.+)$/iu, 'routine'],
    [/^(?:thói quen của (?:mình|tôi|tớ) là)\s+(.+)$/iu, 'routine'],
    [/^(?:my hobb(?:y|ies) (?:is|are)|i enjoy)\s+(.+)$/iu, 'hobby'],
    [/^(?:i like|i love)\s+(.+)$/iu, 'like'],
    [/^(?:i dislike|i hate|i don['’]?t like)\s+(.+)$/iu, 'dislike'],
    [/^(?:i(?:['’]m| am) (?:scared|afraid) of|i fear)\s+(.+)$/iu, 'fear'],
    [/^(?:i like|i love) stories? (?:about|with)\s+(.+)$/iu, 'story_preference'],
    [/^(?:sở thích của (?:mình|tôi|tớ) là|(?:mình|tôi|tớ) thích chơi)\s+(.+)$/iu, 'hobby'],
    [/^(?:mình|tôi|tớ) (?:thích|rất thích|yêu)\s+(.+)$/iu, 'like'],
    [/^(?:mình|tôi|tớ) (?:ghét|không thích)\s+(.+)$/iu, 'dislike'],
    [/^(?:mình|tôi|tớ) (?:sợ|rất sợ)\s+(.+)$/iu, 'fear'],
    [/^(?:mình|tôi|tớ) thích (?:truyện|câu chuyện) (?:về|có)\s+(.+)$/iu, 'story_preference'],
    [/^(?:i(?:['’]m| am))\s+(shy|curious|creative|quiet|outgoing|patient|playful)$/iu, 'self_description'],
    [/^(?:mình|tôi|tớ) (?:là người |hơi |rất )?(nhút nhát|tò mò|sáng tạo|ít nói|kiên nhẫn|vui tính)$/iu, 'self_description'],
  ];
  for (const clause of clauses) {
    // Specific story preferences must win over the generic like rule.
    const ordered = [...preferencePatterns].sort((a, b) => Number(b[1] === 'story_preference') - Number(a[1] === 'story_preference'));
    for (const [pattern, category] of ordered) {
      const match = pattern.exec(clause);
      if (!match) continue;
      const value = match[1]!.trim();
      if (value.length > 160 || /(?:maybe|not sure|có lẽ|không chắc)/iu.test(value)) { result.uncertain = true; break; }
      if (value && !SENSITIVE.test(value)) add({ kind: 'preference', category, value, evidence: clause });
      break;
    }
  }

  const introducedPets = result.candidates.filter((candidate): candidate is Extract<MemoryCandidate, { kind: 'entity' }> => candidate.kind === 'entity' && candidate.entityKind === 'pet');
  const puddle = /(?:fell (?:in|into) a puddle|rơi (?:vào|xuống) vũng nước|ngã (?:vào|xuống) vũng nước)/iu.exec(text);
  if (puddle) {
    const preceding = text.slice(0, puddle.index).trim();
    const named = introducedPets.find((pet) => text.includes(pet.name));
    const latestName = new RegExp(NAME + '\\s*$', 'u').exec(preceding)?.[1] ?? null;
    const subjectName = named?.name ?? (latestName && validName(latestName) ? latestName : null);
    if (subjectName) {
      const start = text.lastIndexOf(subjectName, puddle.index);
      add({ kind: 'event', subjectName, eventType: 'fell_in_puddle', value: puddle[0], evidence: text.slice(Math.max(0, start), puddle.index + puddle[0].length) });
    }
  }

  for (const clause of clauses) {
    const story = /^(?:my story is called|câu chuyện của (?:mình|tôi|tớ) tên là)\s+["“]([^"”]+)["”](?:\s*:\s*(.+))?$/iu.exec(clause);
    if (story) add({ kind: 'story', title: story[1]!, summary: story[2] ?? story[1]!, castNames: [], evidence: clause });
  }
  if (/(?:named|called|tên là)\s+(?:um|uh|maybe|không rõ|không chắc|[?])/iu.test(text) || /(?:named|called|tên là)\s+\p{Ll}/u.test(text)) result.uncertain = true;
  if (result.candidates.length && result.intent === 'chat') result.intent = 'share';
  result.candidates = result.candidates.filter(candidate => hasCurrentCandidateAssertion(text, candidate)).slice(0, 12);
  if (result.uncertain && !result.uncertainty) result.uncertainty = 'name';
  return result;
}

export function isPriorReportQuestion(text: string): boolean {
  return /\b(?:did|have) i (?:ever |already )?(?:tell|told|say|said|mention|mentioned)\b|(?:mình|tớ|tôi) (?:đã )?(?:kể|nói).*(?:chưa|không)[?？]?/iu.test(text);
}

export interface ObservationEvidence {
  proposed: Observation;
  accepted: Observation;
  rejectedCandidates: { candidate: MemoryCandidate; reason: 'evidence_not_in_input' | 'non_asserted_source' | 'persistence_policy' | 'persistence_suppressed' | 'moderation_blocked' | 'ambiguous_identity' }[];
}

/** The same source and state-changing-intent guards apply in serving and evaluation. */
export function validateObservationEvidence(text: string, observation: unknown, context?: ProviderClassificationContext): ObservationEvidence {
  const parsed = normalizeObservationTransport(observation);
  const local = classifyLocal(text, parsed.language, context);
  const entityCorrection = local.entityCorrection ?? validateEntityCorrection(text, parsed.entityCorrection, context);
  const suppressLearning = local.suppressLearning || parsed.suppressLearning || entityCorrection !== null;
  const candidates: MemoryCandidate[] = [];
  const rejectedCandidates: ObservationEvidence['rejectedCandidates'] = [];
  let ambiguousIdentity = false;
  // Prefer deterministic captures where available; model proposals extend the
  // vocabulary only when both their literal evidence and its assertion scope pass.
  for (const candidate of [...local.candidates, ...parsed.candidates]) {
    const unclearRename = candidate.kind === 'entity' && !entityCorrection
      && /\b(?:now called|new name|changed (?:its|the) name)\b|(?:giờ tên|tên mới|đổi tên thành)/iu.test(text)
      && context?.entities.some(entity => entity.kind === candidate.entityKind && entity.name !== candidate.name)
      && !/\b(?:another|second|different|also have)\b|(?:thêm|khác|nữa)/iu.test(text);
    if (unclearRename) ambiguousIdentity = true;
    const reason = suppressLearning ? 'persistence_suppressed' as const
      : unclearRename ? 'ambiguous_identity' as const
      : !text.normalize('NFC').includes(candidate.evidence.normalize('NFC')) ? 'evidence_not_in_input' as const
        : !hasCurrentCandidateAssertion(text, candidate) ? 'non_asserted_source' as const
          : !validateCandidate(candidate) ? 'persistence_policy' as const : null;
    if (reason) { if (parsed.candidates.includes(candidate)) rejectedCandidates.push({ candidate, reason }); continue; }
    const same = (other: MemoryCandidate) => {
      if (other.kind !== candidate.kind) return false;
      if (other.kind === 'entity' && candidate.kind === 'entity') return other.entityKind === candidate.entityKind && other.name === candidate.name && other.species === candidate.species;
      if (other.kind === 'preference' && candidate.kind === 'preference') return other.category === candidate.category && other.value === candidate.value;
      if (other.kind === 'event' && candidate.kind === 'event') return other.subjectName === candidate.subjectName && other.eventType === candidate.eventType && (candidate.eventType === 'fell_in_puddle' || other.value === candidate.value);
      const { evidence: _a, ...a } = other; const { evidence: _b, ...b } = candidate;
      return JSON.stringify(a) === JSON.stringify(b);
    };
    const previous = candidates.findIndex(same);
    if (previous < 0) candidates.push(candidate);
    else candidates[previous] = { ...candidates[previous], ...candidate } as MemoryCandidate;
  }
  let intent = entityCorrection ? 'correct' : local.intent !== 'chat' ? local.intent
    : ['forget', 'stop', 'correct'].includes(parsed.intent) ? 'chat' : parsed.intent;
  const negatedFeeling = /\bi(?:['’]m| am| feel) not (?:sad|scared|afraid|angry|frustrated|tired)\b|\bnot because i (?:am|feel) (?:sad|scared)\b|(?:mình|tớ|tôi) (?:không|chẳng) (?:buồn|sợ|giận|mệt)/iu.test(text);
  if (intent === 'comfort' && !local.statedFeeling && negatedFeeling) intent = 'chat';
  const storyMention = /\bstory\b|truyện|câu chuyện/iu.test(text);
  if (['story', 'continue_story'].includes(intent) && storyMention && !requestedStoryAction(text)
      && /\b(?:not|never|don['’]t|do not|no)\b|(?:không|đừng|chẳng)/iu.test(text)) intent = local.intent === 'comfort' ? 'comfort' : 'chat';
  let uncertain = local.uncertain || parsed.uncertain;
  let uncertainty = local.uncertainty ?? parsed.uncertainty ?? (parsed.uncertain ? 'meaning' : null);
  if (ambiguousIdentity) { uncertain = true; uncertainty = 'meaning'; }
  if (uncertainty === 'name' && context) {
    const known = context.entities.filter(entity => [entity.name, ...entity.aliases].some(name => mentions(text, name)));
    const explicitlyUnclearName = /(?:unclear|not sure|don['’]?t know).{0,25}(?:name|spelling)|(?:tên|cách viết).{0,20}(?:không rõ|không chắc|chưa biết)/iu.test(text);
    if (known.length === 1 && !explicitlyUnclearName) {
      uncertainty = isPriorReportQuestion(text) ? 'prior_report' : /[?？]|\b(?:whether|happened|bath|puddle)\b|(?:có lẽ|chưa|tắm|vũng nước)/iu.test(text) ? 'event' : null;
      uncertain = uncertainty !== null;
    }
  }
  const noSaveOnly = isNoSaveDirective(text) && local.intent !== 'forget' && !entityCorrection && local.intent !== 'correct';
  const accepted: Observation = {
    ...parsed,
    intent: parsed.intent === 'unsafe' ? 'unsafe' : noSaveOnly && parsed.intent === 'forget' ? 'chat' : intent,
    language: requestedReplyLanguage(text) ?? socialFormulaLanguage(text, context?.entities) ?? parsed.language,
    statedFeeling: local.statedFeeling,
    unsafeKind: local.unsafeKind ?? (intent === 'unsafe' ? parsed.unsafeKind ?? null : null),
    urgency: local.urgency ?? (intent === 'unsafe' ? parsed.urgency ?? null : null),
    uncertain, uncertainty,
    correctionTarget: entityCorrection ? null : local.correctionTarget,
    entityCorrection,
    candidates: candidates.slice(0, 12),
    forgetTarget: local.forgetTarget,
    suppressLearning,
  };
  return { proposed: parsed, accepted, rejectedCandidates };
}
export function validateObservation(text: string, observation: unknown, context?: ProviderClassificationContext): Observation {
  return validateObservationEvidence(text, observation, context).accepted;
}
