import type { AssertionEvidence, MemoryCandidate } from '../shared/types.js';
import { isSafeProjection } from './evidence.js';

/** A literal substring alone cannot establish that a child asserted a fact.
 * These conservative guards inspect its surrounding clause, including prefixes
 * deliberately omitted by an extractor. Unsupported forms stay out of memory. */
export function assertionEvidence(text: string, candidate: MemoryCandidate): AssertionEvidence | null {
  const source = text.normalize('NFC');
  const excerpt = candidate.evidence.normalize('NFC');
  if (!excerpt.trim()) return null;
  let start = source.indexOf(excerpt);
  while (start >= 0) {
    const left = Math.max(...['.', '!', '?', ';', '\n'].map(mark => source.lastIndexOf(mark, start - 1))) + 1;
    const remaining = source.slice(start + excerpt.length);
    const boundary = /[.!?;\n]/u.exec(remaining);
    const end = /[.!?;\n]$/u.test(excerpt) ? start + excerpt.length
      : boundary ? start + excerpt.length + boundary.index + 1 : source.length;
    const clause = source.slice(left, end).trim();
    const question = /[?？]/u.test(clause) || /^(?:did|do|does|is|are|was|were|has|have|had|can|could|would|will|what|who|when|where|why|how)\b|^(?:liệu|có phải)\b/iu.test(clause);
    const hypothetical = /\b(?:if|maybe|perhaps|suppose|imagine|might|would|could|i wonder)\b|(?:có lẽ|giả sử|nếu|ước gì|không chắc)/iu.test(clause);
    const deniedReport = /\b(?:never|not|didn['’]?t|haven['’]?t|don['’]?t)\s+(?:ever\s+)?(?:say|said|tell|told|report|mean)\b|(?:chưa|không|chẳng)(?: hề)? (?:nói|kể|bảo)/iu.test(clause);
    const negative = /\b(?:not|never|didn['’]?t|wasn['’]?t|isn['’]?t|hasn['’]?t|haven['’]?t|don['’]?t|doesn['’]?t)\b|(?:không|chưa|chẳng)/iu.test(clause);
    const explicitDislike = candidate.kind === 'preference' && candidate.category === 'dislike';
    const fiction = candidate.kind === 'event' && /\b(?:pretend|imaginary|story|dream)\b|(?:trong truyện|tưởng tượng|giả vờ|giấc mơ)/iu.test(clause);
    const quoted = candidate.kind === 'event' && (/["“”]/u.test(clause) || /\b(?:asked|asking|whether|question|quote|quoted)\b|(?:câu hỏi|đã hỏi)/iu.test(clause));
    const untypedPlan = candidate.kind === 'event' && candidate.eventType !== 'planned_activity' && /\b(?:tomorrow|will|going to)\b|(?:ngày mai|sẽ)/iu.test(clause);
    if (isSafeProjection(clause) && !question && !hypothetical && !deniedReport && (!negative || explicitDislike) && !fiction && !quoted && !untypedPlan) {
      return { clause, start, end: start + excerpt.length, speechAct: 'assertion', polarity: 'affirmed' };
    }
    start = source.indexOf(excerpt, start + 1);
  }
  return null;
}
