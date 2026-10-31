import type { VoiceConfig } from '../../config.js';
import { PipelineError } from '../../errors.js';

/** Shared authenticated connection settings, without retaining request audio or text. */
export function createElevenLabsClient(config: VoiceConfig) {
  if (!config.elevenApiKey || typeof config.enableLogging !== 'boolean') {
    throw new PipelineError('provider_configuration', 503);
  }
  return {
    apiKey: config.elevenApiKey,
    url(path: string): URL {
      return new URL(`${config.elevenBaseUrl.replace(/\/$/u, '')}${path}`);
    },
  };
}
