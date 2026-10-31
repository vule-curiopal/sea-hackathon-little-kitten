import type { VoiceConfig } from '../config.js';
import { PipelineError } from '../errors.js';
import type { PipelineProviders } from '../ports.js';
import { createElevenLabsStt } from './elevenlabs/stt.provider.js';
import { createElevenLabsTts } from './elevenlabs/tts.provider.js';
import { createOpenAiResponseGenerator } from './openai/response.generator.js';

/** Compose provider adapters; turn orchestration belongs to the application service. */
export function createRealProviders(config: VoiceConfig, fetchImpl: typeof fetch): PipelineProviders {
  if (!config.elevenApiKey || !config.openaiApiKey || typeof config.enableLogging !== 'boolean') {
    throw new PipelineError('provider_configuration', 503);
  }
  return {
    mode: 'real',
    transcribe: createElevenLabsStt(config, fetchImpl),
    response: createOpenAiResponseGenerator(config, fetchImpl),
    synthesize: createElevenLabsTts(config, fetchImpl),
  };
}
