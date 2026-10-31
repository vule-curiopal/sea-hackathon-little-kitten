import type { FamilyConfig, Language, PlaybackReceipt, ProviderMode } from '@miu/voice-contracts';
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

/** Persistent character state belongs to this port, never the voice RAM cache. */
export interface EngineProfileSnapshot {
  configuration: FamilyConfig;
  state_version: number;
  clock_version: number;
  effective_now: string;
}
export interface EngineSessionSnapshot extends EngineProfileSnapshot {
  session_id: string;
  demo_token: string;
}
export interface EnginePreparedTurn {
  session_id: string;
  turn_id: string;
  state_version: number;
  clock_version: number;
  provider_mode: ProviderMode;
  reply: { text: string; sentences: string[]; language: Language };
  presentation: unknown;
  face?: unknown;
  memory: unknown;
}
export interface EngineBridge {
  readonly mode: ProviderMode;
  openSession(key: string): Promise<EngineSessionSnapshot>;
  context(token: string): Promise<EngineProfileSnapshot>;
  configure(token: string, patch: Partial<FamilyConfig>): Promise<EngineProfileSnapshot>;
  prepare(token: string, sessionId: string, input: { request_id: string; kind: 'utterance' | 'greeting'; text?: string }, signal: AbortSignal): Promise<EnginePreparedTurn>;
  playback(token: string, sessionId: string, turnId: string, receipt: PlaybackReceipt): Promise<unknown>;
  cancel(token: string, sessionId: string, turnId: string): Promise<unknown>;
  closeSession(token: string, sessionId: string): Promise<unknown>;
}
