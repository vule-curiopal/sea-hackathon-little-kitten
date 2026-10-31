# Voice browser client

Framework-independent TypeScript helpers for the frontend colleague. This package supplies microphone capture, adaptive RMS endpoint detection, canonical API requests, playback and cancellation. It does not render a UI, contain provider secrets or add conversation memory.

## Integration

Use the package from the React/TypeScript frontend after the workspace has been built. Serve the frontend and `/api` through the same trusted HTTPS origin for the iPad demo (or configure the backend origin/CORS explicitly).

```ts
import { createVoiceClient, DEFAULT_VOICE } from '@miu/voice-client';

const voice = createVoiceClient();
const session = await voice.controller.openProfile('an', 'vi', DEFAULT_VOICE.vi);

const unsubscribe = voice.controller.subscribe(event => {
  // Render state/meter/turn/errors in the existing frontend; do not log audio or text.
  // event.type === 'capture' exposes calibration, RMS and thresholds.
});

// Call talk() directly inside the Talk tap/click handler so AudioContext can resume.
function onTalk() {
  return voice.controller.talk(session.provider_mode === 'fake'
    ? { fixtureId: 'voice_sample_vi' }
    : {});
}
function onSend() { voice.controller.send(); }
function onStop() { return voice.controller.stop(); }
function onExplicitPlay() { return voice.controller.resumePlayback(); }

// On unmount: unsubscribe(); await voice.controller.dispose();
```

Handle promise rejections with localized UI captions, including `CANCELED` (normal Stop), `NO_SIGNAL`, `MIC_PERMISSION_DENIED`, `INSECURE_CONTEXT` and service errors. No API key belongs in this package's options. In fake mode the fixture must be selected explicitly; audio is uploaded but the fixture, rather than arbitrary recording recognition, supplies the transcript and spoken output. Use `voice_sample_en` with an English session. A real session must not submit a fixture ID.

`VoiceController.talk()` resolves once a response has been returned and playback has started or is blocked. `playback_blocked` requires a fresh explicit Play gesture; successful provider output is not proof that audio played. Started/completed/interrupted receipts follow actual media events. Frontend observers can also subscribe directly to `capture` and `playback` if they need finer state transitions. All observer subscriptions return an unsubscribe function.

`stop()` stops local capture/playback synchronously and returns a promise for a separate server DELETE request. Catch a server cancellation failure while retaining the local stopped state. Every `talk()` returns its own promise; handle rejection on the old promise when a newer Talk cancels it. A late response cannot start stale playback. `close()` ends the session; `dispose()` additionally removes subscriptions.

## Capture and detector

- `BrowserVoiceCapture.start()` returns `Promise<CapturedAudio>`. `send()` finalizes manually even if no signal was detected; `cancel()` discards. Finalized audio contains the recorder's real MIME and original bytes.
- The recorder uses the same microphone stream as the RMS analyser, chooses MP4/AAC or WebM using feature detection, and waits for the final data event before producing a blob.
- `AdaptiveSilenceDetector` is pure and independently testable with `update(levelDbfs, monotonicTimeMs)`. Defaults: 750 ms calibration, 120 ms signal confirmation, 1500 ms silence, initial wait 5000 ms after calibration, 30000 ms total recording, cancellation on analysis gaps over 250 ms. Thresholds are relative to a smoothed noise floor and freeze after signal confirmation. Sound energy is not speech recognition.
- Capture options can override detector thresholds, microphone constraints and MIME candidates. Keep browser/server upload limits consistent with shared `LIMITS`.
- For hold-to-talk, create the client with `capture: { endpointing: 'manual' }`. Call `talk()` on press and `send()` on release. Silence does not finalize or cancel capture in this mode; metering continues until release. A release while permission is pending cancels and closes any late-granted stream. The maximum recording duration cancels with `RECORDING_LIMIT` rather than auto-uploading. The default `automatic` mode retains adaptive endpointing for existing clients.
- Permission, backgrounding, track end and interrupted AudioContext states have explicit cleanup. The application does not automatically reopen capture when returning to the foreground. Meter failure falls back to manual Send; recorder failure cancels the recording.

The UI owner must provide responsive portrait/landscape/split-view layouts and accessible Talk/Send/Stop/Play controls. Verify recording, RMS thresholds, playback permission and interruption on an actual iPad; fake-browser tests and desktop responsive previews do not establish iPad compatibility.

## Test scope

Run `npm test -- packages/voice-client/test` from the workspace root. Tests use deterministic sample levels, fake browser devices/schedulers and mocked HTTP; no paid provider calls, real microphone access or performance claims are involved.
