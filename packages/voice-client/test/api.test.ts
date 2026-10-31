import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE } from '@miu/voice-contracts';
import { VoiceApiClient } from '../src/api.js';
import { captured, session, turn } from './fixtures.js';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('canonical voice API', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('creates a session then selects fixed language/voice with authenticated configuration', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(session()))
      .mockResolvedValueOnce(response({ configuration: { ...session().configuration, language_mode: 'en', voice_id: DEFAULT_VOICE.en }, state_version: 2, clock_version: 1 }));
    const api = new VoiceApiClient({ fetch: fetcher, createRequestId: () => turn().turn_id });
    const created = await api.createSession('an');
    await api.configure(created, 'en');
    expect(fetcher.mock.calls[0]![0]).toBe('/api/sessions');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ demo_profile_key: 'an', request_id: turn().turn_id });
    const config = fetcher.mock.calls[1]![1]!;
    expect(config.headers).toMatchObject({ Authorization: 'Bearer test-demo-token' });
    expect(JSON.parse(String(config.body))).toMatchObject({ language_mode: 'en', voice_id: DEFAULT_VOICE.en });
  });

  it('submits one finalized original blob as multipart without a manual Content-Type header', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(turn()));
    const api = new VoiceApiClient({ fetch: fetcher });
    const audio = captured();
    const result = await api.submitTurn(session(), { requestId: turn().turn_id, audio, fixtureId: 'voice_sample_vi' });
    expect(result.turn_id).toBe(turn().turn_id);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/sessions/${session().session_id}/turns`);
    expect(init!.headers).toEqual({ Authorization: 'Bearer test-demo-token' });
    const body = init!.body as FormData;
    expect(body.get('kind')).toBe('utterance');
    expect(body.get('language_hint')).toBe('vi');
    expect(body.get('fixture_id')).toBe('voice_sample_vi');
    const file = body.get('audio') as File;
    expect(file.name).toBe('recording.m4a');
    expect(file.type).toBe('audio/mp4');
    expect(await file.text()).toBe(await audio.blob.text());
  });

  it('rejects undeclared fake fixtures and wrong-language or wrong-turn responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...turn(), turn_id: 'another-turn' }));
    const api = new VoiceApiClient({ fetch: fetcher });
    await expect(api.submitTurn(session(), { requestId: turn().turn_id, audio: captured() })).rejects.toMatchObject({ code: 'MISSING_FIXTURE' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.submitTurn(session(), { requestId: turn().turn_id, audio: captured(), fixtureId: 'voice_sample_vi' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('stops waiting on abort even for a transport that ignores signals and separately sends DELETE', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new VoiceApiClient({ fetch: fetcher });
    const abort = new AbortController();
    const pending = api.submitTurn(session(), { requestId: turn().turn_id, audio: captured(), fixtureId: 'voice_sample_vi', signal: abort.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CANCELED' });
    abort.abort();
    await assertion;
    await api.cancelTurn(session(), turn().turn_id);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetcher.mock.calls[1]![1]!.signal!.aborted).toBe(false);
    expect(fetcher.mock.calls[1]![1]!.method).toBe('DELETE');
  });

  it('enforces deadlines without retrying or exposing provider error details', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const api = new VoiceApiClient({ fetch: fetcher, requestTimeoutMs: 100 });
    const pending = api.createSession('an');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(response({ error: { code: 'provider_quota', message: 'secret provider detail', retryable: false } }, 503));
    await expect(api.createSession('an')).rejects.toMatchObject({ code: 'provider_quota', message: 'The server could not complete the voice request.', retryable: false });
  });
});
