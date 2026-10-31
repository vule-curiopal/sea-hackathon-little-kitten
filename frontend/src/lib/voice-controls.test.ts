import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartVoice, microphoneControl } from './voice-controls.ts';

test('a held permission request stays releasable without inviting speech before the recorder is ready', () => {
  const pending = microphoneControl('recording', 'requesting_permission', true, true);
  assert.equal(pending.holding, true);
  assert.equal(pending.preparing, true);
  assert.equal(pending.ready, false);
  assert.equal(pending.disabled, false, 'release must still cancel a pending permission request');
  assert.equal(pending.label, 'voicePreparing');
  assert.equal(pending.text, 'voicePreparingShort');
  const ready = microphoneControl('recording', 'recording', true, true);
  assert.equal(ready.holding, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.preparing, false);
  assert.equal(ready.disabled, false);
  assert.equal(ready.text, 'voiceSpeakShort');
});

test('the microphone protects processing and speaking; stopping is an explicit separate action', () => {
  for (const state of ['processing', 'speaking'] as const) {
    const control = microphoneControl(state, 'idle', true, false);
    assert.equal(control.disabled, true);
    assert.equal(control.holding, false);
    assert.equal(control.busy, true);
    assert.notEqual(control.icon, 'stop');
    assert.notEqual(control.label, 'voiceStop');
    assert.equal(canStartVoice(state, true), false);
  }
});

test('new recording starts only from a connected idle/error state, never during setup or delivery', () => {
  for (const state of ['initializing', 'recording', 'processing', 'speaking', 'playback_blocked'] as const) {
    assert.equal(canStartVoice(state, true), false);
  }
  for (const state of ['idle', 'error'] as const) {
    assert.equal(canStartVoice(state, true), true);
    assert.equal(canStartVoice(state, false), false);
  }
  assert.equal(microphoneControl('recording', 'finalizing_capture', true, true).disabled, true);
});

test('blocked playback and visible reading acknowledgments remain actionable', () => {
  const audio = microphoneControl('playback_blocked', 'idle', true, true);
  assert.equal(audio.disabled, false);
  assert.equal(audio.label, 'voicePlay');
  assert.equal(audio.icon, 'play');
  const text = microphoneControl('playback_blocked', 'idle', true, true, true);
  assert.equal(text.disabled, false);
  assert.equal(text.label, 'doneReading');
  assert.equal(microphoneControl('initializing', 'idle', false, false).disabled, true);
  assert.equal(microphoneControl('idle', 'idle', false, false).label, 'voiceConnect');
});
