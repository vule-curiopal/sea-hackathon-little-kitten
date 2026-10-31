import type { Language, ProviderMode } from '@miu/voice-contracts';
export interface AudioInput { bytes: Buffer; mimeType: string; filename: string; durationMs: number }
export interface Transcript { text: string; language: Language }
export interface ReplyInput { turnId: string; text: string; language: Language; kind: 'utterance' | 'greeting'; fixtureId?: string }
export interface ReplyOutput { turnId: string; replyText: string; language: Language }
export interface SpeechOutput { bytes: Buffer; mimeType: string; durationMs: number }
export interface ResponseGenerator { generate(input: ReplyInput, signal: AbortSignal): Promise<ReplyOutput> }
export interface PipelineProviders {
  mode: ProviderMode;
  transcribe(audio: AudioInput, language: Language, signal: AbortSignal, fixtureId?: string): Promise<Transcript>;
  response: ResponseGenerator;
  synthesize(text: string, voiceId: string, language: Language, signal: AbortSignal, fixtureId?: string): Promise<SpeechOutput>;
}
