import { LIMITS } from '@miu/voice-contracts';
import { PipelineError } from '../../errors.js';

/** Format/length boundary only; this is not the full character engine's safety policy. */
export function validateReplyText(text: string): string[] {
  if (typeof text !== 'string' || !text.trim() || [...text].length > LIMITS.replyChars) throw new PipelineError('invalid_reply', 503);
  if (!/[\p{L}\p{N}]/u.test(text) || /\p{Extended_Pictographic}/u.test(text)) throw new PipelineError('invalid_reply', 503);
  // These characters/structures are unsuitable for plain spoken output.
  if (/[`*_~#<>{}\[\]\\]/u.test(text) || /https?:\/\/|^\s*(?:[-+]\s|\d+\.\s)/mu.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new PipelineError('invalid_reply', 503);
  }
  if (/\((?:[^)]*\b(?:whispers?|laughs?|giggles?|sighs?|chuckles?|smiles?|purrs?)\b|[^)]*(?:thì thầm|cười|thở dài))[^)]*\)/iu.test(text)) {
    throw new PipelineError('invalid_reply', 503);
  }
  if ((text.match(/[?？]/gu) ?? []).length > 1) throw new PipelineError('invalid_reply', 503);
  const sentences = text.trim().match(/[^.!?…。！？]+(?:[.!?…。！？]+|$)/gu)?.map(sentence => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length < 1 || sentences.length > 3) throw new PipelineError('invalid_reply', 503);
  return sentences;
}
