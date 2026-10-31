import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../backend/pipeline/src/app.js';
import { loadConfig } from '../backend/pipeline/src/config.js';
import { createServer } from '../backend/pipeline/src/server-runtime.js';
import { VoiceApiClient } from '../packages/voice-client/src/api.js';

// Real localhost HTTP through Express and the browser API client; fake providers only.
const server = createServer(await buildApp({ config: loadConfig({ MIU_PROVIDER: 'fake' }) }));
try {
  const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  const client = new VoiceApiClient({ baseUrl });
  for (const language of ['vi', 'en'] as const) {
    let session = await client.createSession(language === 'vi' ? 'an' : 'binh');
    session = { ...session, ...await client.configure(session, language) };
    const bytes = await readFile(new URL(`../backend/pipeline/fixtures/${language}.wav`, import.meta.url));
    const id = randomUUID();
    const turn = await client.submitTurn(session, {
      requestId: id,
      audio: new Blob([bytes], { type: 'audio/wav' }),
      fixtureId: `voice_sample_${language}`,
    });
    if (turn.turn_id !== id || turn.reply.language !== language || turn.audio.mime_type !== 'audio/wav'
      || turn.memory !== null || turn.engine_mode !== 'voice_stub') {
      throw new Error('Unexpected turn envelope in Express smoke.');
    }
    for (const status of ['started', 'completed'] as const) {
      await client.playback(session, id, {
        request_id: randomUUID(), status,
        played_ms: status === 'started' ? 0 : turn.audio.duration_ms,
        state_version: turn.state_version,
      });
    }
    await client.endSession(session);
    console.log(`${language}: Express HTTP + fake voice turn (${turn.audio.duration_ms} ms WAV) + ordered receipts OK; memory disabled`);
  }
} finally {
  await server.close();
}
