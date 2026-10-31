import { z } from 'zod';
import type { Language, MemoryCandidate, Observation, PreferenceCategory, ProviderClassificationContext } from '../shared/types.js';
import { validateCandidate } from '../memory/evidence.js';
import { assertionEvidence } from '../memory/assertions.js';

const boundedText = z.string().min(1).max(500);
export const MemoryCandidateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entityKind: z.enum(['person', 'pet', 'object', 'story_character']), name: z.string().min(1).max(80), species: z.string().max(40).nullable(), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('preference'), category: z.enum(['hobby', 'like', 'dislike', 'fear', 'self_description', 'story_preference', 'routine']), value: z.string().min(1).max(160), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('relationship'), name: z.string().min(1).max(80), relation: z.string().min(1).max(40), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('event'), subjectName: z.string().max(80).nullable(), eventType: z.enum(['fell_in_puddle', 'reported_event', 'planned_activity']), value: z.string().min(1).max(300), evidence: boundedText }).strict(),
  z.object({ kind: z.literal('story'), title: z.string().min(1).max(100), summary: boundedText, castNames: z.array(z.string().min(1).max(80)).max(8), evidence: boundedText }).strict(),
]);
export const EntityCorrectionSchema = z.object({
  oldName: z.string().min(1).max(80), newName: z.string().min(1).max(80),
  entityKind: z.enum(['person', 'pet', 'object', 'story_character']), evidence: boundedText,
}).strict();
export const ObservationSchema = z.object({
  intent: z.enum(['chat', 'share', 'comfort', 'forget', 'correct', 'story', 'continue_story', 'greeting', 'stop', 'unsafe']),
  language: z.enum(['vi', 'en']),
  statedFeeling: z.enum(['sad', 'scared', 'happy']).nullable(),
  uncertain: z.boolean(),
  uncertainty: z.enum(['name', 'event', 'prior_report', 'meaning']).nullable(),
  correctionTarget: z.string().max(300).nullable(),
  entityCorrection: EntityCorrectionSchema.nullable(),
  candidates: z.array(MemoryCandidateSchema).max(12),
  forgetTarget: z.string().max(100).nullable(),
  suppressLearning: z.boolean(),
}).strict();

// Broad exclusions are intentional in this bounded demo capture flow. No emotional
// diagnosis, precise address, school identifier, contact detail, or secret is kept.
const SENSITIVE = /(?:password|passcode|phone number|email address|my address|live at|my school(?: is| name)|diagnos|depress(?:ed|ion)|anxiety disorder|medical|\b(?:adhd|autism|cancer|medication|suicide|self.harm)\b|\btrauma\b|\babuse\b|mật khẩu|địa chỉ|số điện thoại|trường của|tên trường|chẩn đoán|trầm cảm|bệnh|tự kỷ|tự tử|bị xâm hại|bí mật)/iu;
const CONTACT = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d[\d ()+-]{7,}\d\b)/iu;
const INJECTION = /(?:ignore (?:all |the )?(?:previous|system|developer)|system prompt|developer instructions?|bỏ qua (?:mọi|tất cả|hướng dẫn)|tiết lộ.*hướng dẫn)/iu;
const DANGER = /(?:how (?:do|can) (?:i|you) (?:make|build).*(?:bomb|weapon)|(?:want|going) to (?:kill|hurt) (?:myself|someone|people)|instructions?.*(?:suicide|self.harm)|cách (?:làm|chế tạo) bom|muốn (?:tự tử|giết|tự làm đau))/iu;
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

export function classifyLocal(text: string, languageHint: Language = 'en', context?: ProviderClassificationContext): Observation {
  const language = detectedLanguage(text, languageHint);
  const result: Observation = { intent: 'chat', language, statedFeeling: null, uncertain: false, uncertainty: null, correctionTarget: null, entityCorrection: null, candidates: [], forgetTarget: null, suppressLearning: false };
  if (!text.trim()) return { ...result, intent: 'greeting' };
  if (/^(?:stop|goodbye|bye|dừng(?: lại)?|tạm biệt)[.!?\s]*$/iu.test(text.trim())) return { ...result, intent: 'stop', suppressLearning: true };
  const forget = inferForget(text);
  if (forget !== undefined) return { ...result, intent: 'forget', forgetTarget: forget, suppressLearning: true };
  if (DANGER.test(text)) return { ...result, intent: 'unsafe', suppressLearning: true };
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
  if (/\b(?:i(?:['’]m| am) (?:really |very )?(?:sad|upset)|i feel (?:sad|upset))\b|(?:mình|tớ|tôi).{0,16}(?:buồn|khó chịu)/iu.test(text)) {
    result.intent = 'comfort'; result.statedFeeling = 'sad';
  } else if (/\b(?:i(?:['’]m| am) (?:scared|afraid)|i feel scared)\b|(?:mình|tớ|tôi).{0,8}sợ/iu.test(text)) {
    result.intent = 'comfort'; result.statedFeeling = 'scared';
  } else if (/\b(?:i(?:['’]m| am) happy|i feel happy)\b|(?:mình|tớ|tôi).{0,8}vui/iu.test(text)) result.statedFeeling = 'happy';
  if (/^(?:hello|hi|hey|chào(?: miu)?|xin chào)[.!?\s]*$/iu.test(text.trim())) result.intent = 'greeting';
  if (/\b(?:continue|finish|resume) (?:the |our )?story\b|(?:kể tiếp|tiếp tục).{0,12}(?:truyện|câu chuyện|chuyện)/iu.test(text)) result.intent = 'continue_story';
  else if (/\b(?:tell (?:me )?(?:a |the )?story|let['’]?s (?:tell|make) a story)\b|(?:kể|nghe).{0,12}(?:truyện|câu chuyện|chuyện)/iu.test(text)) result.intent = 'story';
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
  result.candidates = result.candidates.filter(candidate => assertionEvidence(text, candidate)).slice(0, 12);
  if (result.uncertain && !result.uncertainty) result.uncertainty = 'name';
  return result;
}

export function isPriorReportQuestion(text: string): boolean {
  return /\b(?:did|have) i (?:ever |already )?(?:tell|told|say|said|mention|mentioned)\b|(?:mình|tớ|tôi) (?:đã )?(?:kể|nói).*(?:chưa|không)[?？]?/iu.test(text);
}

export interface ObservationEvidence {
  proposed: Observation;
  accepted: Observation;
  rejectedCandidates: { candidate: MemoryCandidate; reason: 'evidence_not_in_input' | 'non_asserted_source' | 'persistence_policy' | 'persistence_suppressed' | 'moderation_blocked' }[];
}

/** The same source and state-changing-intent guards apply in serving and evaluation. */
export function validateObservationEvidence(text: string, observation: unknown, context?: ProviderClassificationContext): ObservationEvidence {
  const parsed = ObservationSchema.parse(observation);
  const local = classifyLocal(text, parsed.language, context);
  const entityCorrection = local.entityCorrection ?? validateEntityCorrection(text, parsed.entityCorrection, context);
  const suppressLearning = local.suppressLearning || parsed.suppressLearning || entityCorrection !== null;
  const candidates: MemoryCandidate[] = [];
  const rejectedCandidates: ObservationEvidence['rejectedCandidates'] = [];
  // Prefer deterministic captures where available; model proposals extend the
  // vocabulary only when both their literal evidence and its assertion scope pass.
  for (const candidate of [...local.candidates, ...parsed.candidates]) {
    const reason = suppressLearning ? 'persistence_suppressed' as const
      : !text.normalize('NFC').includes(candidate.evidence.normalize('NFC')) ? 'evidence_not_in_input' as const
        : !assertionEvidence(text, candidate) ? 'non_asserted_source' as const
          : !validateCandidate(candidate) ? 'persistence_policy' as const : null;
    if (reason) { if (parsed.candidates.includes(candidate)) rejectedCandidates.push({ candidate, reason }); continue; }
    const same = (other: MemoryCandidate) => {
      if (other.kind !== candidate.kind) return false;
      if (other.kind === 'event' && candidate.kind === 'event') return other.subjectName === candidate.subjectName && other.eventType === candidate.eventType && (candidate.eventType === 'fell_in_puddle' || other.value === candidate.value);
      const { evidence: _a, ...a } = other; const { evidence: _b, ...b } = candidate;
      return JSON.stringify(a) === JSON.stringify(b);
    };
    if (!candidates.some(same)) candidates.push(candidate);
  }
  const intent = entityCorrection ? 'correct' : local.intent !== 'chat' ? local.intent
    : ['forget', 'stop', 'correct'].includes(parsed.intent) ? 'chat' : parsed.intent;
  let uncertain = local.uncertain || parsed.uncertain;
  let uncertainty = local.uncertainty ?? parsed.uncertainty ?? (parsed.uncertain ? 'meaning' : null);
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
    language: parsed.language,
    statedFeeling: local.statedFeeling,
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
