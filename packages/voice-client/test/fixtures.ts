import { DEFAULT_VOICE, type CapturedAudio, type SessionResponse, type TurnResponse } from '../src/index.js';

export function session(): SessionResponse {
  return {
    session_id: '8a79daf0-95ca-49db-a11e-2ff09fccad77', demo_token: 'test-demo-token',
    clock_version: 1, state_version: 1, provider_mode: 'fake', engine_mode: 'voice_stub',
    effective_now: '2026-10-31T09:00:00+07:00',
    configuration: { personality: 'ENFP', role: 'friend', language_mode: 'vi', voice_id: DEFAULT_VOICE.vi },
  };
}
export function turn(requestId = '34fdfe4e-056b-4a33-9fab-92c20a62eb22'): TurnResponse {
  return {
    session_id: session().session_id, turn_id: requestId, sequence: 1, state_version: 2, clock_version: 1,
    provider_mode: 'fake', engine_mode: 'voice_stub', fixture_id: 'voice_sample_vi',
    transcript: { text: 'Chào Miu.', language: 'vi', uncertain_spans: [] },
    reply: { text: 'Chào bạn!', sentences: ['Chào bạn!'], language: 'vi' },
    audio: { mime_type: 'audio/wav', data_base64: 'dGVzdCBhdWRpbw==', duration_ms: 1000 },
    presentation: null, face: null, memory: null,
    timings_ms: { stt: 0, reply: 0, validation: 0, tts: 0, server_total: 0 },
  };
}
export function captured(): CapturedAudio {
  return { blob: new Blob(['recorded audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', durationMs: 1000, reason: 'manual', settings: {} };
}
