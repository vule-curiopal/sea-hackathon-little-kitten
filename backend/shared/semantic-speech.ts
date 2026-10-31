/** Bounded lexical guards for speech structure. These are not a semantic model
 * or proof that arbitrary speech is safe; contextual checking remains required. */
export function speechClauses(text: string): string[] {
  return text.normalize('NFC').split(/(?<=[.!?。！？])\s+|[;\n]+|\s+(?:but|however|nhưng|tuy nhiên)\s+/iu)
    .map(clause => clause.trim()).filter(Boolean);
}

function negatedPrefix(prefix: string): boolean {
  const scope = prefix.split(/[,;]|\b(?:and|và)\b/iu).at(-1) ?? '';
  return /(?:\b(?:not|never|cannot|can['’]t|won['’]t|don['’]t|do not|will not|should not|shouldn['’]t)\b|không|chẳng|chưa|đừng)(?:[\s"'“”‘’:-]+[\p{L}\p{M}]+){0,9}[\s"'“”‘’:-]*$/iu.test(scope)
    && !/\bnot only\b/iu.test(scope);
}

/** A matched "don't tell your parents" is itself a harmful secrecy directive;
 * only negation OUTSIDE that match can turn it into a refusal. */
export function affirmativeSpeech(text: string, expression: RegExp): string | null {
  const flags = [...new Set(expression.flags.replace(/[gy]/gu, '') + 'g')].join('');
  for (const clause of speechClauses(text)) {
    for (const match of clause.matchAll(new RegExp(expression.source, flags))) {
      if (negatedPrefix(clause.slice(0, match.index))) continue;
      if (/^(?:i|miu)(?:['’]ll| will| can| promise to)?$/iu.test(match[0].trim())
          && /^\s+(?:not|never|không|chẳng)\b/iu.test(clause.slice(match.index! + match[0].length))) continue;
      return match[0];
    }
  }
  return null;
}

/** "Tell Mum what happened and how you feel" contains no question. */
export function countInterrogatives(text: string, language = 'en'): number {
  const sentences = [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(text)]
    .map(part => part.segment.trim()).filter(Boolean);
  return sentences.reduce((total, sentence) => {
    const marks = (sentence.match(/[?？]/gu) ?? []).length;
    const directWh = /^(?:what|which|whose|why|who|when|where|how)\b/iu.test(sentence)
      && !/^(?:what|how|where|when) (?:you|we|they|i|he|she|miu)\b/iu.test(sentence);
    const directAux = /^(?:(?:would|could|can|do|did|are|shall|will|have|has|is|was|were|should) (?:you|we|i|he|she|they|it|miu)|(?:ai|vì sao|tại sao|khi nào|ở đâu)\b|bạn có (?!thể\b).*(?:không|chưa)\b|bạn (?:muốn|thích).*(?:không|chứ|nhỉ)\b)/iu.test(sentence);
    let extra = 0;
    if (directWh) extra += [...sentence.matchAll(/\b(?:and|also)\s+(?:what|why|who|when|where|how)\b|(?:và|rồi)\s+(?:tại sao|vì sao|ai|khi nào|ở đâu)\b/giu)].length;
    if (directWh || directAux) extra += [...sentence.matchAll(/\b(?:and|also)\s+(?:(?:do|did|can|could|are|would|will|have) (?:you|we|they|he|she|it))\b|(?:và|rồi)\s+bạn có (?!thể\b)/giu)].length;
    return total + Math.max(marks, directWh || directAux ? 1 : 0) + extra;
  }, 0);
}

/** Strip only complete in-chat speech intentions. Appended external actions,
 * scheduling, secrecy, and future commitments retain the ordinary guard. */
export function withoutCurrentChatIntentions(text: string, allowedFacts: string[] = [], currentAddress?: string): string {
  return speechClauses(text).map(clause => {
    const value = clause.replace(/[.!?…]+$/u, '').trim();
    // Remove only a bounded acknowledgement for matching an otherwise complete
    // listening clause. Appended actions still prevent every full-form match.
    const listeningValue = value.replace(/^(?:no advice(?: today)?|okay|ok|all right|of course)[,\s:—–-]+(?=i(?: will|['’]ll)\b)/iu, '');
    // This complete composite contains only a boundary acknowledgement, an
    // immediate listening intention, and optional harmless feeling reassurance.
    // Never strip just "I'll listen" from a coordinated external-action promise.
    if (/^(?:(?:no advice(?: today)?|okay|ok|all right|of course)[,\s:—–-]+)?i(?: will|['’]ll) (?:just )?listen(?: (?:here|now|quietly|for now))?(?:,?\s+and it(?:['’]s| is) (?:okay|ok|all right) to feel (?:sad|scared|upset|tired|angry|frustrated|disappointed))?$/iu.test(listeningValue)) return '';
    if (/^i(?: will|['’]ll) (?:just )?listen(?: (?:here|now|quietly|for now))?(?: (?:while|as) you(?:(?:['’]re| are) feeling (?:sad|scared|upset|tired)| talk| share| take your time))?$/iu.test(listeningValue)) return '';
    if (/^i(?: will|['’]ll) stay here and listen(?: (?:quietly|for now|during (?:this|our) chat))?$/iu.test(listeningValue)) return '';
    if (/^i(?: will|['’]ll) (?:keep|use) (?:my|these|the) (?:words|voice|reply|answer|tone) (?:gentle|calm|quiet|short|few)(?: and (?:gentle|calm|quiet|short|few))*$/iu.test(value)) return '';
    if (/^i(?: will|['’]ll) (?:answer|reply|speak) (?:briefly|gently|quietly|in (?:English|Vietnamese))$/iu.test(value)) return '';
    const anaphoricNaming = /\bI(?: will|['’]ll) (?:just )?(?:use that name|call you (?:that(?: name)?|by that name))(?: (?:today|for today|(?:(?:for|in|during) )?(?:this|our) (?:session|chat|conversation)))?$/u.exec(value);
    const outsideChatPrefix = (prefix: string): boolean => {
      // A valid name cannot launder future scheduling or physical-contact
      // framing. Negated future wording is still handled proposition by
      // proposition by the same affirmative-speech scope used by other guards.
      const future = /\b(?:tomorrow|tonight|later|soon|someday|forever|always|next (?:time|day|week|month|year)|this (?:week|month|year)|(?:in|after|for) (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|many) (?:hours?|days?|weeks?|months?|years?))\b|(?<![\p{L}\p{M}])(?:ngày mai|mai|tối nay|đêm nay|lần sau|sau này|mai mốt|mãi|luôn luôn|tuần sau|tháng sau|năm sau)(?![\p{L}\p{M}])/iu;
      const physical = /\b(?:in person|face.to.face|(?:by|on|over|via) (?:the )?(?:phone|telephone|video)|at (?:your|my) (?:house|home|school)|when we meet|when i (?:see|visit))\b|(?:qua|bằng) (?:điện thoại|video)|gặp trực tiếp|tận nhà|ở nhà bạn/iu;
      return affirmativeSpeech(prefix, future) !== null || affirmativeSpeech(prefix, physical) !== null;
    };
    if (currentAddress?.trim() && anaphoricNaming) {
      const prefix = value.slice(0, anaphoricNaming.index).trim();
      if (!outsideChatPrefix(prefix)) return prefix;
    }
    const englishNaming = /\bI(?: will|['’]ll| can) (?:just )?(?:call|address) (you|her|him|them) (?:just )?(?:by (?:the )?name )?([\p{Lu}][\p{L}\p{M}'’ -]{0,60}?)(?:,? (?:with no|without a|with no new) nickname)?(?: (?:today|for today|(?:(?:for|in|during) )?(?:this|our) (?:session|chat|conversation)))?$/u.exec(value);
    const vietnameseNaming = englishNaming ? null : /(?:Miu|mình) sẽ (?:chỉ )?(?:gọi|xưng hô với) bạn (?:là|bằng tên) (?:chỉ )?([\p{Lu}][\p{L}\p{M}'’ -]{0,60}?)(?:,? (?:không|chẳng) (?:dùng|gọi bằng) (?:biệt danh|tên khác)(?: nữa)?)?(?: (?:hôm nay|trong (?:cuộc trò chuyện|buổi nói chuyện) này))?(?: nhé| nha| ạ)?$/u.exec(value);
    const naming = englishNaming ?? vietnameseNaming;
    if (naming) {
      const name = (englishNaming ? englishNaming[2] : vietnameseNaming![1])!.trim();
      const childNaming = !englishNaming || englishNaming[1] === 'you';
      const groundedName = (candidate: string): boolean => {
        if (!/^[\p{Lu}][\p{L}\p{M}'’ -]{0,60}$/u.test(candidate)) return false;
        if (childNaming && currentAddress !== undefined) return candidate === currentAddress.normalize('NFC').trim();
        const escaped = candidate.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
        const grounded = new RegExp('(?<![\\p{L}\\p{M}])' + escaped + '(?![\\p{L}\\p{M}])', 'u');
        return allowedFacts.some(fact => grounded.test(fact));
      };
      // Remove only the grounded, complete naming suffix. Arbitrary preceding
      // prose is retained for the ordinary commitment guard, so a prefix such
      // as "I'll call Mum and" can never disappear with a benign naming core.
      const prefix = value.slice(0, naming.index).trim();
      if (groundedName(name) && !outsideChatPrefix(prefix)) return prefix;
    }
    return clause;
  }).filter(Boolean).join(' ');
}
