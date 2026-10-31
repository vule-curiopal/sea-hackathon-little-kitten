import { DEFAULT_VOICE, VOICES } from '@miu/voice-contracts';
import type { Language, ProviderMode } from '@miu/voice-contracts';

export interface VoiceConfig {
  mode: ProviderMode; host: string; port: number; allowedOrigins: string[];
  elevenApiKey: string; openaiApiKey: string; elevenBaseUrl: string; openaiBaseUrl: string;
  sttModel: string; ttsModel: string; replyModel: string; maxOutputTokens: number;
  enableLogging: boolean | undefined; sttTimeoutMs: number; replyTimeoutMs: number; ttsTimeoutMs: number; turnTimeoutMs: number;
  defaultVoices: Record<Language, string>; ffprobePath: string;
}
function integer(value: string | undefined, fallback: number, min = 1, max = 120000): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error('Invalid numeric server configuration');
  return result;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): VoiceConfig {
  const mode = env.MIU_PROVIDER ?? 'fake';
  if (mode !== 'fake' && mode !== 'real') throw new Error('MIU_PROVIDER must be fake or real');
  const logging = env.ELEVENLABS_ENABLE_LOGGING || undefined;
  if (logging !== undefined && logging !== 'true' && logging !== 'false') throw new Error('ELEVENLABS_ENABLE_LOGGING must be true or false');
  if (mode === 'real' && (!env.ELEVENLABS_API_KEY || !env.OPENAI_API_KEY || logging === undefined)) {
    throw new Error('Real mode requires both API keys and an explicit ELEVENLABS_ENABLE_LOGGING choice after D10 review');
  }
  const defaultVoices = { vi: env.ELEVENLABS_VOICE_ID_VI ?? DEFAULT_VOICE.vi, en: env.ELEVENLABS_VOICE_ID_EN ?? DEFAULT_VOICE.en };
  for (const language of ['vi', 'en'] as const) {
    if (!VOICES.some(voice => voice.id === defaultVoices[language] && voice.language === language)) throw new Error('Default voice must belong to the language allowlist');
  }
  const elevenBaseUrl = env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io';
  const openaiBaseUrl = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  for (const base of [elevenBaseUrl, openaiBaseUrl]) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Provider URL must be HTTPS without credentials or query');
  }
  return {
    mode, host: env.HOST ?? '127.0.0.1', port: integer(env.PORT, 3001, 1, 65535),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(x => x.trim()).filter(Boolean),
    elevenApiKey: env.ELEVENLABS_API_KEY ?? '', openaiApiKey: env.OPENAI_API_KEY ?? '', elevenBaseUrl, openaiBaseUrl,
    sttModel: env.ELEVENLABS_STT_MODEL ?? 'scribe_v2', ttsModel: env.ELEVENLABS_TTS_MODEL ?? 'eleven_flash_v2_5',
    replyModel: env.OPENAI_MODEL ?? 'gpt-6-luna', maxOutputTokens: integer(env.OPENAI_MAX_OUTPUT_TOKENS, 200, 32, 1000),
    enableLogging: logging === undefined ? undefined : logging === 'true',
    sttTimeoutMs: integer(env.STT_TIMEOUT_MS, 10000), replyTimeoutMs: integer(env.REPLY_TIMEOUT_MS, 10000),
    ttsTimeoutMs: integer(env.TTS_TIMEOUT_MS, 10000), turnTimeoutMs: integer(env.TURN_PROCESSING_TIMEOUT_MS, 20000),
    defaultVoices, ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
  };
}
