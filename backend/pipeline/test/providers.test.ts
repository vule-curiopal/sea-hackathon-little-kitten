import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_VOICE, LIMITS } from '@miu/voice-contracts';
import type { VoiceConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { AudioInput } from '../src/ports.js';

// Transport tests isolate the ffprobe subprocess; audio.test covers actual codecs.
vi.mock('../src/audio.js', () => ({
  inspectSynthesizedAudio: vi.fn(async (_bytes: Buffer, mimeType: string) => ({ mimeType, durationMs: 1350 })),
}));

import { createProviders, FIXTURE_TEXTS, validateReplyText } from '../src/providers/index.js';

interface Call { url: URL; init: RequestInit }
function transport(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: new URL(input instanceof Request ? input.url : String(input)), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}
function realConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return { ...loadConfig({ MIU_PROVIDER: 'real', ELEVENLABS_API_KEY: 'eleven-test-secret', OPENAI_API_KEY: 'openai-test-secret', ELEVENLABS_ENABLE_LOGGING: 'false' }), ...overrides };
}
const signal = () => new AbortController().signal;
const inputAudio: AudioInput = { bytes: Buffer.from([0, 255, 23, 0, 44, 128]), mimeType: 'audio/mp4', filename: 'turn.m4a', durationMs: 1500 };
const replyInput = (text = 'Hello!', language: 'vi' | 'en' = 'en') => ({ turnId: 'turn-current', text, language, kind: 'utterance' as const });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function reply(text = 'Hello! Shall we play?') {
  return { status: 'completed', error: null, incomplete_details: null, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] };
}
const body = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ElevenLabs batch STT', () => {
  it('preserves container bytes and MIME and sends fixed language plus explicit logging/format knobs', async () => {
    const http = transport(() => json({ text: ' Chào bạn! ', language_code: 'eng' }));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const result = await providers.transcribe(inputAudio, 'vi', signal());
    expect(result).toEqual({ text: 'Chào bạn!', language: 'vi' });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url.pathname).toBe('/v1/speech-to-text');
    expect(call.url.searchParams.get('enable_logging')).toBe('false');
    const headers = new Headers(call.init.headers);
    expect(headers.get('xi-api-key')).toBe('eleven-test-secret');
    expect(headers.has('Content-Type')).toBe(false); // fetch supplies multipart boundary.
    const form = call.init.body as FormData;
    expect(Object.fromEntries([...form.entries()].filter(([name]) => name !== 'file'))).toMatchObject({
      model_id: 'scribe_v2', file_format: 'other', language_code: 'vi', tag_audio_events: 'false',
      diarize: 'false', timestamps_granularity: 'none', no_verbatim: 'false',
    });
    const file = form.get('file') as File;
    expect(file.name).toBe('turn.m4a');
    expect(file.type).toBe('audio/mp4');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(inputAudio.bytes);
    expect(form.has('vad_threshold')).toBe(false);
    expect(form.has('filter_background_audio')).toBe(false);
  });

  it('sends logging=true only when explicitly configured', async () => {
    const http = transport(() => json({ text: 'Hello!' }));
    const providers = await createProviders(realConfig({ enableLogging: true }), http.fetchImpl);
    await providers.transcribe(inputAudio, 'en', signal());
    expect(http.calls[0]!.url.searchParams.get('enable_logging')).toBe('true');
  });

  it.each([{ text: '' }, { text: '  ' }])('rejects empty transcripts before dialogue: %j', async payload => {
    const http = transport(() => json(payload));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    await expect(providers.transcribe(inputAudio, 'vi', signal())).rejects.toMatchObject({ code: 'unclear_audio', status: 422 });
  });

  it.each([{}, { text: 123 }, { text: 'ok', language_code: {} }, { text: 'x'.repeat(LIMITS.transcriptChars + 1) }])('validates upstream transcript schema: %j', async payload => {
    const http = transport(() => json(payload));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    await expect(providers.transcribe(inputAudio, 'en', signal())).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 });
  });

  it('rejects oversized response bytes before JSON parsing', async () => {
    const http = transport(() => new Response('x'.repeat(512 * 1024 + 1)));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    await expect(providers.transcribe(inputAudio, 'en', signal())).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});

describe('stateless OpenAI reply adapter', () => {
  it('keeps API reasoning metadata out of spoken text and rejects reasoning-only output', async () => {
    let response = { ...reply(), output: [{ type: 'reasoning', summary: [] }, ...reply().output] };
    const http = transport(() => json(response));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    expect((await providers.response.generate(replyInput(), signal())).replyText).toBe('Hello! Shall we play?');
    response = { ...reply(), output: [{ type: 'reasoning', summary: [] }] };
    await expect(providers.response.generate(replyInput(), signal())).rejects.toMatchObject({ code: 'invalid_reply' });
  });

  it('serializes the official SDK request with no history, storage or tools, independently per turn', async () => {
    const http = transport(() => json(reply()));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const first = await providers.response.generate(replyInput('I like dinosaurs.'), signal());
    const second = await providers.response.generate({ ...replyInput('What can we play?', 'vi'), turnId: 'turn-next' }, signal());
    expect(first).toEqual({ turnId: 'turn-current', replyText: 'Hello! Shall we play?', language: 'en' });
    expect(second.turnId).toBe('turn-next');
    expect(second.language).toBe('vi');
    expect(http.calls).toHaveLength(2);
    const firstCall = http.calls[0]!;
    expect(firstCall.url.pathname).toBe('/v1/responses');
    expect(new Headers(firstCall.init.headers).get('Authorization')).toBe('Bearer openai-test-secret');
    expect(body(firstCall)).toMatchObject({
      model: 'gpt-6-luna', reasoning: { effort: 'none' }, store: false, stream: false, tools: [], max_output_tokens: 200,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'I like dinosaurs.' }] }],
    });
    expect(String(body(http.calls[1]!).instructions)).toContain('Vietnamese');
    expect(JSON.stringify(body(http.calls[1]!))).not.toContain('dinosaurs');
    for (const call of http.calls) {
      expect(body(call)).not.toHaveProperty('previous_response_id');
      expect(body(call)).not.toHaveProperty('conversation');
    }
  });

  it.each([
    { ...reply(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { ...reply(), status: 'failed', error: { message: 'raw upstream secret' } },
    { ...reply(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'refused' }] }] },
    { ...reply(), output: [{ type: 'function_call', name: 'write_memory', arguments: '{}' }] },
    reply(''), reply('Hello! One. Two. Three.'), reply('What? Why?'), reply('[whisper] Hello.'), reply('**Hello!**'),
  ])('rejects incomplete, refusal, actions or non-spoken output', async payload => {
    const http = transport(() => json(payload));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    await expect(providers.response.generate(replyInput(), signal())).rejects.toMatchObject({ code: 'invalid_reply', status: 503 });
    expect(http.calls).toHaveLength(1);
  });

  it('does not retry OpenAI errors and never returns upstream bodies or credentials', async () => {
    const logs = [vi.spyOn(console, 'error').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined), vi.spyOn(console, 'log').mockImplementation(() => undefined)];
    const http = transport(() => json({ error: { message: 'raw body eleven-test-secret openai-test-secret', type: 'authentication_error' } }, 401));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const error = await providers.response.generate(replyInput(), signal()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'provider_unavailable', status: 503, retryable: false });
    expect(String(error)).not.toMatch(/raw body|test-secret/u);
    expect(http.calls).toHaveLength(1);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe('ElevenLabs synthesis', () => {
  it('uses the selected allowlisted voice and full approved text, returns bounded MP3 with probed duration', async () => {
    const audio = Buffer.from('ID3-test-mp3-payload');
    const http = transport(() => new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } }));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const output = await providers.synthesize('Chào bạn! Mình chơi nhé?', DEFAULT_VOICE.vi, 'vi', signal());
    expect(output).toEqual({ bytes: audio, mimeType: 'audio/mpeg', durationMs: 1350 });
    const call = http.calls[0]!;
    expect(call.url.pathname).toBe(`/v1/text-to-speech/${DEFAULT_VOICE.vi}`);
    expect(call.url.searchParams.get('output_format')).toBe('mp3_44100_128');
    expect(call.url.searchParams.get('enable_logging')).toBe('false');
    expect(body(call)).toEqual({
      text: 'Chào bạn! Mình chơi nhé?', model_id: 'eleven_flash_v2_5', language_code: 'vi',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 0.95 },
      apply_text_normalization: 'auto', apply_language_text_normalization: false,
    });
  });

  it('blocks wrong-language or unknown voices and unvalidated text without making a request', async () => {
    const http = transport(() => { throw new Error('Unexpected fetch'); });
    const providers = await createProviders(realConfig(), http.fetchImpl);
    await expect(providers.synthesize('Hello!', DEFAULT_VOICE.vi, 'en', signal())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(providers.synthesize('Hello!', 'user-controlled-voice', 'en', signal())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(providers.synthesize('[laughs] Hello!', DEFAULT_VOICE.en, 'en', signal())).rejects.toMatchObject({ code: 'invalid_reply' });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }),
    () => new Response('x', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(LIMITS.audioBytes + 1) } }),
    () => new Response('raw eleven-test-secret', { status: 503 }),
  ])('rejects bad, empty, oversized or failed audio responses', async response => {
    const http = transport(response);
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const error = await providers.synthesize('Hello!', DEFAULT_VOICE.en, 'en', signal()).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain('test-secret');
    expect(http.calls).toHaveLength(1);
  });
});

describe('provider cancellation and deadlines', () => {
  it('fails fast on a canceled caller without touching the transport', async () => {
    const http = transport(() => { throw new Error('Unexpected fetch'); });
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const controller = new AbortController(); controller.abort();
    await expect(providers.transcribe(inputAudio, 'en', controller.signal)).rejects.toMatchObject({ code: 'turn_canceled', status: 409 });
    await expect(providers.response.generate(replyInput(), controller.signal)).rejects.toMatchObject({ code: 'turn_canceled', status: 409 });
    await expect(providers.synthesize('Hello!', DEFAULT_VOICE.en, 'en', controller.signal)).rejects.toMatchObject({ code: 'turn_canceled', status: 409 });
    expect(http.calls).toHaveLength(0);
  });

  it.each(['stt', 'reply', 'tts'] as const)('cancels %s even when transport ignores abort', async stage => {
    const http = transport(() => new Promise<Response>(() => undefined));
    const providers = await createProviders(realConfig(), http.fetchImpl);
    const controller = new AbortController();
    const pending = stage === 'stt' ? providers.transcribe(inputAudio, 'en', controller.signal) : stage === 'reply' ? providers.response.generate(replyInput(), controller.signal) : providers.synthesize('Hello!', DEFAULT_VOICE.en, 'en', controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'turn_canceled', status: 409 });
    controller.abort();
    await assertion;
  });

  it.each(['stt', 'reply', 'tts'] as const)('enforces the %s stage timeout without retrying', async stage => {
    vi.useFakeTimers();
    const http = transport(() => new Promise<Response>(() => undefined));
    const providers = await createProviders(realConfig({ sttTimeoutMs: 20, replyTimeoutMs: 20, ttsTimeoutMs: 20 }), http.fetchImpl);
    const pending = stage === 'stt' ? providers.transcribe(inputAudio, 'en', signal()) : stage === 'reply' ? providers.response.generate(replyInput(), signal()) : providers.synthesize('Hello!', DEFAULT_VOICE.en, 'en', signal());
    const assertion = expect(pending).rejects.toMatchObject({ code: 'provider_timeout', status: 504 });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(http.calls.length).toBeLessThanOrEqual(1);
  });

  it('refuses real mode without an explicit logging choice', async () => {
    const http = transport(() => { throw new Error('Unexpected fetch'); });
    await expect(createProviders(realConfig({ enableLogging: undefined }), http.fetchImpl)).rejects.toMatchObject({ code: 'provider_configuration' });
    expect(http.calls).toHaveLength(0);
  });
});

describe('spoken-text validation', () => {
  it('returns one to three spoken sentences and respects Unicode character count', () => {
    expect(validateReplyText('Chào bạn! Mình chơi nhé?')).toEqual(['Chào bạn!', 'Mình chơi nhé?']);
    expect(validateReplyText(FIXTURE_TEXTS.en)).toHaveLength(3);
    expect(validateReplyText(FIXTURE_TEXTS.vi)).toHaveLength(3);
    expect(validateReplyText('a'.repeat(400))).toHaveLength(1);
    expect(() => validateReplyText('a'.repeat(401))).toThrow('invalid_reply');
  });
  it.each(['', '???', '😊', 'Hi 😊.', '# Hello', '- Hello', '(whispers) Hello.', 'Hello? Why?', 'One. Two. Three. Four.'])('rejects non-spoken or out-of-bounds text %s', text => {
    expect(() => validateReplyText(text)).toThrow('invalid_reply');
  });
});

describe('declared fake voice fixtures', () => {
  it.each(['vi', 'en'] as const)('uses matching declared transcript/reply/real WAV fixture for %s', async language => {
    const http = transport(() => { throw new Error('Fake mode must not fetch'); });
    const providers = await createProviders(loadConfig({ MIU_PROVIDER: 'fake' }), http.fetchImpl);
    const fixtureId = `voice_sample_${language}`;
    const transcript = await providers.transcribe(inputAudio, language, signal(), fixtureId);
    expect(transcript).toEqual({ text: FIXTURE_TEXTS[language], language });
    const generated = await providers.response.generate({ ...replyInput(transcript.text, language), fixtureId }, signal());
    expect(generated.replyText).toBe(FIXTURE_TEXTS[language]);
    const spoken = await providers.synthesize(generated.replyText, DEFAULT_VOICE[language], language, signal(), fixtureId);
    const fixture = await readFile(new URL(`../fixtures/${language}.wav`, import.meta.url));
    expect(spoken.bytes).toEqual(fixture);
    expect(spoken.mimeType).toBe('audio/wav');
    expect(spoken.durationMs).toBeGreaterThan(1000);
    expect(spoken.durationMs).toBeLessThan(10000);
    expect(http.calls).toHaveLength(0);
    expect(providers.mode).toBe('fake');
  });

  it('requires a fixture and rejects unknown/mismatched IDs or text/audio mismatches', async () => {
    const providers = await createProviders(loadConfig({ MIU_PROVIDER: 'fake' }));
    await expect(providers.transcribe(inputAudio, 'en', signal())).rejects.toMatchObject({ code: 'missing_fixture' });
    await expect(providers.transcribe(inputAudio, 'vi', signal(), 'voice_sample_en')).rejects.toMatchObject({ code: 'unknown_fixture' });
    await expect(providers.response.generate({ ...replyInput(), fixtureId: 'not-a-fixture' }, signal())).rejects.toMatchObject({ code: 'unknown_fixture' });
    await expect(providers.synthesize('Different words.', DEFAULT_VOICE.en, 'en', signal(), 'voice_sample_en')).rejects.toMatchObject({ code: 'invalid_reply' });
  });
});
