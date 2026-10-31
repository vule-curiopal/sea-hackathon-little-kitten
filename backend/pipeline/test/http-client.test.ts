import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { VoiceApiClient } from '../../../packages/voice-client/src/api.js';
import { buildApp } from '../src/app.js';
import { createServer } from '../src/server-runtime.js';
import { loadConfig } from '../src/config.js';
import type { PipelineProviders } from '../src/ports.js';

describe('real localhost HTTP with the frontend API client (fake providers)', () => {
  it('uses the shared session/config/turn/receipt protocol for both languages', async () => {
    const app = createServer(await buildApp({config:loadConfig({})}));
    try {
      const baseUrl = await app.listen({host:'127.0.0.1',port:0});
      const client = new VoiceApiClient({baseUrl});
      for (const language of ['vi','en'] as const) {
        let session = await client.createSession(language === 'vi' ? 'an' : 'binh');
        session = {...session,...await client.configure(session,language)};
        const sample = await readFile(new URL(`../fixtures/${language}.wav`,import.meta.url));
        const id = client.createRequestId();
        const turn = await client.submitTurn(session,{requestId:id,audio:new Blob([sample],{type:'audio/wav'}),fixtureId:`voice_sample_${language}`});
        expect(turn.reply.language).toBe(language);
        expect(turn.audio.mime_type).toBe('audio/wav');
        expect(turn.memory).toBeNull();
        await client.playback(session,id,{request_id:randomUUID(),status:'started',played_ms:0,state_version:turn.state_version});
        await client.playback(session,id,{request_id:randomUUID(),status:'completed',played_ms:turn.audio.duration_ms,state_version:turn.state_version});
        await client.endSession(session);
      }
    } finally { await app.close(); }
  });
  it('aborting the HTTP request releases provider work and the active profile lock', async () => {
    const providers:PipelineProviders = {
      mode:'fake',
      transcribe:vi.fn<PipelineProviders['transcribe']>(async () => new Promise<never>(() => {})),
      response:{generate:vi.fn()},synthesize:vi.fn(),
    };
    const app = createServer(await buildApp({config:loadConfig({}),providers}));
    try {
      const baseUrl=await app.listen({host:'127.0.0.1',port:0});
      const client=new VoiceApiClient({baseUrl});
      const session=await client.createSession('an');
      const sample=await readFile(new URL('../fixtures/vi.wav',import.meta.url));
      const controller=new AbortController();
      const pending=client.submitTurn(session,{requestId:randomUUID(),audio:new Blob([sample],{type:'audio/wav'}),fixtureId:'voice_sample_vi',signal:controller.signal});
      // Attach rejection observation before abort to avoid an unhandled promise.
      const observed=expect(pending).rejects.toMatchObject({code:'CANCELED'});
      await vi.waitFor(() => expect(providers.transcribe).toHaveBeenCalledTimes(1),{timeout:1500,interval:20});
      controller.abort();
      await observed;
      await vi.waitFor(async () => {
        const response=await fetch(`${baseUrl}/api/demo/panel`,{headers:{authorization:`Bearer ${session.demo_token}`}});
        expect((await response.json()).active_turn).toBeNull();
      },{timeout:1000,interval:20});
      expect(providers.response.generate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
