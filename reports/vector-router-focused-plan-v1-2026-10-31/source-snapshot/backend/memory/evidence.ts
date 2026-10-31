import type { MemoryCandidate } from '../shared/types.js';

export function normalized(value: string): string { return value.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/g, ' '); }
const SENSITIVE = /(?:\b(?:password|passcode|address|phone|email|school|diagnos\w*|depress\w*|anxiety|abuse|suicid\w*|kill|hurt|hit|sex\w*|secret|trauma|blood)\b|mật khẩu|địa chỉ|số điện thoại|trường học|chẩn đoán|trầm cảm|tự tử|đánh đập|bí mật|xâm hại|ignore (?:all|previous)|system prompt|https?:|@|\d{5,})/iu;
const RELATIONS: Record<string, RegExp> = {
  mother: /\b(?:mother|mom|mum)\b|(?<![\p{L}\p{M}])(?:mẹ|má)(?![\p{L}\p{M}])/iu,
  father: /\b(?:father|dad|daddy)\b|(?<![\p{L}\p{M}])(?:bố|ba)(?![\p{L}\p{M}])/iu,
  sibling: /\b(?:sister|brother|sibling)\b|(?<![\p{L}\p{M}])(?:chị|anh|em)(?![\p{L}\p{M}])/iu,
  friend: /\bfriend\b|(?<![\p{L}\p{M}])bạn(?![\p{L}\p{M}])/iu,
  teacher: /\bteacher\b|(?<![\p{L}\p{M}])(?:cô giáo|thầy)(?![\p{L}\p{M}])/iu,
  grandparent: /\b(?:grandma|grandpa|grandmother|grandfather)\b|(?<![\p{L}\p{M}])(?:ông|bà)(?![\p{L}\p{M}])/iu,
  cousin: /\bcousin\b|(?<![\p{L}\p{M}])(?:anh họ|chị họ|em họ)(?![\p{L}\p{M}])/iu,
  relative: /\b(?:aunt|uncle|cousin|relative)\b|(?<![\p{L}\p{M}])(?:dì|chú|cậu|họ hàng)(?![\p{L}\p{M}])/iu,
  other: /\b(?:person|neighbor|neighbour)\b|(?<![\p{L}\p{M}])(?:người|hàng xóm)(?![\p{L}\p{M}])/iu,
};
export function isSafeProjection(value: string): boolean {
  return value.length > 0 && value.length <= 1_500 && !SENSITIVE.test(value) && !/[\u0000-\u0008\u000e-\u001f]/u.test(value);
}
function included(evidence: string, value: string): boolean { return normalized(evidence).includes(normalized(value)); }
function validName(value: string): boolean { return value.length > 0 && value.length <= 80 && /^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]*$/u.test(value); }

/** A deliberately small, auditable capture vocabulary. Never infer traits. */
export function validateCandidate(candidate: MemoryCandidate): boolean {
  if (!isSafeProjection(candidate.evidence) || !isSafeProjection(JSON.stringify(candidate))) return false;
  if (candidate.kind === 'entity') {
    if (!validName(candidate.name) || !included(candidate.evidence, candidate.name)) return false;
    if (candidate.entityKind === 'pet') {
      if (!/\b(?:my|our)\b|của (?:mình|tớ|con|tôi)|nhà (?:mình|tớ|con)/iu.test(candidate.evidence)) return false;
      if (candidate.species === 'dog') return /\bdog\b|chó/iu.test(candidate.evidence);
      if (candidate.species === 'cat') return /\bcat\b|mèo/iu.test(candidate.evidence);
      if (candidate.species === 'rabbit') return /\brabbit\b|thỏ/iu.test(candidate.evidence);
      return candidate.species === null || included(candidate.evidence, candidate.species);
    }
    return candidate.species === null;
  }
  if (candidate.kind === 'preference') {
    if (!candidate.value || candidate.value.length > 300 || !included(candidate.evidence, candidate.value)) return false;
    const patterns = {
      hobby: /\b(?:i (?:like|love|enjoy)|my hobb(?:y|ies))\b|(?:mình|tớ|con|tôi) (?:thích|hay)|sở thích/iu,
      like: /\b(?:i (?:like|love|enjoy)|my favou?rite)\b|(?:mình|tớ|con|tôi) thích/iu,
      dislike: /\bi (?:hate|dislike|do not like|don't like)\b|(?:mình|tớ|con|tôi) (?:ghét|không thích)/iu,
      fear: /\bi(?:'m| am) (?:afraid of|scared of)\b|(?:mình|tớ|con|tôi) sợ/iu,
      self_description: /\bi(?:'m| am)\b|(?:mình|tớ|con|tôi) (?:(?:là|hơi) )?/iu,
      story_preference: /\b(?:i (?:like|love)|my favou?rite)\b.*\bstor(?:y|ies)\b|thích.*(?:truyện|câu chuyện)/iu,
      routine: /\b(?:i (?:usually|always|often)|my routine is)\b|(?:mình|tớ|con|tôi) (?:thường|hay)|thói quen của (?:mình|tớ|con|tôi) là/iu,
    };
    if (!patterns[candidate.category].test(candidate.evidence)) return false;
    // Everyday play concerns only; disclosures are handled in-session, never profiled.
    if (candidate.category === 'fear' && !/^(?:the )?(?:dark|thunder|loud noises|spiders|vacuum cleaners|scary stories|bóng tối|sấm|sấm sét|tiếng ồn|nhện|máy hút bụi|truyện ma)$/iu.test(candidate.value.trim())) return false;
    if (candidate.category === 'self_description' && !/^(?:shy|creative|curious|funny|kind|quiet|outgoing|adventurous|calm|patient|inventive|friendly|playful|thoughtful|nhút nhát|sáng tạo|tò mò|vui vẻ|vui tính|tốt bụng|ít nói|thích phiêu lưu|bình tĩnh|kiên nhẫn|thân thiện|ham chơi|chu đáo)$/iu.test(candidate.value.trim())) return false;
    return true;
  }
  if (candidate.kind === 'relationship') {
    return validName(candidate.name) && included(candidate.evidence, candidate.name) && Boolean(RELATIONS[candidate.relation]?.test(candidate.evidence));
  }
  if (candidate.kind === 'event') {
    if (candidate.value.length > 500 || !included(candidate.evidence, candidate.value)) return false;
    if (candidate.subjectName && (!validName(candidate.subjectName) || !included(candidate.evidence, candidate.subjectName))) return false;
    if (candidate.eventType === 'fell_in_puddle') return /puddle|vũng nước/iu.test(candidate.evidence) && /fell|fall|ngã|rơi|té/iu.test(candidate.evidence);
    if (candidate.eventType === 'planned_activity') return /tomorrow|ngày mai/iu.test(candidate.evidence);
    return true;
  }
  if (candidate.title.length > 100 || candidate.summary.length > 500 || !included(candidate.evidence, candidate.title) || !included(candidate.evidence, candidate.summary)) return false;
  return candidate.castNames.length <= 8 && candidate.castNames.every((name) => validName(name) && included(candidate.evidence, name));
}
