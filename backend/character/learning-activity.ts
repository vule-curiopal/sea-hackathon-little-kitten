import type { Language, MemoryContext } from '../shared/types.js';

export interface LearningActivityRequest {
  kind: 'word_practice';
  term: string;
  focus: 'reading';
  language: Language;
}

const term = String.raw`[\p{L}](?:[\p{L}\p{M}]|['’\-](?=[\p{L}\p{M}])){0,63}`;
const end = String.raw`(?=[”"’']?(?:\s+(?:please|with me|nhé|nha))?(?:[.!?。,;]|$))`;
const start = String.raw`(?:^|[.!?]\s+)(?:please\s+)?`;
const practicePatterns = [
  new RegExp(String.raw`${start}(?:I (?:cannot|can['’]t) read|help me (?:read|sound out)|I (?:am |want to )?practi[sc](?:e|ing) (?:reading|sounding out)|let['’]s practi[sc]e reading)\s+(?:(?:the|this) word\s+)?[“"‘']?(${term})${end}`, 'iu'),
  new RegExp(String.raw`${start}(?:read|sound out) (?:the|this) word\s+[“"‘']?(${term})${end}`, 'iu'),
  new RegExp(String.raw`${start}(?:mình|tớ|con|em|tôi) (?:chưa|không) (?:đọc được|biết đọc)\s+(?:từ\s+)?[“"‘']?(${term})${end}`, 'iu'),
  new RegExp(String.raw`${start}(?:giúp (?:mình|tớ|con|em|tôi) (?:đọc|đánh vần)|(?:mình|tớ|con|em|tôi) (?:muốn )?(?:tập|luyện) đọc)\s+(?:từ\s+)?[“"‘']?(${term})${end}`, 'iu'),
];
const nonspecific = /^(?:it|this|that|these|those|anything|something|everything|today|yet|well|now|books?|stories|english|vietnamese|words?|the|a|an|my|your|chữ|sách|truyện|từ|này|đó|gì|hôm|tiếng)$/iu;

/** Extract only a current, child-led word-reading topic. The source inability,
 * emotion, and full sentence are deliberately not part of the saved request.
 * Persistence and eligibility remain the application's responsibility. */
export function extractLearningActivity(text: string, language: Language): LearningActivityRequest | null {
  // Quoted stories, hypothetical requests, past activities, and third-person
  // reports cannot introduce a current practice checkpoint.
  if (/\b(?:if|pretend|in my story|yesterday|last week|used to)\b|(?:nếu|giả sử|trong truyện|hôm qua|tuần trước)/iu.test(text)) return null;
  if (/\b(?:do not|don['’]t) (?:want to )?(?:read|practi[sc]e)|(?:không muốn|đừng) (?:tập |luyện )?(?:đọc|đánh vần)/iu.test(text)) return null;
  for (const pattern of practicePatterns) {
    const match = pattern.exec(text);
    if (!match?.[1] || nonspecific.test(match[1])) continue;
    // Preserve the literal source span; normalization is only for comparisons.
    return { kind: 'word_practice', term: match[1], focus: 'reading', language };
  }
  return null;
}

/** The memory boundary supplies already eligible checkpoints. Select one only
 * when the current words name its topic and do not explicitly change sense. */
export function selectLearningActivity(context: Pick<MemoryContext, 'learningActivities'>, text: string) {
  const explicitOtherFocus = /\b(?:in|about|for) (?:swimming|a game|the game|music|cooking|a recipe|sports?)\b|(?:trong|về|khi) (?:môn bơi|bơi lội|trò chơi|âm nhạc|nấu ăn|thể thao)/iu.test(text);
  if (explicitOtherFocus) return null;
  const query = text.normalize('NFC').toLocaleLowerCase('vi');
  return [...(context.learningActivities ?? [])].reverse().find(activity => {
    if (activity.kind !== 'word_practice' || activity.focus !== 'reading') return false;
    const escaped = activity.term.normalize('NFC').toLocaleLowerCase('vi').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return !!escaped && new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'u').test(query);
  }) ?? null;
}
