export type Language = 'vi' | 'en';
export type ProviderMode = 'fake' | 'real';
export const VOICES = [
  { id: 'mgBpvrNosWzExdPuRbXP', label: 'Phan Anh', language: 'vi', is_default: true },
  { id: 'x4KAhuXs2G8TfK9Zr7Q4', label: 'Cam Hong', language: 'vi', is_default: false },
  { id: 'fBD19tfE58bkETeiwUoC', label: 'Little Dude II', language: 'en', is_default: true },
  { id: '87n4zM8Wuy87vFILuKvE', label: 'Ziggy', language: 'en', is_default: false },
  { id: 'e79twtVS2278lVZZQiAD', label: 'The Elf', language: 'en', is_default: false },
] as const;
export const DEFAULT_VOICE: Record<Language, string> = { vi: VOICES[0].id, en: VOICES[2].id };
export const LIMITS = { recordingMs: 30000, audioBytes: 5242880, requestBytes: 6291456, transcriptChars: 2000, replyChars: 400 } as const;
export interface FamilyConfig { personality: string; role: 'friend' | 'big_sibling' | 'teacher'; language_mode: Language; voice_id: string }
export interface Versions { clock_version: number; state_version: number }
export interface SessionResponse extends Versions {
  session_id: string; demo_token: string; configuration: FamilyConfig; effective_now: string;
  provider_mode: ProviderMode; engine_mode: 'voice_stub';
}
export interface VoiceAudio { mime_type: string; data_base64: string; duration_ms: number }
export interface TurnResponse extends Versions {
  session_id: string; turn_id: string; sequence: number; provider_mode: ProviderMode; engine_mode: 'voice_stub';
  transcript: { text: string; language: Language; uncertain_spans: unknown[] } | null;
  reply: { text: string; sentences: string[]; language: Language };
  audio: VoiceAudio;
  presentation: null; face: null; memory: null;
  timings_ms: { stt: number; reply: number; validation: number; tts: number; server_total: number };
  fixture_id?: string;
}
export interface ApiError { error: { code: string; message: string; retryable: boolean }; turn_id?: string }
export interface PlaybackReceipt { request_id: string; status: 'started' | 'completed' | 'interrupted'; played_ms: number; state_version: number }
