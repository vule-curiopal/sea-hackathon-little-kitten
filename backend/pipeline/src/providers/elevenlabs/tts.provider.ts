import { LIMITS } from '@miu/voice-contracts';
import { inspectSynthesizedAudio } from '../../audio.js';
import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';
import type { PipelineProviders } from '../../ports.js';
import { readBounded, runStage, upstreamFailure } from '../helpers.js';
import { assertVoice, validateReplyText } from '../validation.js';
import { createElevenLabsClient } from './client.js';

/** ElevenLabs speech synthesis; accepts only approved, complete speakable text. */
export function createElevenLabsTts(config: VoiceConfig, fetchImpl: typeof fetch): PipelineProviders['synthesize'] {
  const client = createElevenLabsClient(config);
  return (text, voiceId, language, parentSignal) => runStage(parentSignal, config.ttsTimeoutMs, async signal => {
    assertVoice(voiceId, language);
    validateReplyText(text);
    const url = client.url(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`);
    url.searchParams.set('output_format', 'mp3_44100_128');
    const response = await fetchImpl(url, {
      method: 'POST', signal,
      headers: { 'xi-api-key': client.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: config.ttsModel,
        language_code: language,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 0.95 },
        apply_text_normalization: 'auto',
        apply_language_text_normalization: false,
      }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw upstreamFailure(response.status);
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (mimeType !== 'audio/mpeg') {
      void response.body?.cancel().catch(() => undefined);
      throw new PipelineError('provider_invalid_audio', 503);
    }
    const bytes = await readBounded(response, LIMITS.audioBytes, signal);
    const inspected = await inspectSynthesizedAudio(bytes, mimeType, signal, config.ffprobePath);
    return { bytes, mimeType: inspected.mimeType, durationMs: inspected.durationMs };
  });
}
