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

See the [product specification](docs/product-specification.md) for the product scope and the [implementation workstreams](docs/README.md) for frontend, pipeline, character, PostgreSQL memory/time, and shared API contracts. Voice v1 includes a no-key fake-provider path. The Mochi Next day demo is a planned full-product scenario requiring character, memory and clock integration.

Local `.env` files and their variants are excluded from Git. Keep credentials out of committed files.

The first batch voice implementation uses **Express 5 + TypeScript on Node.js** in [backend/pipeline](backend/pipeline/README.md), with [a browser audio library](packages/voice-client/README.md) for the frontend owner. Feature routers/controllers, application services, the RAM protocol repository and provider adapters have separate responsibilities; see [backend architecture](docs/voice-pipeline/backend-architecture.md). It uses adaptive RMS endpointing, ElevenLabs STT/TTS adapters and a stateless GPT response adapter. The default fake mode uses declared reference voice samples and makes no provider calls; character/memory behavior is supplied by the other workstreams.

```powershell
npm ci
npm run build
npm test
npm run smoke
npm run dev
```

Node22.19+ is required. Real mode requires `MIU_PROVIDER=real` and both provider keys from `.env.example`; existing local `.env` is not overwritten by the app. `STT_LOGGING=1` defaults to the working LittleBuddy brain behavior: omit the STT logging query. `0` requests provider zero retention and currently receives 403; TTS is unaffected, and GPT still has no conversation memory. See the [pipeline README](backend/pipeline/README.md). `ffprobe` is required for MP4/WebM and real MP3 inspection. Microphone/playback on an iPad must be validated on the actual device over trusted HTTPS.

The [React frontend](frontend/README.md) connects to this voice pipeline using the shared browser client. With the API running, start it in another terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173/app/talk`. The frontend proxies `/api` to port 3001. Talk records one turn; Send submits it and Stop cancels it. Settings select a fictional profile, language, and approved voice. Fake reference recordings and local typing samples are labeled separately from real voice. Character state, memory and personality behavior are not supplied by the current voice stub.

The frontend and API are deployed together at `miu.curiopal.com`, using isolated Miu services and manual releases. Deployment configuration: [deploy/miu](deploy/miu/README.md). The deployed mode is reported by `provider_mode` in [`/api/health`](https://miu.curiopal.com/api/health); fake remains the no-key default, while real uses the configured providers.
