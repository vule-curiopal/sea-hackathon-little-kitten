import type { Language } from '../shared/types.js';

type KnownSocialName = { name: string; aliases: readonly string[] };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const key = (value: string) => value.normalize('NFC').toLocaleLowerCase('vi').trim().replace(/\s+/gu, ' ');

/** Resolve only a complete social formula. Names are language-neutral and
 * quoted/reported/mixed sentences remain the ordinary classifier's decision. */
export function socialFormulaLanguage(text: string, entities: readonly KnownSocialName[] = []): Language | null {
  const value = key(text);
  if (!value || value.length > 240
    || /["“”„‟`]|(?<![\p{L}\p{M}])['‘’]|['‘’](?![\p{L}\p{M}])/u.test(value)) return null;
  const names = [...new Set(entities.slice(0, 40).flatMap(entity => [entity.name, ...entity.aliases.slice(0, 8)])
    .map(key).filter(name => name.length <= 80 && /^[\p{L}\p{M}][\p{L}\p{M} '’\-]*$/u.test(name)))];
  if (names.includes(value.replace(/[.!?。！？]+$/u, '').trim())) return null;

  const matches = (formula: string, vocatives: string[], polite = '') => {
    const vocative = vocatives.map(escape).sort((a, b) => b.length - a.length).join('|');
    const ending = `${polite}[.!?。！？]*`;
    // A leading vocative requires punctuation so reported prose is not parsed
    // as an address. After the formula, one known vocative may be spaced/comma-separated.
    return new RegExp(`^(?:${formula})(?:[\\s,:!—–-]+(?:${vocative}))?${ending}$`, 'u').test(value)
      || new RegExp(`^(?:${vocative})\\s*[,!:—–-]+\\s*(?:${formula})${ending}$`, 'u').test(value);
  };
  const english = matches('bye(?:[ -]?bye)?|goodbye|good ?night|see you(?: later| soon)?|hello|hi', ['miu', 'ai kitten', 'my friend', ...names]);
  const vietnamese = matches('tạm biệt|xin chào|chào', ['miu', 'miu ơi', ...names], '(?: (?:nhé|nha|ạ))?');
  return english === vietnamese ? null : english ? 'en' : 'vi';
}
