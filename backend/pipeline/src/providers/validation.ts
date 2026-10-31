import { LIMITS, VOICES } from '@miu/voice-contracts';
import type { Language } from '@miu/voice-contracts';
import { PipelineError } from '../errors.js';
import type { AudioInput, ReplyInput } from '../ports.js';

export function assertLanguage(language: Language): void {
  if (language !== 'vi' && language !== 'en') throw new PipelineError('invalid_request', 400);
}

export function assertVoice(voiceId: string, language: Language): void {
  assertLanguage(language);
  if (!VOICES.some(voice => voice.id === voiceId && voice.language === language)) throw new PipelineError('invalid_request', 400);
}

export function assertAudioInput(audio: AudioInput): void {
  const mime = typeof audio.mimeType === 'string' ? audio.mimeType.split(';')[0]?.trim().toLowerCase() : '';
  if (!mime || !['audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(mime)) {
    throw new PipelineError('unsupported_audio', 415);
  }
  if (!Buffer.isBuffer(audio.bytes) || audio.bytes.length === 0 || audio.bytes.length > LIMITS.audioBytes) throw new PipelineError('invalid_request', 400);
  const padding = mime === 'audio/webm' || mime === 'audio/mp4' || mime === 'audio/x-m4a' || mime === 'audio/m4a' ? 250 : 0;
  if (!Number.isFinite(audio.durationMs) || audio.durationMs < 100 || audio.durationMs > LIMITS.recordingMs + padding) throw new PipelineError('invalid_request', 400);
  if (typeof audio.filename !== 'string' || audio.filename.length === 0 || audio.filename.length > 255) throw new PipelineError('invalid_request', 400);
}

export function assertReplyInput(input: ReplyInput): void {
  assertLanguage(input.language);
  if (typeof input.turnId !== 'string' || input.turnId.length === 0 || input.turnId.length > 128) throw new PipelineError('invalid_request', 400);
  if (input.kind !== 'utterance' && input.kind !== 'greeting') throw new PipelineError('invalid_request', 400);
  if (typeof input.text !== 'string' || [...input.text].length > LIMITS.transcriptChars || (input.kind === 'utterance' && !input.text.trim())) {
    throw new PipelineError('unclear_audio', 422);
  }
}

export { validateReplyText } from '../modules/turns/reply-policy.js';
