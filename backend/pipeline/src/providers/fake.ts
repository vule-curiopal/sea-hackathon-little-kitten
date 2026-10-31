import { readFile } from 'node:fs/promises';
import type { Language } from '@miu/voice-contracts';
import { LIMITS } from '@miu/voice-contracts';
import type { VoiceConfig } from '../config.js';
import { PipelineError } from '../errors.js';
import type { PipelineProviders } from '../ports.js';
import { runStage } from './helpers.js';
import { assertAudioInput, assertLanguage, assertReplyInput, assertVoice, validateReplyText } from './validation.js';

export const FIXTURE_TEXTS: Record<Language, string> = {
  vi: 'Chào bạn! Mình là Buddy nè. Hôm nay bạn muốn chơi trò gì?',
  en: "Hi there! I'm Buddy. What would you like to play today?",
};

function wavDuration(bytes: Buffer): number {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid bundled voice fixture');
  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error('Invalid bundled voice fixture');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Invalid bundled voice fixture');
      const format = bytes.readUInt16LE(start);
      if (format !== 1 && format !== 3 && format !== 0xfffe) throw new Error('Invalid bundled voice fixture');
      byteRate = bytes.readUInt32LE(start + 8);
    }
    if (id === 'data') dataBytes += size;
    offset = start + size + (size & 1);
  }
  if (!byteRate || !dataBytes || bytes.length > LIMITS.audioBytes) throw new Error('Invalid bundled voice fixture');
  return Math.round(dataBytes / byteRate * 1000);
}

function assertFixture(fixtureId: string | undefined, language: Language): void {
  assertLanguage(language);
  if (!fixtureId) throw new PipelineError('missing_fixture', 400);
  if (fixtureId !== `voice_sample_${language}`) throw new PipelineError('unknown_fixture', 422);
}

export async function createFakeProviders(config: VoiceConfig): Promise<PipelineProviders> {
  const vi = await readFile(new URL('../../fixtures/vi.wav', import.meta.url));
  const en = await readFile(new URL('../../fixtures/en.wav', import.meta.url));
  const samples = { vi: { bytes: vi, durationMs: wavDuration(vi) }, en: { bytes: en, durationMs: wavDuration(en) } };
  for (const text of Object.values(FIXTURE_TEXTS)) validateReplyText(text);
  return {
    mode: 'fake',
    transcribe: (audio, language, signal, fixtureId) => runStage(signal, config.sttTimeoutMs, async () => {
      assertAudioInput(audio);
      assertFixture(fixtureId, language);
      return { text: FIXTURE_TEXTS[language], language };
    }),
    response: {
      generate: (input, signal) => runStage(signal, config.replyTimeoutMs, async () => {
        assertReplyInput(input);
        assertFixture(input.fixtureId, input.language);
        return { turnId: input.turnId, replyText: FIXTURE_TEXTS[input.language], language: input.language };
      }),
    },
    synthesize: (text, voiceId, language, signal, fixtureId) => runStage(signal, config.ttsTimeoutMs, async () => {
      assertVoice(voiceId, language);
      assertFixture(fixtureId, language);
      validateReplyText(text);
      if (text !== FIXTURE_TEXTS[language]) throw new PipelineError('invalid_reply', 503);
      const sample = samples[language];
      return { bytes: Buffer.from(sample.bytes), mimeType: 'audio/wav', durationMs: sample.durationMs };
    }),
  };
}
