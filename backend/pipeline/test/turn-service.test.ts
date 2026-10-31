import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SessionService } from '../src/modules/sessions/session.service.js';
import { TurnService } from '../src/modules/turns/turn.service.js';
import type { PipelineProviders } from '../src/ports.js';

async function setup() {
  const bytes = await readFile(new URL('../fixtures/vi.wav', import.meta.url));
  const sessions = new SessionService();
  const session = sessions.create('an', randomUUID());
  const providers: PipelineProviders = {
    mode: 'fake',
    transcribe: vi.fn(async () => ({ text: 'Chào Miu.', language: 'vi' })),
    response: { generate: vi.fn(async input => ({
      turnId: input.turnId, replyText: 'Chào bạn!', language: input.language,
    })) },
    synthesize: vi.fn(async () => ({ bytes, mimeType: 'audio/wav', durationMs: 3680 })),
  };
  const service = new TurnService({ config: loadConfig({}), sessions, providers });
  const input = {
    requestId: randomUUID(), kind: 'utterance' as const, languageHint: 'vi',
    audio: { bytes, filename: 'speech.wav', mimeType: 'audio/wav' },
  };
  return { service, sessions, session, providers, input };
}

describe('TurnService without an HTTP framework', () => {
  it('runs the provider ports and replays the same request without repeated work', async () => {
    const { service, sessions, session, providers, input } = await setup();
    try {
      const result = await service.execute(session, input, new AbortController().signal);
      expect(result).toMatchObject({
        turn_id: input.requestId, sequence: 1, engine_mode: 'voice_stub', memory: null,
        transcript: { text: 'Chào Miu.', language: 'vi' }, reply: { text: 'Chào bạn!' },
      });
      expect(await service.execute(session, input, new AbortController().signal)).toEqual(result);
      expect(providers.transcribe).toHaveBeenCalledTimes(1);
      expect(providers.response.generate).toHaveBeenCalledTimes(1);
      expect(providers.synthesize).toHaveBeenCalledTimes(1);
      expect(session.profile.active).toBeUndefined();
    } finally { sessions.dispose(); }
  });

  it('discards an uncooperative engine result after external cancellation', async () => {
    const { service, sessions, session, providers, input } = await setup();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let finish!: (result: { turnId: string; replyText: string; language: 'vi' }) => void;
    providers.response.generate = vi.fn(() => {
      entered();
      return new Promise(resolve => { finish = resolve; });
    });
    const controller = new AbortController();
    try {
      const pending = service.execute(session, input, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'turn_canceled' });
      await ready;
      controller.abort();
      await rejected;
      finish({ turnId: input.requestId, replyText: 'Phản hồi đến muộn.', language: 'vi' });
      await Promise.resolve();
      expect(providers.synthesize).not.toHaveBeenCalled();
      expect(session.profile.active).toBeUndefined();
      expect(session.sequence).toBe(0);
      expect(session.turns.get(input.requestId)).toMatchObject({ status: 'canceled', response: undefined });
    } finally { sessions.dispose(); }
  });
});
