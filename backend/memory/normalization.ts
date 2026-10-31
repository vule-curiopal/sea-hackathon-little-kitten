import { createHash } from 'node:crypto';
import type { PreferenceCategory } from '../shared/types.js';

/** Compare an explicitly supplied former name without keeping it as an alias. */
export function retiredNameHash(profileId: string, name: string): string {
  const normalizedName = name.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/gu, ' ');
  return createHash('sha256').update(`${profileId}:${normalizedName}`).digest('hex');
}

/** Equality key only: keep the original, source-grounded value for display.
 * Reconfirmation wording does not create a different hobby. Restrict English
 * "still" to an activity gerund so "still life painting" stays distinct.
 * Other categories and meanings are deliberately left separate. */
export function canonicalPreferenceKey(category: PreferenceCategory, value: string): string {
  const key = value.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/gu, ' ');
  return category === 'hobby' ? key.replace(/^chơi\s+(?=\S)/u, '').replace(/^still\s+(?=[\p{L}\p{M}]+ing\b)/u, '') : key;
}

/** Display/evidence stays literal. Ignore only terminal prose punctuation when
 * comparing two extractor proposals for the same child-authored story. */
export function canonicalStoryKey(title: string, summary: string): string {
  const key = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/gu, ' ').replace(/[.!?。]+$/gu, '').trim();
  return `${key(title)}\n${key(summary)}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
