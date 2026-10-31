import { LIMITS } from '@miu/voice-contracts';
import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';
import type { PipelineProviders } from '../../ports.js';
import { isRecord, readJson, runStage } from '../helpers.js';
import { assertAudioInput, assertLanguage } from '../validation.js';
import { createElevenLabsClient } from './client.js';

/** ElevenLabs batch speech recognition; forwards the validated source container unchanged. */
export function createElevenLabsStt(config: VoiceConfig, fetchImpl: typeof fetch): PipelineProviders['transcribe'] {
  const client = createElevenLabsClient(config);
  return (audio, language, parentSignal) => runStage(parentSignal, config.sttTimeoutMs, async signal => {
    assertLanguage(language);
    assertAudioInput(audio);
    const form = new FormData();
    form.set('file', new Blob([Uint8Array.from(audio.bytes)], { type: audio.mimeType }), audio.filename);
    const parameters = {
      model_id: config.sttModel,
      file_format: 'other',
      language_code: language,
      tag_audio_events: 'false',
      diarize: 'false',
      timestamps_granularity: 'none',
      no_verbatim: 'false',
      temperature: '0',
      webhook: 'false',
      use_multi_channel: 'false',
      use_speaker_library: 'false',
    };
    for (const [name, value] of Object.entries(parameters)) form.set(name, value);
    const url = client.url('/v1/speech-to-text');
    // Brain leaves the provider default in place; false opts into restricted zero retention.
    if (!config.enableLogging) url.searchParams.set('enable_logging', 'false');
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'xi-api-key': client.apiKey }, body: form, signal,
    });
    const payload = await readJson(response, signal);
    if (!isRecord(payload) || typeof payload.text !== 'string'
      || (payload.language_code !== undefined && typeof payload.language_code !== 'string')) {
      throw new PipelineError('provider_unavailable', 503);
    }
    const text = payload.text.trim();
    if (!text) throw new PipelineError('unclear_audio', 422);
    if ([...text].length > LIMITS.transcriptChars) throw new PipelineError('provider_unavailable', 503);
    // Provider detection never changes the language selected for this session.
    return { text, language };
  });
}
