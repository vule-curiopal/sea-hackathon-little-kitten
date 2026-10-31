import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceClientError } from '@miu/voice-client';
import { voiceErrorKey } from './voice-errors.ts';

test('unrecognized speech offers another held recording without blaming microphone permission', () => {
  assert.equal(voiceErrorKey({ code: 'unclear_audio', status: 422, retryable: false }), 'voiceUnclear');
  assert.equal(voiceErrorKey({ code: 'NO_AUDIO' }), 'voiceNoSignal');
  assert.equal(voiceErrorKey({ code: 'MIC_PERMISSION_DENIED' }), 'voiceDenied');
});

test('provider outages and exhausted quota do not suggest reconnecting or typing as a workaround', () => {
  for (const code of ['provider_quota_exceeded', 'provider_rate_limited', 'provider_timeout', 'provider_unavailable', 'audio_probe_unavailable', 'audio_probe_timeout']) {
    assert.equal(voiceErrorKey({ code, status: 429 }), 'voiceServiceUnavailable');
  }
  assert.equal(voiceErrorKey({ code: 'NETWORK_ERROR' }), 'voiceOffline');
  assert.equal(voiceErrorKey({ code: 'unauthorized', status: 401 }), 'voiceSessionExpired');
  assert.equal(voiceErrorKey(new VoiceClientError('CANCELED', 'Canceled')), null);
});
