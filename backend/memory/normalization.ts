import { createHash } from 'node:crypto';
import type { PreferenceCategory } from '../shared/types.js';

/** Compare an explicitly supplied former name without keeping it as an alias. */
export function retiredNameHash(profileId: string, name: string): string {
  const normalizedName = name.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/gu, ' ');
  return createHash('sha256').update(`${profileId}:${normalizedName}`).digest('hex');
}

/** Equality key only: keep the original, source-grounded value for display.
 * The optional Vietnamese activity verb does not create a different hobby.
 * Other categories and meanings are deliberately left separate. */
export function canonicalPreferenceKey(category: PreferenceCategory, value: string): string {
  const key = value.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/gu, ' ');
  return category === 'hobby' ? key.replace(/^chơi\s+(?=\S)/u, '') : key;
}
