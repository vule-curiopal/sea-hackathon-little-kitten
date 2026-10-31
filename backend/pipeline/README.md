# Miu batch voice pipeline

Express 5 + TypeScript backend on Node.js for the user's voice scope. One authenticated turn endpoint runs **audio → ElevenLabs batch STT → stateless GPT → checked plain text → ElevenLabs TTS**. The response uses the shared envelope and inline base64 audio. Engine/personality/memory features remain owned by the other workstreams.

## Architecture

`app.ts` composes dependencies and registers Express middleware/routers. Feature modules live in `src/modules`: session routes/controllers call `SessionService`, backed by `InMemorySessionRepository`; turn routes/controllers call the HTTP-independent `TurnService`. STT/TTS/OpenAI adapters live separately under `src/providers`, behind the ports in `src/ports.ts`. `src/http` owns request parsing, memory uploads and sanitized errors. See [backend architecture](../../docs/voice-pipeline/backend-architecture.md) for the full dependency map and engine handoff.

`buildApp()` returns an Express app; `createServer(app)` from `src/server-runtime.ts` owns Node HTTP listening and shutdown. Close the runtime to abort pending work, clear session timers/state and release connections. `src/state.ts` only re-exports compatibility names for existing callers.

## Run

Requires Node **22.19+**. MP4/WebM input and real MP3 output probing also require `ffprobe` on PATH (or `FFPROBE_PATH`); WAV fixtures are inspected in memory. No user audio is written to disk.

```powershell
npm ci
npm run build
npm test
npm run smoke
npm run dev
```

API defaults to `http://127.0.0.1:3001`; health: `GET /api/health`; public voice catalog: `GET /api/voices`. `npm run dev` loads the existing root `.env` but **does not modify it**. With no explicit `MIU_PROVIDER=real`, only fake providers run. See the root `.env.example` for configuration.

For an iPad on another device, serve the frontend on trusted HTTPS and proxy `/api` to this server. The frontend and backend must agree on allowed origins. HTTP on a laptop's LAN address does not give an iPad microphone secure context. Manual deployment files for the frontend/API at `miu.curiopal.com`, isolated services and HTTPS are in [deploy/miu](../../deploy/miu/README.md). Behind the localhost proxy, set `TRUST_PROXY_LOOPBACK=true` and overwrite forwarded headers as shown there; the default stays false for direct local development.

## HTTP contract

1. `POST /api/sessions` JSON `{ "request_id": "<uuid>", "demo_profile_key": "an" }` (`binh` also allowed).
2. Use returned `demo_token` as `Authorization: Bearer <token>`.
3. `PATCH /api/profiles/current/config` JSON `{ "request_id": "<new-uuid>", "language_mode": "vi" }` before recording. Voice defaults follow the language; explicit voices must belong to that language's allowlist. Settings cannot change while a turn is active.
4. `POST /api/sessions/{session_id}/turns`, multipart fields `request_id`, `kind=utterance`, `audio`, optional matching `language_hint`, and **`fixture_id=voice_sample_vi|voice_sample_en` in fake mode only**.
5. Decode `audio.data_base64` using its actual `audio.mime_type`; report actual playback to `POST .../turns/{turn_id}/playback` with its own UUID, `status`, `played_ms`, and returned `state_version`.
6. Stop immediately locally; abort the pending fetch **and** call `DELETE .../turns/{turn_id}` using a fresh request signal. `DELETE /api/sessions/{session_id}` closes a session.

The same request ID/body is idempotent, including a cancellation arriving before upload. A reused ID with different content returns409. A pending duplicate returns409 rather than running a second provider call. Idempotency records are bounded to100 turns/session; only the latest result is replayable, for up to5 minutes. Older completed results return409 without calling providers again. Sessions expire after30 minutes inactivity. Results and protocol state are RAM-only and cleared on session end/restart; they are not passed to GPT as history.

Input accepts actual PCM WAV, MP4/AAC, and WebM/Opus; 30-second capture, 5MiB audio, 6MiB multipart. Compressed encoder padding has a small explicit tolerance documented in `audio.ts`. The server checks actual format/codec/duration, not just extension, and forwards original bytes unchanged. It rejects unsupported or corrupt input before STT.

## Voice-only extension of the shared envelope

`engine_mode: "voice_stub"` explicitly reports that `presentation`, `face`, and `memory` are `null`. No character state or successful learning is fabricated. Playback returns `learning_status: "disabled"`. The demo panel reports `memory_available: false`. Memory, diary/clock advancement, relationship and activity endpoints are not implemented by this package.

MBTI/role values are validated and held as configuration for the future engine; the temporary stateless adapter does not implement those personality behaviors. It uses only the current transcript and fixed Miu instructions. Replace `PipelineProviders.response` / `ResponseGenerator` via `buildApp({providers})` to integrate the real engine; STT/TTS and the HTTP surface remain separate adapters.

Fake mode has declared spoken fixtures copied from the reference project. The recordings say **Buddy**, not Miu: they are labeled reference voice samples for audio wiring, never claimed as generated answers or offline recognition. Their exact text/source is in [fixtures/README.md](fixtures/README.md). Provider calls are mocked in tests; localhost HTTP and TCP are exercised with real listeners. Smoke exercises both fixture languages without API keys or spending credits.

## Real mode

Keep existing keys in local `.env`. Configure `MIU_PROVIDER=real`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` and an **explicit** `ELEVENLABS_ENABLE_LOGGING=true|false` after checking D10/account data handling. A false flag alone does not verify eligibility for zero retention. Real mode refuses to start if the choice or keys are missing; errors never print key values.

Defaults: STT `scribe_v2`, GPT `gpt-6-luna`/effort none/200tokens/store false/no tools/no previous response, TTS `eleven_flash_v2_5`/MP3, Vietnamese Phan Anh and English Little DudeII. Provider client retries are disabled; per-stage deadlines10s and total processing deadline20s are error bounds, not the5s latency target. Cancellation discards late results even if an upstream service continues processing.

Real API calls and iPad microphone/playback have **not** been validated by mock tests. Benchmark first audible approved output on the real iPad/network separately; include endpointing, recorder flush/upload and playback permission effects. The temporary prompt/output-format gate is not the team's complete child-safety engine. Use fictional data and adult testers in this stage as the product docs specify.
