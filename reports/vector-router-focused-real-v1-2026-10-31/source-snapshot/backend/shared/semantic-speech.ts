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
export function withoutCurrentChatIntentions(text: string, allowedFacts: string[] = []): string {
  return speechClauses(text).filter(clause => {
    const value = clause.replace(/[.!?…]+$/u, '').trim();
    // This complete composite contains only a boundary acknowledgement, an
    // immediate listening intention, and optional harmless feeling reassurance.
    // Never strip just "I'll listen" from a coordinated external-action promise.
    if (/^(?:(?:no advice(?: today)?|okay|ok|all right|of course)[,\s:—–-]+)?i(?: will|['’]ll) (?:just )?listen(?: (?:here|now|quietly|for now))?(?:,?\s+and it(?:['’]s| is) (?:okay|ok|all right) to feel (?:sad|scared|upset|tired|angry|frustrated|disappointed))?$/iu.test(value)) return false;
    if (/^i(?: will|['’]ll) (?:just )?listen(?: (?:here|now|quietly|for now))?(?: (?:while|as) you(?:(?:['’]re| are) feeling (?:sad|scared|upset|tired)| talk| share| take your time))?$/iu.test(value)) return false;
    if (/^i(?: will|['’]ll) stay here and listen(?: (?:quietly|for now|during (?:this|our) chat))?$/iu.test(value)) return false;
    if (/^i(?: will|['’]ll) (?:keep|use) (?:my|these|the) (?:words|voice|reply|answer|tone) (?:gentle|calm|quiet|short|few)(?: and (?:gentle|calm|quiet|short|few))*$/iu.test(value)) return false;
    if (/^i(?: will|['’]ll) (?:answer|reply|speak) (?:briefly|gently|quietly|in (?:English|Vietnamese))$/iu.test(value)) return false;
    const naming = /\bI(?: will|['’]ll| can) (?:call|address) (?:you|her|him|them) (?:by (?:the )?name )?([\p{Lu}][\p{L}\p{M}'’ -]{0,60}?)(?:,? (?:with no|without a|with no new) nickname)?$/u.exec(value)
      ?? /(?:Miu|mình) sẽ (?:gọi|xưng hô với) bạn (?:là|bằng tên) ([\p{Lu}][\p{L}\p{M}'’ -]{0,60}?)(?:,? (?:không|chẳng) (?:dùng|gọi bằng) (?:biệt danh|tên khác)(?: nữa)?)?(?: nhé| nha)?$/u.exec(value);
    if (naming) {
      const name = naming[1]!.trim();
      const groundedName = (candidate: string): boolean => {
        if (!/^[\p{Lu}][\p{L}\p{M}'’ -]{0,60}$/u.test(candidate)) return false;
        const escaped = candidate.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
        const grounded = new RegExp('(?<![\\p{L}\\p{M}])' + escaped + '(?![\\p{L}\\p{M}])', 'u');
        return allowedFacts.some(fact => grounded.test(fact));
      };
      const prefix = value.slice(0, naming.index).trim();
      // Only a short acknowledgement and the same grounded name may precede
      // the naming intention. Other promises/actions cannot hide in a prefix.
      const acknowledgement = /^(?:okay|ok|all right|of course|yes|got it|được rồi|được|ừ|vâng|dạ)(?=[,\s!:—]|$)/iu.exec(prefix);
      const addressed = acknowledgement
        ? prefix.slice(acknowledgement[0].length).replace(/^[,\s!:—]+|[,\s!:—]+$/gu, '')
        : null;
      const safePrefix = prefix.length === 0 || acknowledgement !== null && (addressed === '' || addressed === name && groundedName(addressed));
      if (groundedName(name) && safePrefix) return false;
    }
    return true;
  }).join(' ');
}
