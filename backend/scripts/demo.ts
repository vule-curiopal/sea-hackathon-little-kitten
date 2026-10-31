import { randomUUID } from 'node:crypto';
import { MiuApplication, type TurnResponse } from '../application.js';
import { createMemoryStore } from '../memory/index.js';
import { FakeProvider } from '../pipeline/providers.js';

// Always isolated and offline: never load .env or use an external database.
const memory = await createMemoryStore({ now: () => new Date('2026-10-31T03:00:00Z') });
const app = new MiuApplication(memory, new FakeProvider());
try {
  await app.bootstrap();
  let session = await app.openSession('an');
  const profileId = app.profileForToken(session.demo_token);
  async function delivered(result: TurnResponse) {
    for (const status of ['started', 'completed'] as const) {
      await app.playback(profileId, result.session_id, result.turn_id, { request_id: randomUUID(), status, state_version: result.state_version });
    }
  }
  for (const text of ['My hobby is drawing', 'My friend is Minh', 'Mình thích khủng long', 'Mình sợ sấm', 'My dog Mochi fell in a puddle']) {
    const result = await app.prepareTurn(profileId, session.session_id, { request_id: randomUUID(), kind: 'utterance', text });
    console.log(`Adult tester (fictional): ${text}`);
    console.log(`Miu: ${result.reply.text}`);
    await delivered(result);
  }
  let context = await app.getContext(profileId);
  console.log(`Learned: ${context.entities.length} named entities, ${context.socialCircle.length} social connections, ${context.preferences.length} preferences.`);
  const next = await app.nextDay(profileId, randomUUID(), context.clock.version);
  console.log(`Next day: ${next.daily.localDate}, growth day ${next.daily.growthDays}; ${next.daily.growthTheme}.`);
  session = await app.openSession('an');
  const greeting = await app.prepareTurn(profileId, session.session_id, { request_id: randomUUID(), kind: 'greeting' });
  console.log(`Miu: ${greeting.reply.text}`);
  await delivered(greeting);
  const forget = await app.prepareTurn(profileId, session.session_id, { request_id: randomUUID(), kind: 'utterance', text: 'Forget that' });
  console.log(`Miu: ${forget.reply.text}`);
  await delivered(forget);
  context = await app.getContext(profileId);
  console.log(`After forgetting: ${context.events.length} events; pet ${context.entities.find(entity => entity.kind === 'pet')?.name ?? 'none'} retained.`);
} finally { await app.close(); }
