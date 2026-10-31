import type { VoiceConfig } from '../config.js';
import type { PipelineProviders } from '../ports.js';
import { createFakeProviders } from './fake.js';
import { createRealProviders } from './real.js';

export { FIXTURE_TEXTS } from './fake.js';
export { validateReplyText } from './validation.js';

export async function createProviders(config: VoiceConfig, fetchImpl: typeof fetch = fetch): Promise<PipelineProviders> {
  return config.mode === 'fake' ? createFakeProviders(config) : createRealProviders(config, fetchImpl);
}
