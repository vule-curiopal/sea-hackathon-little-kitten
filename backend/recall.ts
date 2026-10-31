import type { DirectorInput, DirectorPlan, Entity, MemoryCandidate, MemoryContext, RecallHook, SessionExchange } from './shared/types.js';
import { getStory } from './stories/index.js';
import { retiredNameHash } from './memory/normalization.js';

const normalized = (value: string) => value.normalize('NFC').toLocaleLowerCase('vi');
const mentions = (text: string, name: string): boolean => {
  const escaped = normalized(name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return !!escaped && new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'u').test(normalized(text));
};
const namedEntities = (context: MemoryContext, text: string): Entity[] => context.entities
  .filter(entity => [entity.name, ...entity.aliases].some(name => mentions(text, name)));

export function isGenericPreferenceQuery(text: string): boolean {
  return /\b(?:preferences?|interests?)\b|(?:sở thích|điều (?:mình|tớ|tôi) (?:cho phép|đã kể))/iu.test(text)
    && /\?|\b(?:what|which|remember|recall)\b|(?:gì|nhớ|nào)/iu.test(text);
}

const copularPetIdentity = (query: string): boolean => /\b(?:which(?: one| of (?:them|these))?|who) (?:is|was) (?:my|our) (?:real )?(?:dog|cat|pet|rabbit|puppy|kitten)(?:[, ]+(?:again|here|now))?[.!?？]*$/iu.test(query)
  || /\bwhich (?:dog|cat|pet|rabbit|puppy|kitten) (?:is|was) (?:mine|ours)[.!?？]*$/iu.test(query)
  || /(?:(?:con|bé|thú cưng) nào là (?:con )?(?:chó|mèo|thỏ|thú cưng) (?:của |nhà )?(?:mình|tớ|tôi|con)|(?:con )?(?:chó|mèo|thỏ|thú cưng) (?:của |nhà )?(?:mình|tớ|tôi|con) là con nào|(?:con )?(?:chó|mèo|thỏ|thú cưng) nào là của (?:mình|tớ|tôi|con))(?: (?:nhỉ|vậy))?[.!?？]*$/iu.test(query);

function ambiguousCopularPetQuery(query: string): boolean {
  // This narrow shortcut resolves one real species slot. Fictional frames and
  // compound species requests need ordinary scoped dialogue, not first-match
  // selection from the child's real pets.
  const fiction = /\b(?:pretend|imaginary|fictional|make-believe)\b|\b(?:in|for) (?:my|our|this|the|a) (?:story|scene|game)\b|(?:trong (?:truyện|câu chuyện|trò chơi|cảnh)|tưởng tượng|giả sử)/iu.test(query);
  const speciesCount = [/\b(?:dog|puppy)\b|chó/iu, /\b(?:cat|kitten)\b|mèo/iu, /\brabbit\b|thỏ/iu].filter(pattern => pattern.test(query)).length;
  return fiction || speciesCount > 1;
}

/** Identity questions can include a return greeting or temporal tail. Event
 * outcome questions stay on the dated-event grounding path. */
export function isPetIdentityQuery(text: string): boolean {
  const query = normalized(text).trim();
  if (/\btoy rabbit\b|thỏ bông/iu.test(query) || !/\b(?:dog|cat|pet|rabbit|puppy|kitten)\b|(?:chó|mèo|thú cưng|thỏ)/iu.test(query)) return false;
  // These clauses request a species-scoped identity, not an event involving
  // whichever animal matches a verb. Keep the copular forms bounded so that
  // "which dog fell in a puddle?" stays on the dated-event path.
  if (copularPetIdentity(query)) return !ambiguousCopularPetQuery(query);
  const explicitName = /\bname\b|(?<![\p{L}\p{M}])tên(?!\s+lửa)(?![\p{L}\p{M}])/iu.test(query)
    || /\bwhat\b.{0,80}\b(?:called|named)(?:\s+(?:now|again|today|before))?[.!?。！？\s]*$/iu.test(query);
  // A relative "who" or "called" inside a story assertion is not a request
  // for a real pet's identity. Questions may follow a return greeting.
  const asks = /[?？]|(?:^|[.!。]\s*)(?:what|who|which|do you|can you|could you|would you|remember|recall|remind me)\b|(?:nhớ|biết).{0,20}(?:chó|mèo|thú cưng|thỏ)|(?:chó|mèo|thú cưng|thỏ).{0,20}tên (?:là )?(?:gì|nào)/iu.test(query);
  if (explicitName && asks) return true;
  // Bare identity recall must end at the entity or a bounded identity tail.
  // An arbitrary following activity belongs to episodic retrieval regardless
  // of whether its verb happens to appear in an event-keyword dictionary.
  const directRecall = /\b(?:remember|recall|know) (?:my|our|the) (?:dog|cat|pet|rabbit|puppy|kitten)(?:\s+(?:again|still|now|today|from before|from last time|(?:that )?(?:i|we) (?:told you about|mentioned)))?[.!?。！？\s]*$/iu.test(query)
    || /(?:nhớ|biết)\s+(?:(?:con|bé)\s+)?(?:chó|mèo|thú cưng|thỏ)(?:\s+(?:nhà|của)\s+(?:mình|tớ|tôi|con))?(?:\s+(?:hôm trước|lần trước))?(?:\s+(?:không|chưa|nhỉ|ạ))?[.!?。！？\s]*$/iu.test(query);
  return asks && directRecall;
}

const requestsForgottenIdentity = (text: string): boolean => /\b(?:asked|told|wanted) you (?:to )?forget\b|\b(?:forgotten|deleted) (?:pet|dog|cat|name)\b|(?:bảo|nhờ|yêu cầu).{0,12}quên/iu.test(text);

export function petIdentityMatches(context: MemoryContext, text: string): Entity[] {
  // A request to recover a deliberately forgotten identity cannot select a
  // different surviving pet or use an old name from transient dialogue.
  if (requestsForgottenIdentity(text)) return [];
  const query = normalized(text).trim();
  if (copularPetIdentity(query) && ambiguousCopularPetQuery(query)) return [];
  const species = /\b(?:dog|puppy)\b|chó/iu.test(text) ? 'dog'
    : /\b(?:cat|kitten)\b|mèo/iu.test(text) ? 'cat'
      : /\brabbit\b|thỏ/iu.test(text) ? 'rabbit' : null;
  return context.entities.filter(entity => entity.kind === 'pet' && (!species || entity.species === species));
}

export function isStoryTitleQuery(text: string): boolean {
  const query = normalized(text);
  if (/\bstory character\b|nhân vật/iu.test(query)) return false;
  return /\b(?:story|adventure)\b|truyện|câu chuyện|chuyện (?:mình|của|đang)/iu.test(query)
    && /\b(?:name|title|called|named)\b|tên|gọi là/iu.test(query)
    && /\?|\b(?:what|which|tell|remember|want|give|only|just)\b|(?:tên (?:là )?gì|gọi là gì|nhớ|muốn|cho.*biết)/iu.test(query);
}

export function storyMetadata(context: MemoryContext): { title: { en: string; vi: string }; chapter: number | null; status: string; scope: 'fictional' } | null {
  if (context.storyProgress) return { title: context.storyProgress.title, chapter: context.storyProgress.chapter, status: context.storyProgress.status, scope: 'fictional' };
  if (!context.config.assignedStoryId) return null;
  try {
    const story = getStory(context.config.assignedStoryId);
    return { title: story.title, chapter: null, status: 'assigned_not_started', scope: 'fictional' };
  } catch { return null; }
}

/** Resolve discourse references only against eligible stored entities. Prior
 * assistant words do not introduce an entity or become authoritative facts. */
export function relevantEntities(context: MemoryContext, text: string, history: SessionExchange[] = []): Entity[] {
  const current = namedEntities(context, text);
  if (current.length) return current.slice(0, 2);
  if (/\bstory character\b|nhân vật (?:trong )?(?:truyện|câu chuyện)/iu.test(text)) {
    const characters = context.entities.filter(entity => entity.kind === 'story_character');
    if (characters.length === 1) return characters;
  }
  if (/\b(?:toy rabbit|plush|stuffed toy|my toy)\b|thỏ bông|gấu bông|đồ chơi (?:của )?(?:mình|tớ|tôi)/iu.test(text)) {
    const objects = context.entities.filter(entity => entity.kind === 'object');
    if (objects.length === 1) return objects;
  }
  if (!/(?:\b(?:his|her|their|its|that|the) name\b|\b(?:name|accents?|diacritics?|spelling)\b|tên (?:bạn ấy|người bạn|nó)|đừng bỏ dấu|giữ.*dấu|bạn ấy)/iu.test(text)) return [];
  for (const exchange of history.slice(-4).reverse()) {
    const previous = namedEntities(context, exchange.user);
    if (previous.length === 1) return previous;
    if (previous.length > 1) return [];
  }
  return [];
}

export interface MemoryQueryResolution {
  targetKind: 'pet' | 'object' | 'story_character' | 'child_story' | 'routine' | 'preferred_address' | 'preference';
  slot: 'name' | 'kind' | 'fictional_scope' | 'title' | 'routine' | 'exact_time' | 'address' | 'value';
  status: 'resolved' | 'missing' | 'ambiguous';
  sourceIds: string[];
  facts: string[];
}

/** Resolve the requested domain/slot before a similarly worded catalog-title or
 * generic preference lookup. Sources remain literal; speech may translate
 * ordinary vocabulary while preserving names and quoted story titles. */
export function resolveMemoryQuery(context: MemoryContext, text: string, history: SessionExchange[] = []): MemoryQueryResolution | null {
  const petIdentityQuery = isPetIdentityQuery(text);
  const asks = petIdentityQuery || isStoryTitleQuery(text) || /[?？]|\b(?:what|which|who|remember|recall|remind|know|repeat|preserve|spell)\b|(?:nhớ|là gì|tên gì|gọi.*gì|đừng bỏ dấu|giữ.*dấu)/iu.test(text);
  if (!asks) return null;
  const resolution = (targetKind: MemoryQueryResolution['targetKind'], slot: MemoryQueryResolution['slot'], records: { id: string; fact: string }[]): MemoryQueryResolution => ({
    targetKind, slot, status: records.length === 1 ? 'resolved' : records.length ? 'ambiguous' : 'missing', sourceIds: records.map(record => record.id).filter(Boolean), facts: records.map(record => record.fact),
  });
  // A forgotten pet's "name ... asked ... forget" is not a request for the
  // child's preferred address and cannot substitute another surviving pet.
  if (petIdentityQuery && requestsForgottenIdentity(text)) return resolution('pet', 'name', []);
  if (/\b(?:what.*(?:call me|want.*called)|(?:name|address).*(?:asked|wanted|preferred)|how.*address me)\b|(?:muốn được gọi|được gọi tên gì|gọi (?:mình|tớ|tôi).*(?:gì|đã nói))/iu.test(text)) {
    const address = context.addressPreference;
    return resolution('preferred_address', 'address', [{ id: '', fact: address
      ? `The child chose the form of address ${JSON.stringify(address.preferredAddress)}; nickname permission is ${address.allowNickname ? 'granted only for the explicitly stored nickname' : 'withdrawn'}. Do not restore a nickname merely because a story resumes.`
      : `The canonical profile name is ${JSON.stringify(context.profile.displayName)}. No current nickname permission is supplied; use the canonical name. Do not claim the child made a new naming request, reconstruct an ended nickname, or treat this as unknown identity.` }]);
  }
  const mentioned = namedEntities(context, text);
  const characterQuestion = /\bstory character\b|nhân vật/iu.test(text) || mentioned.some(entity => entity.kind === 'story_character');
  if (characterQuestion) {
    const characters = mentioned.filter(entity => entity.kind === 'story_character');
    const chosen = characters.length ? characters : context.entities.filter(entity => entity.kind === 'story_character');
    const scope = /\b(?:real|really|above|house|dog|person|visit)\b|(?:thật|trên trời|nhà|chó|người)/iu.test(text);
    return resolution('story_character', scope ? 'fictional_scope' : 'name', chosen.map(entity => ({ id: entity.id, fact: `The child introduced ${JSON.stringify(entity.name)} as a fictional story character. It belongs to pretend stories, not the real social circle or a physical animal at the child's home.${entity.represents ? ` The child-described fictional form is ${JSON.stringify(entity.represents)}.` : ' Its fictional form or species is unspecified; do not call it a person, animal, or object without child evidence.'}` })));
  }
  const objectQuestion = /\b(?:toy rabbit|plush|stuffed|my toy|my object)\b|(?:thỏ bông|gấu bông|đồ chơi)/iu.test(text) || mentioned.some(entity => entity.kind === 'object');
  if (objectQuestion) {
    const objects = mentioned.filter(entity => entity.kind === 'object');
    let chosen = objects.length ? objects : context.entities.filter(entity => entity.kind === 'object');
    if (!objects.length && /\b(?:rabbit|bunny)\b|thỏ/iu.test(text)) chosen = chosen.filter(entity => /\b(?:rabbit|bunny)\b|thỏ/iu.test(`${entity.objectType ?? ''} ${entity.represents ?? ''}`));
    if (!objects.length && /\b(?:bear|teddy)\b|gấu/iu.test(text)) chosen = chosen.filter(entity => /\b(?:bear|teddy)\b|gấu/iu.test(`${entity.objectType ?? ''} ${entity.represents ?? ''}`));
    return resolution('object', /\b(?:kind|real|eat|food|living)\b|(?:là gì|ăn|thật|con gì)/iu.test(text) ? 'kind' : 'name', chosen.map(entity => ({ id: entity.id, fact: `The child introduced the object ${JSON.stringify(entity.name)}${entity.objectType ? ` as ${JSON.stringify(entity.objectType)}` : ''}${entity.represents ? `, representing ${JSON.stringify(entity.represents)}` : ''}. It is a toy/object, not a real pet, and pretend care does not create biological needs.` })));
  }
  if (petIdentityQuery) {
    return resolution('pet', 'name', petIdentityMatches(context, text).map(entity => ({
      id: entity.id,
      fact: `The child reported their ${entity.species ?? 'pet'} is named ${JSON.stringify(entity.name)}. Preserve that proper name exactly, including across language changes. This identity does not establish a new event or physical observation.`,
    })));
  }
  const ownTitle = isStoryTitleQuery(text) && /\b(?:my story|story i (?:made|wrote|told)|i made|i wrote)\b|(?:truyện|câu chuyện).{0,16}(?:mình|tớ|tôi).{0,12}(?:kể|bịa|viết)|truyện của (?:mình|tớ|tôi)/iu.test(text);
  if (ownTitle) {
    const matches = context.stories.filter(story => mentions(text, story.title));
    const chosen = matches.length ? matches : context.stories;
    return resolution('child_story', 'title', chosen.map(story => ({ id: story.id, fact: `The child-authored fictional story is titled ${JSON.stringify(story.title)}. Its reported premise is ${JSON.stringify(story.summary)}; named fictional cast: ${story.castNames.map(name => JSON.stringify(name)).join(', ') || 'not supplied'}. This is not Miu's assigned catalog story.` })));
  }
  if (/\b(?:routine|after dinner|before bed|exact time.*read|time i read)\b|(?:thói quen|sau (?:bữa )?tối|trước (?:giờ )?ngủ|giờ.*đọc)/iu.test(text)) {
    let routines = context.preferences.filter(preference => preference.category === 'routine');
    if (/\b(?:read|reading|book)\b|đọc/iu.test(text)) {
      const reading = routines.filter(preference => /\b(?:read|reading|book)\b|đọc/iu.test(preference.value));
      if (reading.length) routines = reading;
    }
    if (/\bafter dinner\b|sau (?:bữa )?tối/iu.test(text)) routines = routines.filter(preference => /\bafter dinner\b|sau (?:bữa )?tối/iu.test(`${preference.value} ${preference.qualifiers?.timeRelation ?? ''}`));
    if (/\bbefore bed\b|trước (?:giờ )?ngủ/iu.test(text)) routines = routines.filter(preference => /\bbefore bed\b|trước (?:giờ )?ngủ/iu.test(`${preference.value} ${preference.qualifiers?.timeRelation ?? ''}`));
    const exact = /\b(?:exact|clock|what time|yesterday)\b|(?:chính xác|mấy giờ|hôm qua)/iu.test(text);
    return resolution('routine', exact ? 'exact_time' : 'routine', routines.map(preference => ({ id: preference.id, fact: `The volunteered routine is ${JSON.stringify(preference.value)}.${preference.qualifiers?.frequency ? ` Its reported frequency is ${preference.qualifiers.frequency}; this is not another person's guaranteed promise.` : ''}${preference.qualifiers?.timeRelation ? ` Only this relative timing was volunteered: ${JSON.stringify(preference.qualifiers.timeRelation)}.` : ''} ${preference.qualifiers?.exactTime ? `The child volunteered clock time ${JSON.stringify(preference.qualifiers.exactTime)}; it does not prove what happened yesterday.` : 'No exact clock time was volunteered; do not invent one or treat a routine as evidence of a particular day.'}` })));
  }
  if (/\b(?:favou?rite (?:colou?r)|colou?r.*favou?rite)\b|(?:màu.*(?:thích nhất|đứng đầu|yêu thích nhất)|màu (?:mình|tớ|tôi).*thích)/iu.test(text)) {
    const colors = context.preferences.filter(preference => preference.slot === 'favorite_color');
    return resolution('preference', 'value', colors.map(preference => ({ id: preference.id, fact: `The child's explicitly current favorite-color preference is ${JSON.stringify(preference.value)}. This favorite_color slot is distinct from unrelated likes or hobbies. Translate its ordinary color vocabulary naturally while preserving the source value in storage.` })));
  }
  return null;
}

/** Minimal directly asserted candidate facts. Values stay source excerpts and
 * describe child reports; this helper never grants persistence or action rights. */
export function candidateFacts(candidates: MemoryCandidate[], text: string): string[] {
  return candidates.filter(candidate => text.normalize('NFC').includes(candidate.evidence.normalize('NFC')))
    .slice(0, 3).map(candidate => candidate.evidence);
}

/** Historical correction receipts retain hashes, never recoverable old names.
 * A former name is usable only when the child supplies it again in this turn. */
export function correctionGrounding(context: MemoryContext, text: string): string[] {
  if (!/[?？]|\b(?:remember|recall|corrected|correction|did i|keep only)\b|(?:đã sửa|đã đổi|nhớ|chỉ giữ|có phải)/iu.test(text)) return [];
  const corrected = context.entities.filter(entity => !!entity.retiredNameHashes?.length);
  if (!corrected.length) return [];
  const byHash = new Map<string, Entity[]>();
  for (const entity of corrected) for (const hash of entity.retiredNameHashes!.slice(0, 16)) {
    byHash.set(hash, [...(byHash.get(hash) ?? []), entity]);
  }
  const words = [...text.matchAll(/[\p{L}][\p{L}\p{M}\p{N}'’\-]*/gu)].slice(0, 100);
  const matches = new Map<string, { entity: Entity; suppliedName: string }>();
  for (let start = 0; start < words.length; start++) {
    for (let size = 1; size <= 4 && start + size <= words.length; size++) {
      const first = words[start]!;
      const last = words[start + size - 1]!;
      const suppliedName = text.slice(first.index!, last.index! + last[0].length);
      if (suppliedName.length > 80 || /[^\p{L}\p{M}\p{N}'’\-\s]/u.test(suppliedName)) continue;
      const entities = byHash.get(retiredNameHash(context.profile.id, suppliedName));
      if (entities?.length === 1) matches.set(entities[0]!.id, { entity: entities[0]!, suppliedName });
    }
  }
  let resolved = [...matches.values()];
  if (!resolved.length && /\bcorrected (?:pet|dog|cat|name|identity)\b|(?:pet|dog|cat|name).{0,20}\bcorrected\b|(?:tên|chó|mèo|thú cưng).{0,16}đã (?:sửa|đổi)/iu.test(text)) {
    const petQuery = /\b(?:pet|dog|cat|rabbit)\b|(?:chó|mèo|thú cưng|thỏ)/iu.test(text);
    const possible = corrected.filter(entity => !petQuery || entity.kind === 'pet');
    if (possible.length === 1) resolved = [{ entity: possible[0]!, suppliedName: '' }];
  }
  if (resolved.length !== 1) return [];
  const { entity, suppliedName } = resolved[0]!;
  const peers = context.entities.filter(other => other.kind === entity.kind && (!entity.species || other.species === entity.species));
  return [
    `The app has an already committed name correction for the same ${entity.species ?? entity.kind}; its canonical name is ${entity.name}.`,
    suppliedName
      ? `The former name ${JSON.stringify(suppliedName)} supplied in the current utterance matches that same entity's recorded correction. It does not identify a second entity.`
      : 'The current request refers to the uniquely matching already corrected entity. The old name is not supplied and must not be invented.',
    ...(peers.length === 1 ? [`There is one active ${entity.species ?? entity.kind} record in this profile, with canonical name ${entity.name}.`] : []),
  ];
}

/** Explicit recall reads one eligible scoped record. No new fact is inferred. */
export function recallFromProfile(context: MemoryContext, text: string): RecallHook | null {
  const query = text.normalize('NFC').toLocaleLowerCase('vi');
  const reactiveName = /\b(?:keep|preserve|spell|repeat).*\b(?:name|accents?|diacritics?)\b|(?:tên.*(?:có dấu|đừng bỏ dấu|nói lại)|đừng bỏ dấu.*tên)/iu.test(query);
  const asks = reactiveName || isPetIdentityQuery(query) || /\?|\b(?:what|who|remember|recall|remind)\b|(?:nhớ|tên gì|là ai|sở thích)/iu.test(query);
  if (!asks) return null;
  const hook = (id: string, en: string, vi: string): RecallHook => ({ id, sourceIds: [id], evidenceKind: 'child_reported', fact: en, question: null, claim: { en, vi } });
  const typed = resolveMemoryQuery(context, text);
  if (typed?.status === 'resolved' && typed.sourceIds[0] && typed.facts[0]) return hook(typed.sourceIds[0], typed.facts[0], typed.facts[0]);
  if (isGenericPreferenceQuery(query)) {
    if (context.preferences.length !== 1) return null;
    const preference = context.preferences[0]!;
    const description = preference.category === 'fear' ? { en: 'are scared of', vi: 'sợ' }
      : preference.category === 'dislike' ? { en: 'dislike', vi: 'không thích' }
        : preference.category === 'self_description' ? { en: 'describe yourself as', vi: 'tự mô tả mình là' }
          : preference.category === 'routine' ? { en: 'have this routine:', vi: 'có thói quen' }
            : { en: 'like', vi: 'thích' };
    return hook(preference.id, `You told Miu you ${description.en} ${preference.value}.`, `Bạn đã kể với Miu bạn ${description.vi} ${preference.value}.`);
  }
  if (isPetIdentityQuery(query)) {
    const matches = petIdentityMatches(context, query);
    if (matches.length === 1) {
      const pet = matches[0]!;
      return hook(pet.id, `You told Miu your ${pet.species ?? 'pet'} is named ${pet.name}.`, `Bạn đã kể với Miu tên thú cưng của bạn là ${pet.name}.`);
    }
  }
  const relations = [
    { pattern: /\b(?:sister|brother|sibling)\b|(?:chị|anh|em) (?:của )?(?:mình|tớ|tôi)/iu, stored: 'sibling', en: 'sibling', vi: 'anh chị em' },
    { pattern: /\b(?:mother|mom|mum)\b|mẹ|má/iu, stored: 'mother', en: 'mother', vi: 'mẹ' },
    { pattern: /\b(?:father|dad)\b|bố|ba của/iu, stored: 'father', en: 'father', vi: 'bố' },
    { pattern: /\bfriend\b|bạn (?:của|thân|mình|tớ|tôi)|người bạn/iu, stored: 'friend', en: 'friend', vi: 'bạn' },
    { pattern: /\bteacher\b|thầy|cô giáo/iu, stored: 'teacher', en: 'teacher', vi: 'thầy cô' },
    { pattern: /\b(?:grandparent|grandma|grandpa)\b|ông bà|bà của|ông của/iu, stored: 'grandparent', en: 'grandparent', vi: 'ông bà' },
  ];
  for (const { pattern, stored, en, vi } of relations) {
    if (!pattern.test(query)) continue;
    const connections = context.socialCircle.filter(connection => connection.relation === stored);
    if (connections.length === 1) {
      const person = connections[0]!;
      return hook(person.id, `You told Miu ${person.name} is your ${en}.`, `Bạn đã kể với Miu ${person.name} là ${vi} của bạn.`);
    }
  }
  const categories = [
    { category: 'hobby', pattern: /\b(?:hobb(?:y|ies)|enjoy)\b|sở thích/iu, en: 'enjoy', vi: 'thích' },
    { category: 'dislike', pattern: /\b(?:dislike|hate)\b|ghét|không thích/iu, en: 'dislike', vi: 'không thích' },
    { category: 'fear', pattern: /\b(?:afraid|fear|scared)\b|sợ/iu, en: 'are scared of', vi: 'sợ' },
    { category: 'like', pattern: /\b(?:like|love|favorite)\b|thích|yêu thích/iu, en: 'like', vi: 'thích' },
    { category: 'self_description', pattern: /\b(?:describe|personality|character)\b|tính cách/iu, en: 'describe yourself as', vi: 'tự mô tả mình là' },
    { category: 'story_preference', pattern: /\b(?:stor(?:y|ies)|fairy tales)\b|truyện|câu chuyện/iu, en: 'enjoy stories about', vi: 'thích truyện về' },
  ] as const;
  for (const item of categories) {
    if (!item.pattern.test(query)) continue;
    const preference = context.preferences.find(preference => preference.category === item.category);
    if (preference) return hook(preference.id, `You told Miu you ${item.en} ${preference.value}.`, `Bạn đã kể với Miu bạn ${item.vi} ${preference.value}.`);
  }
  if (/\b(?:what|which).*(?:like|enjoy|favorite)|(?:mình|tớ|tôi).*(?:thích gì|thích (?:cái|điều) gì)|sở thích.*(?:gì|nhớ)/iu.test(query)) {
    const preference = [...context.preferences].reverse().find(item => ['like', 'hobby', 'story_preference'].includes(item.category));
    if (preference) return hook(preference.id, `You told Miu you like ${preference.value}.`, `Bạn đã kể với Miu bạn thích ${preference.value}.`);
  }
  return null;
}

/** Resolve one explicitly mentioned subject without dumping the child's profile.
 * Dated reports remain reports, and absence from this bounded set proves no
 * real-world outcome. Used for questions and corrections rather than idle hooks. */
export function eventGrounding(context: MemoryContext, text: string): string[] {
  const named = namedEntities(context, text);
  const subject = named.length === 1 ? named[0] : null;
  if (!subject) return [];
  const identity = subject.kind === 'pet' ? `The child reported their ${subject.species ?? 'pet'} is named ${subject.name}.` : `The child named their ${subject.kind} ${subject.name}.`;
  return [identity, ...context.events.filter(event => event.subjectId === subject.id).slice(0, 3)
    .map(event => `Child report for ${event.localDate}, ${event.evidenceKind}, subject ${subject.name}: ${event.value}`)];
}

/** One bounded evidence payload is shared by reply generation and checking.
 * The memory service has already enforced profile, deletion, and real expiry. */
export function turnGrounding(input: DirectorInput, plan: DirectorPlan) {
  const entities = relevantEntities(input.context, input.text, input.history);
  const entityIds = new Set(entities.map(entity => entity.id));
  const selected = plan.memoryReferenceId && input.recall?.id === plan.memoryReferenceId ? input.recall : null;
  const currentFacts = input.turnEvidence?.facts ?? candidateFacts(input.observation.candidates, input.text);
  return {
    current_turn: {
      source: 'current_child_utterance',
      assertions: currentFacts.filter(fact => input.text.normalize('NFC').includes(fact.normalize('NFC'))).slice(0, 3),
      persistable: input.turnEvidence?.persistable ?? !input.observation.suppressLearning,
      scope: input.turnEvidence?.persistable === false || input.observation.suppressLearning ? 'current_turn_only' : 'child_report',
      uncertainty: input.observation.uncertainty ?? (input.observation.uncertain ? 'meaning' : null),
      question_is_not_an_assertion: true,
    },
    relevant_entities: entities.map(entity => ({ kind: entity.kind, canonical_name: entity.name, species: entity.species, object_type: entity.objectType ?? null, represents: entity.represents ?? null, form_is_unspecified: entity.kind === 'story_character' && !entity.represents && !entity.species, scope: entity.kind === 'story_character' ? 'fictional' : 'reported_real', evidence_kind: 'child_reported' })),
    relevant_relationships: input.context.socialCircle.filter(connection => entityIds.has(connection.entityId)).slice(0, 3)
      .map(connection => ({ name: connection.name, relation: connection.relation, evidence_kind: 'child_reported' })),
    relevant_event_reports: input.context.events.filter(event => !!event.subjectId && entityIds.has(event.subjectId)).slice(0, 3)
      .map(event => ({ subject: event.subjectName, local_date: event.localDate, evidence_kind: event.evidenceKind, report: event.value })),
    eligible_referent_reports: input.referentEvidence ?? [],
    selected_memory: selected ? { fact: selected.fact, claim: selected.claim ?? null, question: selected.question, evidence_kind: selected.evidenceKind } : null,
    historical_correction_facts: correctionGrounding(input.context, input.text),
    story: plan.action ? plan.action.domain === 'catalog_story' ? storyMetadata(input.context) : null : isStoryTitleQuery(input.text) || plan.purpose === 'story' ? storyMetadata(input.context) : null,
    requested_memory: resolveMemoryQuery(input.context, input.text, input.history),
    address_preference: input.context.addressPreference ? { preferredAddress: input.context.addressPreference.preferredAddress, allowNickname: input.context.addressPreference.allowNickname, nickname: input.context.addressPreference.allowNickname ? input.context.addressPreference.nickname : null } : null,
    preference_recall: isGenericPreferenceQuery(input.text) ? { eligible_count: input.context.preferences.length, ambiguous: input.context.preferences.length > 1 } : null,
    pet_identity: isPetIdentityQuery(input.text) ? { eligible_count: petIdentityMatches(input.context, input.text).length } : null,
    memory_operation: input.operation ?? null,
    boundaries: plan.boundaries ?? input.boundaries ?? { noGames: false, noQuestions: false },
    assistant_history_is_not_fact_authority: true,
  };
}
