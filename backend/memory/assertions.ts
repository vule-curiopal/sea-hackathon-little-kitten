import type { AssertionEvidence, MemoryCandidate } from '../shared/types.js';
import { isSafeProjection, validateCandidate } from './evidence.js';

const NEGATIVE = /\b(?:not|never|didn['’]?t|wasn['’]?t|isn['’]?t|hasn['’]?t|haven['’]?t|don['’]?t|doesn['’]?t)\b|(?:không|chưa|chẳng)/iu;
const HYPOTHETICAL = /\b(?:if|maybe|perhaps|suppose|imagine|might|would|could|i wonder)\b|(?:có lẽ|giả sử|nếu|ước gì|không chắc)/iu;
const PLAN = /\b(?:i|we) (?:plan|intend|am going|are going|will|want)\b|(?:mình|tớ|con|tôi|bọn mình|chúng mình) (?:dự định|định|sẽ|muốn)/iu;

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
    const explicitPlan = PLAN.test(clause) && /\btomorrow\b|ngày mai/iu.test(clause)
      && !/\b(?:maybe|perhaps|suppose|imagine|might|would|could|i wonder)\b|(?:có lẽ|giả sử|ước gì|không chắc)/iu.test(clause);
    const hypothetical = HYPOTHETICAL.test(clause);
    const deniedReport = /\b(?:never|not|didn['’]?t|haven['’]?t|don['’]?t)\s+(?:ever\s+)?(?:say|said|tell|told|report|mean)\b|(?:chưa|không|chẳng)(?: hề)? (?:nói|kể|bảo)/iu.test(clause);
    const explicitDislike = candidate.kind === 'preference' && candidate.category === 'dislike';
    const fiction = candidate.kind === 'event' && /\b(?:pretend|imaginary|story|dream)\b|(?:trong truyện|tưởng tượng|giả vờ|giấc mơ)/iu.test(clause);
    const quoted = /\b(?:asked|asking|whether|question|quote|quoted|read aloud)\b|(?:câu hỏi|đã hỏi|trích dẫn|đọc câu)/iu.test(clause)
      || candidate.kind === 'event' && /["“”]/u.test(clause);
    const untypedPlan = candidate.kind === 'event' && candidate.eventType !== 'planned_activity' && /\b(?:tomorrow|will|going to)\b|(?:ngày mai|sẽ)/iu.test(clause);
    if (isSafeProjection(clause) && !question && !deniedReport && !fiction && !quoted && !untypedPlan) {
      const typedConditionalPlan = candidate.kind === 'event' && candidate.eventType === 'planned_activity' && explicitPlan;
      const mainPlan = clause.split(/\bif\b|(?<![\p{L}\p{M}])nếu(?=\s)/iu)[0]!.trim();
      const affirmedConditionalPlan = typedConditionalPlan && mainPlan.length > 0 && !NEGATIVE.test(mainPlan);
      // The plan can be conditional without turning its outcome into a fact.
      // A directly stated ownership/relation noun phrase inside that plan is
      // also evidence of the named participant, not of a completed outing.
      const planParticipant = explicitPlan && ['entity', 'relationship'].includes(candidate.kind)
        && !HYPOTHETICAL.test(excerpt) && !NEGATIVE.test(excerpt) && validateCandidate(candidate);
      if ((!hypothetical || affirmedConditionalPlan || planParticipant) && (!NEGATIVE.test(clause) || explicitDislike || affirmedConditionalPlan || planParticipant)) {
        return { clause, start, end: start + excerpt.length, speechAct: typedConditionalPlan ? 'plan' : 'assertion', polarity: 'affirmed',
          ...(typedConditionalPlan && /\bif\b|nếu/iu.test(clause) ? { conditions: [clause.match(/(?:\bif\b|nếu)[^.!?;\n]*/iu)![0].trim()] } : {}) };
      }
      // A contrast denies the old value, not the affirmative proposition before
      // it. Revalidate against the positive span so an extractor cannot smuggle
      // the denied role/color through an excerpt containing both alternatives.
      if (!hypothetical) {
        const positive = clause.split(/\s*[,;]\s*(?:not\b|(?:chứ )?không phải\b)|\s+but not\s+/iu)[0]!.trim();
        if (positive !== clause && positive && !NEGATIVE.test(positive) && validateCandidate({ ...candidate, evidence: positive } as MemoryCandidate)) {
          const offset = source.indexOf(positive, Math.max(0, left));
          return { clause: positive, start: offset, end: offset + positive.length, speechAct: 'correction', polarity: 'affirmed' };
        }
      }
    }
    start = source.indexOf(excerpt, start + 1);
  }
  return null;
}
