# Sea Hackathon Little Kitten

Miu is a Vietnamese–English voice toy for children ages 4–8, featuring a talking kitten with personality, expressive behavior, and shared memories.

## Project structure

```text
backend/
  character/
  memory/
  pipeline/
design/
docs/
  README.md
  product-specification.md
  frontend.md
  pipeline.md
  character-engine.md
  memory-and-time.md
  api-contracts.md
frontend/
packages/
  voice-client/
  voice-contracts/
scripts/
test-assets/
  voice-pipeline/
```

See the [product specification](docs/product-specification.md) for the product scope and the [implementation workstreams](docs/README.md) for frontend, pipeline, character, PostgreSQL memory/time, and shared API contracts. The integrated app connects React, real voice providers, the character engine, persistent memory, and the Next day demo.

Local `.env` files and their variants are excluded from Git. Keep credentials out of committed files.

The voice implementation uses **Express 5 + TypeScript on Node.js** in [backend/pipeline](backend/pipeline/README.md), with [a browser audio library](packages/voice-client/README.md). The integrated composition runs adaptive microphone endpointing, ElevenLabs STT, the persistent Miu character engine, checked replies, and ElevenLabs TTS. Actual audio playback or explicit visible-delivery acknowledgment commits the selected memories and story progress.

```powershell
npm ci
npm --prefix frontend ci
npm run build:frontend
npm start
```

Node22.19+ is required. Real mode requires `MIU_PROVIDER=real` and both provider keys from `.env.example`; existing local `.env` is not overwritten by the app. `STT_LOGGING=1` selects standard speech-provider logging. `0` requests provider zero retention, which requires an enterprise account. This setting is separate from Miu's persistent memory. See the [pipeline README](backend/pipeline/README.md). `ffprobe` is required for MP4/WebM and real MP3 inspection. Microphone/playback on an iPad must be validated on the actual device over trusted HTTPS.

The [React frontend](frontend/README.md) connects to this voice pipeline using the shared browser client. With the API running, start it in another terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173/app/talk`. The frontend proxies `/api` to port 3001. Talk records one turn; Send submits it and Stop cancels it. Typed messages use the same character and memory engine. Settings select a fictional profile, personality, role, language, and approved voice.

The frontend and API are deployed together at `miu.curiopal.com`, using isolated Miu services and manual releases. Deployment configuration: [deploy/miu](deploy/miu/README.md). Production health must report `provider_mode: real`, `engine_mode: character_memory`, and memory capability in [`/api/health`](https://miu.curiopal.com/api/health).

The [backend guide](backend/README.md) covers the implemented character engine, PostgreSQL schema, child memories/social circle, daily growth, and local text API. Run `npm run demo` for an isolated no-key walkthrough.

`npm run dev` builds the React app and starts the integrated server at `http://127.0.0.1:3001/app/talk`. The same server owns sessions, STT, character replies, TTS, playback receipts, and the adult memory/Next day panel. `npm run dev:frontend` provides Vite hot reload in a second terminal. `npm run dev:engine` retains the standalone text API; `npm run dev:voice` retains the standalone voice transport. These servers share port 3001 by default, so choose different ports when running standalone variants together. `npm run typecheck` checks voice and engine code. The engine keeps its OpenAI 6 SDK through `openai-engine`; the voice workspace uses OpenAI 7.

Remote PostgreSQL uses the existing `.env` credentials and an SSH tunnel. `npm run db:setup-production` creates the isolated application database and updates that same `.env`; `npm run db:tunnel` establishes or checks the forward. Integrated startup ensures the tunnel automatically. `npm run db:migrate`, `db:import-history`, and `db:verify-history` operate on `DATABASE_URL`. Historical reference dialogue remains an archive; selected runtime memories are learned through real completed delivery.

## Miu story library

The [story catalog](backend/stories/catalog.v1.json) contains 1,000 complete bilingual adventures, each with four short chapters. They combine 100 authored plots with 10 imaginary indoor settings, with setting-specific objects appearing in the story. English and Vietnamese chapters follow the same plot and fit Miu's short spoken replies.

`MemoryStore.createProfile()` randomly selects one story for a new profile and saves its ID as `config.assignedStoryId` in the same transaction. Registration retries, new sessions, configuration changes, and restarts preserve that choice. Chapter progress is saved only after completed playback. Stories can be shared by different users, so assignments continue working beyond 1,000 profiles. Existing profiles and checkpoints retain the original Moon Boat adventure.

The current app has demo profile setup; a future authenticated registration handler can call `createProfile()` to use this assignment behavior. Regenerate the JSON catalog with `npm run stories:export`. Follow [AGENTS.md](AGENTS.md) for real-provider evaluation requirements.
