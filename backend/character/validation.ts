import type { DirectorPlan, ValidationResult } from '../shared/types.js';

function normalize(value: string): string { return value.normalize('NFC').replace(/\s+/gu, ' ').trim(); }

export function splitSentences(text: string, language: string): string[] {
  return [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text)]
    .map(part => part.segment.trim()).filter(Boolean);
}

/** Structural and known policy gates. Free-form semantics also require the provider's contextual verdict. */
export function validateLocal(text: string, plan: DirectorPlan): ValidationResult {
  const cleaned = normalize(text);
  const sentences = splitSentences(cleaned, plan.language);
  const violations = new Set<string>();
  if (!cleaned) violations.add('empty_reply');
  if (cleaned.length > 650) violations.add('reply_too_long');
  if (sentences.length > plan.maxSentences) violations.add('sentence_limit');
  const sentenceLimit = plan.ageBand === '4-5' ? 190 : 250;
  for (const sentence of sentences) if (sentence.length > sentenceLimit) violations.add('sentence_too_long');
  const markedQuestions = (cleaned.match(/[?？]/gu) ?? []).length;
  const unmarkedQuestions = sentences.filter(sentence => !/[?？]/u.test(sentence)
    && /^(?:what|why|who|when|where|how|would you|could you|can you|do you|did you|are you|shall we|bạn (?:có|muốn)|ai |vì sao|tại sao|khi nào|ở đâu)/iu.test(sentence)).length;
  const stackedQuestion = /\b(?:and|also)\s+(?:what|why|who|when|where|how|do you|did you|can you)\b|(?:và|rồi)\s+(?:bạn có|bạn muốn|tại sao|ai|khi nào)/iu.test(cleaned);
  if (markedQuestions + unmarkedQuestions > plan.maxQuestions || stackedQuestion) violations.add('question_limit');
  if (/```|<\/?[a-z][^>]*>|\[[^\]]+\]|\*[^*]+\*|^\s*[{#]|(?:^|\n)\s*[-*]\s/u.test(text)) violations.add('stage_direction_or_markup');
  if (/\b(?:kill yourself|hurt yourself|make a bomb|build a bomb|suicide instructions|touch (?:your|my) private parts|send (?:me )?(?:a )?nude)\b|(?:tự tử đi|tự làm đau|chế tạo bom|gửi ảnh khỏa thân)/iu.test(cleaned)) violations.add('unsafe_content');
  if (/\b(?:keep (?:this|it|that) (?:a |our )?secret|don['’]t tell (?:your |a )?(?:parents?|mom|dad|grown.?ups?)|our little secret|tell me your (?:address|password|phone number|school))\b|(?:giữ bí mật với|đừng nói với (?:bố|mẹ|người lớn)|cho miu (?:địa chỉ|mật khẩu|số điện thoại))/iu.test(cleaned)) violations.add('secrecy_or_private_data');
  if (/\b(?:your only friend|my only friend|you (?:must|have to) (?:visit|stay|talk)|you made me sad|i (?:was|am) lonely without you|i missed you so much|you belong to me)\b|(?:bạn chỉ cần miu|miu buồn vì bạn|bạn phải (?:ở lại|quay lại)|bạn thuộc về miu)/iu.test(cleaned)) violations.add('relationship_pressure');
  if (/\b(?:(?:i am|i['’]m) (?:a )?(?:real (?:person|cat)|human)|i can see you|i saw you|i watched you|i know where you live|i (?:called|contacted) your)\b|(?:miu là (?:người thật|mèo thật)|miu (?:đang theo dõi|nhìn thấy bạn|biết bạn ở đâu|đã gọi cho))/iu.test(cleaned)) violations.add('identity_or_observation_claim');
  // An immediate listening response inside this comfort turn is supported.
  // The full remaining clause must match; appended calls, scheduling, secrecy,
  // or future-contact promises retain the ordinary commitment prohibition.
  const commitmentText = plan.comfortActive ? cleaned.replace(/\bi(?: will|['’]ll) (?:just )?listen(?: (?:here|now|quietly|for now))?(?: (?:while|as) you(?:(?:['’]re| are) feeling (?:sad|scared|upset|tired)| talk| share| take your time))?(?=\s*[.!…]?\s*$)/giu, '') : cleaned;
  if (/\b(?:i promise|i will|i['’]ll|i can (?:call|visit|watch|remind|contact)|i have (?:called|contacted))\b|(?:miu hứa|miu sẽ (?:gọi|nhắc|đến|theo dõi|giữ bí mật))/iu.test(commitmentText)) violations.add('unsupported_commitment');
  if (/\b(?:you have (?:depression|anxiety|adhd|autism)|you are (?:depressed|traumatized)|your personality is)\b|(?:bạn bị (?:trầm cảm|rối loạn|tự kỷ)|tính cách của bạn là)/iu.test(cleaned)) violations.add('unsupported_child_assessment');
  if (plan.comfortActive) {
    if (/\b(?:ha(?:ha)+|hehe|lol|giggl(?:e|es|ing)|laugh(?:s|ed|ing)?|purr(?:s|ing)?)\b|(?:hihi|hí hí|ha ha|cười|vui quá|meo meo vui)/iu.test(cleaned)) violations.add('laughter_during_comfort');
    if (plan.allowGiggle || plan.allowPurr || plan.delivery !== 'gentle' || plan.emotion !== 'gentle' || ['small_bounce', 'yawn'].includes(plan.face.gesture)) violations.add('invalid_comfort_presentation');
  }
  if (plan.boundaries?.noGames) {
    const offersGame = sentences.some(sentence => {
      const offers = /(?:\b(?:would|do|could) you like (?:to )?(?:play|try a game)|\b(?:shall we|let['’]s|we can) (?:play|try a game)|\bor play\b|\bhow about (?:a game|playing)|bạn (?:có )?muốn (?:chơi|thử trò)|mình (?:cùng|có thể) (?:chơi|thử trò)|hay chơi)/iu.exec(sentence);
      if (!offers) return false;
      const prefix = sentence.slice(Math.max(0, offers.index - 35), offers.index);
      return !/(?:\b(?:not|never|don't|do not|won't|will not)\b|không|đừng).{0,24}$/iu.test(prefix);
    });
    if (offersGame) violations.add('declined_game_offered');
  }
  if (plan.ruleTrace.includes('D10:current_turn_only') && /\b(?:i|miu) (?:have |has )?(?:saved|stored|learned|will remember)|miu (?:đã (?:lưu|nhớ)|sẽ (?:lưu|nhớ))/iu.test(cleaned)) violations.add('false_persistence_acknowledgment');
  if (plan.allowedQuestion && plan.purpose === 'follow_up' && normalize(plan.allowedQuestion) !== cleaned) violations.add('unauthorized_followup');
  if (plan.exactText && normalize(plan.exactText) !== cleaned) violations.add('approved_text_mismatch');
  // These templates are authorized only after a committed operation.
  if (plan.purpose !== 'acknowledge_forget' && /\bmiu has forgotten|\bi (?:have )?forgot(?:ten)? that\b|miu đã quên/iu.test(cleaned)) violations.add('false_deletion_acknowledgment');
  return { approved: violations.size === 0, violations: [...violations], sentences };
}
