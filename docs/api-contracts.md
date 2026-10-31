# Miu shared API contracts

These are proposed contracts for the [frontend](frontend.md), [pipeline](pipeline.md), [character engine](character-engine.md), and [memory service](memory-and-time.md). All identifiers shown in examples are illustrative. Use opaque UUIDs in implementation.

## Common rules

- Prefix routes with `/api`; return JSON except for the multipart turn request.
- The integrated server resolves an account's profile from its HttpOnly session cookie. A server-issued engine bearer identifies the conversation and independently requires the matching owner cookie. Guest profiles are isolated. Never trust a model-generated or caller-supplied profile ID for authorization.
- The browser generates a unique `request_id` for each mutation. A turn's `turn_id` equals its `request_id`. Retries use the same ID; a different body with the same ID returns `409 idempotency_conflict`.
- A profile permits only one active turn or greeting. A second request returns `409 turn_in_progress` until the first finishes or is canceled.
- Cancellation is authorized by the same profile/session token and may arrive before an upload is accepted. Keep bounded transient cancellation/idempotency metadata keyed by session and turn ID so a late-arriving canceled upload cannot start work. Protocol metadata is not conversation memory.
- Responses include `clock_version` and `state_version`. A canceled turn, closed session, profile switch, deletion, or newer clock/state invalidates obsolete work. The server rechecks versions before response publication and writes.
- No API response or panel payload contains credentials, a full internal prompt, raw provider output, or raw microphone audio.

### First voice-only implementation

The root integrated server now also supports `engine_mode: "character_memory"`. It returns the actual character engine's presentation/face/memory metadata and uses its persistent state and clock versions. JSON turns can contain `text` instead of audio. An explicit `text_only: true` returns `audio: null`; the client acknowledges visible delivery with ordered playback receipts and `played_ms: 0`. Audio turns continue to require actual media playback events. The adult panel exposes the selected profile's current state, and Next day runs the shared idempotent memory job. Historical generated dialogue remains separate archive evidence.

The Express 5/TypeScript voice package on Node.js implements the session/configuration, turn, cancellation and playback routes, plus `GET /api/health` and `GET /api/voices`. Feature routers/controllers delegate to `TurnService` and `SessionService`; the RAM repository and provider adapters are separate modules. See [backend architecture](voice-pipeline/backend-architecture.md). This internal structure preserves the public HTTP contract.

It explicitly returns `engine_mode: "voice_stub"`. In this mode only, `presentation`, `face` and `memory` are `null`, and playback receipts return `learning_status: "disabled"`. The temporary generator is stateless; session/turn/idempotency metadata is protocol state and is never sent as dialogue history. The full character/memory envelope below remains the integration target for those workstreams; null fields do not claim those features are implemented.

Session creation and configuration mutations include a UUID `request_id`, following the common idempotency rule. Supported demo profile keys are `an` and `binh`. The default server binds localhost; demo tokens are fixture access, not production authentication. The voice package keeps at most100 turn records per session and only one cached result, replayable for five minutes. Older completed results return409 without re-running providers; ending/expiring a session clears content and records. Clients must not retry after the session expires.

## Routes

| Method and path | Purpose |
| --- | --- |
| `POST /api/sessions` | Create an account-owned or isolated guest session; return profile token, session ID, configuration, versions, and effective time |
| `PATCH /api/profiles/current/config` | Set one MBTI type, role, language mode, and approved voice; reject changes during an active turn |
| `POST /api/sessions/{session_id}/turns` | Complete one utterance or explicitly requested greeting; return approved speech audio and face plan |
| `DELETE /api/sessions/{session_id}/turns/{turn_id}` | Idempotently cancel a pending turn and prevent queued state transitions |
| `POST /api/sessions/{session_id}/turns/{turn_id}/playback` | Idempotently report `started`, `completed`, or `interrupted` playback |
| `DELETE /api/sessions/{session_id}` | End session, cancel pending work, and discard session conversation text |
| `GET /api/demo/panel` | Read the current fictional profile's state and pipeline diagnostics |
| `POST /api/demo/clock` | Set a later time within the current narrative day; use Next day to cross a date boundary |
| `POST /api/demo/next-day` | Advance one local date and run the shared night job exactly once |
| `POST /api/demo/reset` | Clear fictional demo state and restore fixtures after explicit panel action |

Demo routes are available only in demo mode for the selected fictional profile. They return `404` when demo mode is disabled. Text commands such as “forget that” travel through the turn endpoint; the memory service executes them before any forgetting acknowledgment is generated.

## Session and configuration setup

The integrated server accepts `demo_profile_key: "account"` with an authenticated cookie and selects that account's profile on the server. Explicit `guest`, or unauthenticated legacy `an`/`binh` selectors, create a fresh isolated guest profile. They cannot reopen a seeded account or choose an arbitrary database profile. Subsequent requests use `Authorization: Bearer <demo_token>`; account-owned operations also require the matching owner cookie, including client diagnostics. A turn requires an open session belonging to that profile.

The standalone voice package retains fictional fixture selectors for development. Its fixture token alone does not replace the integrated server's account authentication.

Configuration patches accept only `personality` (one of the 16 allowed MBTI codes), `role` (`friend`, `big_sibling`, `teacher`), `language_mode` (`vi`, `en`, `follow_child`), and `voice_id` from a server allowlist. Reject unknown fields and incompatible voice/language choices. The server returns the effective configuration and new state version; it does not accept raw prompts or safety overrides.

For the first batch voice demo, choose `language_mode=vi` or `en` before the session's first recording. Use this fixed mode for recognition hints, reply generation, fallback text and synthesis; `follow_child` remains part of the broader product contract but is outside this first voice demo. A `language_hint` cannot override the configured mode.

## Realtime speech turn

The real-provider default is ElevenLabs realtime STT with VAD and background filtering. The existing HTTP batch/text turn route remains available. See the [implementation guide](voice-pipeline/elevenlabs-realtime.md).

1. `GET /api/voice/capabilities` returns `input_mode`, `realtime_available`, `silence_ms`, `filter_background_audio`, and `max_recording_ms`.
2. Connect to `WSS /api/sessions/{session_id}/speech-stream`, using a trusted origin. The first text frame, within 5s, is `{ "type": "stream.start", "token": "<demo_token>", "request_id": "<uuid>", "language": "vi" }`. No tokens in the URL. Authentication and a per-profile input reservation precede any upstream connection.
3. Wait for `stream.ready`. Audio frames are binary: a 4-byte **unsigned little-endian sequence number**, starting at zero, followed by mono signed PCM16 little-endian at 16kHz. Target 200ms/6,400 PCM bytes per frame; maximum 32,000 PCM bytes per frame and 960,000 PCM bytes/30s per turn.
4. `transcript.partial` replaces the temporary text; `transcript.segment` reports a settled segment. Neither dispatches the response engine. Provider VAD can emit `turn.end_candidate` after 3s of no speech.
5. On an end candidate or manual Send, stop/flush microphone processing, send the last PCM frame, then `{ "type": "audio.end", "last_seq": 12 }`. The last sequence must exactly match the final audio frame. This message requests finalization on the same socket.
6. Backend sends a final provider commit and waits for its committed acknowledgement. An empty acknowledgement is valid for a silence-only tail. Only then emit `stream.drained`, `transcript.final` with the full text, and `stream.processing`, and dispatch the complete utterance once to the existing engine/GPT. No batch retranscription or client-supplied transcript is used.
7. `turn.result` contains `response: TurnResponse`, with `input_mode: "realtime_stt"` and the existing transcript/reply/audio/version/engine metadata. The WebSocket closes normally after delivery. Playback uses the existing HTTP receipt route.
8. `stream.cancel`, existing `DELETE /api/sessions/{session_id}/turns/{request_id}`, disconnection, invalid sequences, hard limits or `stream.error` abort work and release the reservation. Error frames contain only a stable `code`. A timeout or abrupt socket close is never a successful end-of-turn signal. No automatic reconnect/replay.

One stream/turn per profile; configuration and clock changes cannot compete with a capturing reservation. Maximum silence without recognized text is 8s, accounting for provider startup; final-drain timeout is 10s. A 30s recording limit rejects an unfinished turn rather than sending a fragment to the engine. Input buffers are ephemeral, not conversation memory. Server shutdown closes upgraded sockets as well as HTTP requests.

Account streams recheck the owner cookie before starting upstream STT and before final audio dispatch; logout or a different owner's cookie cannot use a retained engine bearer. Only isolated `guest_` profiles bypass account authentication. Per-client connection limits honor a validated forwarded IP only when explicit loopback-proxy trust is enabled.

These stream event names belong to Miu. ElevenLabs returns segment commits; Miu produces the utterance-level `transcript.final`. Local VAD model input is deferred.

## Voice-turn request

`POST /api/sessions/{session_id}/turns`, `Content-Type: multipart/form-data`:

| Field | Required | Meaning |
| --- | --- | --- |
| `request_id` | Yes | Unique turn ID and idempotency key |
| `kind` | Yes | `utterance` or `greeting` |
| `audio` | For utterance | Complete microphone blob; accept MP4/AAC (`audio/mp4`, including M4A), WebM/Opus or WAV; preserve actual MIME/container and return `415` for unsupported formats |
| `language_hint` | No | `vi`, `en`, or `auto`; preference, not an override of server configuration |
| `fixture_id` | Fake utterances only | Declared deterministic scenario; reject in real mode |

First voice-demo limits: 30 seconds and 5 MiB of audio per recording; cap the complete multipart request at 6 MiB to leave room for metadata and boundaries. Duration includes initial noise calibration. Validate duration/container metadata within bounded resources; do not infer compressed-audio duration from byte count. Browser and server limits must agree. A greeting has no audio and is allowed once at initial entry or explicit return after rollover. It is initiated by a user action, not a background push. It skips STT and creates a synthetic greeting intent; director, safety, and TTS still run.

The browser selects a recording MIME through runtime capability detection and submits the finalized blob after the last recorder data event. Safari/iPad is not restricted to the previous WebM/WAV list. For the ElevenLabs batch adapter, forward original container bytes with `file_format=other`; do not label MP4/WebM as raw PCM or add an isolation/transcoding stage to the first demo. Supported provider audio types: [ElevenLabs speech-to-text](https://elevenlabs.io/docs/overview/capabilities/speech-to-text).

Capture stops at30 seconds of wall time. Server inspection permits at most250ms of compressed MP4/WebM encoder padding while reporting actual media duration; WAV stays strict30 seconds. Probe work is bounded, RAM-only and cancellable. `ffprobe` is a runtime dependency for compressed input and synthesized MP3; missing inspection support fails closed rather than trusting a filename or skipping duration checks.

For no-microphone accessibility testing, the same endpoint may accept a `text` field instead of audio, with `input_mode=text` explicitly marked in diagnostics. Audio and text are mutually exclusive. The voice acceptance test always submits real recorded bytes; the text path cannot substitute for it.

## Successful turn response

```json
{
  "session_id": "session-demo-2",
  "turn_id": "turn-demo-7",
  "sequence": 1,
  "clock_version": 2,
  "state_version": 8,
  "provider_mode": "fake",
  "transcript": null,
  "reply": {
    "text": "Did Mochi get a bath?",
    "sentences": ["Did Mochi get a bath?"],
    "language": "en"
  },
  "presentation": {
    "emotion": "curious",
    "daily_mood": "content",
    "rhythm": "morning",
    "delivery": "gentle",
    "allow_giggle": false,
    "allow_purr": false
  },
  "audio": {
    "mime_type": "audio/wav",
    "data_base64": "<base64-encoded approved speech>",
    "duration_ms": 1450
  },
  "face": {
    "expression": "curious",
    "mouth_mode": "audio_amplitude",
    "gesture": "head_tilt",
    "gesture_offset_ms": 100
  },
  "memory": {
    "reference_id": "followup-mochi-1",
    "learning_status": "awaiting_playback"
  },
  "timings_ms": {
    "server_total": 680,
    "stt": 0,
    "classify": 0,
    "director": 20,
    "reply": 10,
    "safety": 10,
    "tts": 40
  }
}
```

For an utterance, `transcript` is `{ "text": "My dog Mochi fell in a puddle", "language": "en", "uncertain_spans": [] }`. For greetings it is `null`. `reference_id` is nullable and is a server-owned deletion/reference handle, not a second memory to render. These timing values are example fixture values, not a benchmark; stage timings exclude transport and other overhead.

Inline base64 audio avoids an extra media-fetch round trip in the MVP. Send it only after the entire text passes safety. Keep responses bounded by the short-speech rule. A later binary or streaming protocol must preserve the same cancellation and validation boundaries.

`audio.mime_type` describes the actual synthesized bytes, not a fixed WAV requirement: the ElevenLabs MP3 path returns `audio/mpeg`; bundled fixtures may return `audio/wav`. Decode `data_base64` using this MIME and never relabel MP3 bytes as WAV. The response envelope, face/state ownership and playback-receipt routes stay the same; a temporary voice response adapter supplies text/audio and does not fabricate character or memory state.

## Playback receipt

```json
{
  "request_id": "receipt-demo-7",
  "status": "completed",
  "played_ms": 1450,
  "state_version": 8
}
```

The server enforces receipt order and legal transitions. A completed receipt schedules turn learning once; a canceled turn cannot later become completed. A started receipt marks the selected hook as presented, so it is not repeatedly asked if the audio is interrupted. An interrupted response is excluded from claimed shared experiences and assistant-self learning. An already completed turn is not undone by a late cancellation.

Each receipt event uses its own request ID. A `started` receipt may also carry `client_audio_start_latency_ms`, measured from recording end with the browser's monotonic clock, and `autoplay_blocked`. Treat client timing as diagnostic input, not trusted authorization or a server timeout clock. Greetings report a separate action-to-audio time rather than a recording-based metric.

The server's response to `completed` includes `learning_status: pending|complete`. The frontend polls panel state in demo mode to observe completion; normal child interaction need not wait for the panel. A response that was returned but never played must not be recorded as a promise the child heard. Pending learning is bounded and deduplicated by turn ID.

## Next day request and response

```json
{
  "request_id": "next-day-demo-1",
  "expected_clock_version": 1
}
```

```json
{
  "effective_now": "2026-11-01T09:00:00+07:00",
  "local_date": "2026-11-01",
  "clock_version": 2,
  "job_id": "night-demo-1",
  "job_status": "complete",
  "previous_session_closed": true,
  "state_version": 7
}
```

The operation refuses to advance while a turn is active or accepted learning remains pending: `409 turn_in_progress` or `409 learning_pending`, with no clock change. After success the frontend creates a new session, then explicitly requests its greeting. Repeating the same request returns the same result and does not advance a second date. A stale clock version returns `409 stale_clock`.

## Error response

```json
{
  "error": {
    "code": "provider_timeout",
    "message": "Miu needs a moment. Please try again.",
    "retryable": true
  },
  "turn_id": "turn-demo-8"
}
```

| Status | Codes and handling |
| --- | --- |
| `400` | `invalid_request`, `missing_fixture`; no data changed |
| `401` / `403` | Missing demo profile token or wrong session/profile; no data disclosed |
| `409` | `turn_in_progress`, `learning_pending`, `stale_clock`, `stale_state`, `session_closed`, `idempotency_conflict` |
| `413` / `415` | Recording too large or unsupported format; release local microphone and show retry |
| `422` | `unclear_audio`, `unknown_fixture`; no invented transcript or memory |
| `503` / `504` | Provider unavailable, failed validation service, memory unavailable for a required operation, or timeout |

A content refusal can be a successful response containing approved localized speech. A technical error may return JSON without audio; the frontend may use a bundled neutral error clip. It must not disguise an error clip as the requested answer or a successful deletion.

Ambiguous forgetting is a normal spoken clarification with no deletion, not a technical error. Only a resolved, successful delete authorizes a forgetting acknowledgment.
