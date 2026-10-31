import type { MemoryContext, Preference } from '../shared/types.js';
import { isSafeProjection, normalized } from './evidence.js';

type Source = { sourceText: string; evidence: string };
export type MemoryPatch = Source & (
  | { kind: 'relationship'; entityId: string; oldRelation: string; relation: string }
  | { kind: 'preference'; slot: 'favorite_color'; category: 'like'; value: string }
  | { kind: 'routine'; preferenceId: string; qualifiers: NonNullable<Preference['qualifiers']> }
  | { kind: 'address'; preferredAddress: string; allowNickname: boolean; nickname: string | null }
);

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const mentioned = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{M}])${escaped(name)}(?![\\p{L}\\p{M}])`, 'iu').test(text);
const clean = (value: string) => value.normalize('NFC').trim().replace(/[.!?。]+$/gu, '').trim();
const relationNames: Array<[RegExp, string]> = [
  [/^(?:my )?(?:cousin|anh họ|chị họ|em họ)$/iu, 'cousin'],
  [/^(?:my )?(?:sister|brother|sibling|chị gái|anh trai|em gái|em trai|chị|anh|em)$/iu, 'sibling'],
  [/^(?:my )?(?:friend|bạn|bạn thân)$/iu, 'friend'],
  [/^(?:my )?(?:mother|mom|mum|mẹ)$/iu, 'mother'],
  [/^(?:my )?(?:father|dad|bố|ba)$/iu, 'father'],
  [/^(?:my )?(?:teacher|cô giáo|thầy giáo)$/iu, 'teacher'],
];
const relation = (text: string) => relationNames.find(([pattern]) => pattern.test(clean(text)))?.[1] ?? null;

/** Literal favorite wording can annotate an ordinary learned preference without
 * granting authority to mutate storage before playback completes. */
export function favoriteColorValue(text: string): string | null {
  const favorite = /(?:my (?:new |current )?favou?rite (?:colou?r) (?:is now|is)|(?:giờ |bây giờ )?(?:màu (?:mình|tớ|tôi|con) thích nhất|màu yêu thích nhất của (?:mình|tớ|tôi|con)) (?:là|đổi thành))\s+([^,.!;?]+)(?:[,;]|[.!?]|$)/iu.exec(text.normalize('NFC'));
  if (!favorite) return null;
  const value = clean(favorite[1]!).replace(/\s+(?:not\b|(?:chứ )?không phải)\s+.+$/iu, '').trim();
  return value && value.length <= 80 && isSafeProjection(value) && !/^(?:not\b|no\b|không|chưa)/iu.test(value) ? value : null;
}

export function planConditions(text: string): string[] {
  const condition = /(?:\bif\b|(?<![\p{L}\p{M}])nếu(?=\s))[^.!?;\n]*/iu.exec(text)?.[0]?.trim();
  return condition && isSafeProjection(condition) ? [condition] : [];
}

export function objectDetails(evidence: string): { objectType?: string; represents?: string } {
  if (/\b(?:plush|stuffed|toy) rabbit\b|thỏ bông/iu.test(evidence)) return { objectType: /plush|stuffed|bông/iu.test(evidence) ? 'plush_toy' : 'toy', represents: 'rabbit' };
  if (/\b(?:teddy bear|plush bear|stuffed bear)\b|gấu bông/iu.test(evidence)) return { objectType: 'plush_toy', represents: 'bear' };
  if (/\bdoll\b|búp bê/iu.test(evidence)) return { objectType: 'doll' };
  return {};
}

/** Explicit update directives only. These are proposed mutations, resolved and
 * revalidated by the store against the current profile inside its transaction.
 * Questions, quotations, speculative renames, and reported speech cannot write. */
export function extractMemoryPatches(input: string, context: MemoryContext): MemoryPatch[] {
  const sourceText = input.normalize('NFC').trim();
  if (!sourceText || sourceText.length > 2_000 || !isSafeProjection(sourceText)
    || /^(?:did|do|does|is|are|was|were|has|have|can|could|would|will|what|who|when|where|why|how)\b|^(?:liệu|có phải)/iu.test(sourceText)
    || /[?？]|\b(?:if|maybe|suppose|imagine|might|whether|quoted|quote)\b|(?:giả sử|nếu|có lẽ|không chắc|trích dẫn)/iu.test(sourceText)
    || /["“”]|\b(?:he|she|they|someone|mum|mom|dad|teacher) (?:said|says|asked)\b|(?:mẹ|bố|bạn ấy|người khác).{0,15}(?:nói|bảo|hỏi)/iu.test(sourceText)
    || /\b(?:do not|don['’]?t) (?:remember|save)\b|đừng (?:nhớ|lưu)/iu.test(sourceText)) return [];
  const patches: MemoryPatch[] = [];
  const base = { sourceText, evidence: sourceText };

  // Both roles must be explicit. Additional family/social roles are not removed
  // merely because a new role was mentioned in ordinary conversation.
  for (const person of context.entities.filter(entity => entity.kind === 'person')) {
    if (!mentioned(sourceText, person.name)) continue;
    const name = escaped(person.name);
    const match = new RegExp(`${name}\\s+(?:is|là)\\s+(.{1,45}?)\\s*[,;]\\s*(?:not|không phải|chứ không phải)\\s+(.{1,45}?)(?=[.!?;]|$)`, 'iu').exec(sourceText);
    if (!match) continue;
    const newRelation = relation(match[1]!); const oldRelation = relation(match[2]!);
    if (newRelation && oldRelation && newRelation !== oldRelation) patches.push({ ...base, evidence: match[0], kind: 'relationship', entityId: person.id, oldRelation, relation: newRelation });
  }

  const value = favoriteColorValue(sourceText);
  if (value) {
    const favoriteClause = sourceText.split(/[.!?;\n]/u).find(clause => favoriteColorValue(clause) === value) ?? '';
    const explicitChange = /\bmy new favou?rite colou?r\b|\bfavou?rite colou?r is now\b|\b(?:change|changed|correct|update).{0,30}favou?rite\b|\bfavou?rite.{0,30}(?:changed|instead)\b|(?:bây giờ|giờ).{0,45}màu|màu.{0,45}đổi thành|,\s*(?:not\b|(?:chứ )?không phải)/iu.test(favoriteClause);
    const previous = context.preferences.find(preference => preference.slot === 'favorite_color');
    const replacesPrevious = previous !== undefined && normalized(previous.value) !== normalized(value);
    if (explicitChange || replacesPrevious) patches.push({ ...base, kind: 'preference', slot: 'favorite_color', category: 'like', value });
  }

  if (/\bsometimes\b|(?:không phải|không) (?:ngày nào|mỗi ngày)|thỉnh thoảng/iu.test(sourceText)
    && /\b(?:not (?:a )?promise every day|routine|read|reading)\b|(?:thói quen|đọc)/iu.test(sourceText)) {
    const routines = context.preferences.filter(preference => preference.category === 'routine');
    if (routines.length === 1) patches.push({ ...base, kind: 'routine', preferenceId: routines[0]!.id, qualifiers: { frequency: 'sometimes' } });
  }

  const addresses = [...sourceText.matchAll(/(?:\b(?:please )?(?:just )?call me\s+|(?:gọi (?:mình|tớ|con|tôi) (?:là\s+)?))([^,.!;?]+?)(?=\s+(?:from now on|today|instead|anymore|thôi|nhé|nha|nữa)(?:[,.!;]|$)|[,.;!]|$)/giu)]
    .filter(match => !/(?:do not|don['’]?t|đừng)\s*$/iu.test(sourceText.slice(0, match.index).slice(-25)));
  const viShort = /(?:^|[,.;]\s*|\s)[Gg]ọi\s+([\p{Lu}][\p{L}\p{M}'’\-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’\-]*){0,3})\s+thôi/u.exec(sourceText);
  let preferredAddress = clean(viShort?.[1] ?? addresses.at(-1)?.[1] ?? '');
  const withdrawal = /\b(?:no (?:more )?(?:silly )?nicknames?|do not call|don['’]?t call)\b|đừng gọi|không (?:cần|muốn).*?(?:biệt danh|tên vui)/iu.test(sourceText);
  if (!preferredAddress && withdrawal && context.addressPreference) preferredAddress = context.profile.displayName;
  if (preferredAddress && /^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]{0,79}$/u.test(preferredAddress)) {
    const isCanonical = normalized(preferredAddress) === normalized(context.profile.displayName);
    const allowNickname = !withdrawal && !isCanonical;
    patches.push({ ...base, kind: 'address', preferredAddress, allowNickname, nickname: allowNickname ? preferredAddress : null });
  }
  return patches;
}

export function patchKey(patch: MemoryPatch): string {
  return patch.kind === 'relationship' ? `relationship:${patch.entityId}` : patch.kind === 'routine' ? `routine:${patch.preferenceId}` : patch.kind === 'preference' ? `preference:${patch.slot}` : 'address';
}
