# Miu implementation workstreams

These documents split the [product specification](product-specification.md) into buildable workstreams and describe intended full-product behavior and contracts. The [voice v1 implementation](voice-pipeline/README.md) now uses **Express 5 + TypeScript**, with separate modules documented in [backend architecture](voice-pipeline/backend-architecture.md). Its current [implementation status](voice-pipeline/implementation-status.md) covers fake/mocked validation; character/memory integration, real-provider measurements and iPad verification remain pending.

For the proposed build approach, module interfaces, OpenAI integration, and delivery sequence for character and memory/time, see the [Character engine and memory technical proposal](character-memory-technical-proposal.md).

The [durable memory and age-based recall policy](memory-retention-and-recall-policy.md) records the user’s decision to keep saved memories until explicit forgetting, with no automatic 30-day deletion. The [vector memory integration plan](vector-memory-integration-plan.md) describes the future hybrid-search design, prerequisites, rollout and evaluation gates. Vector implementation is deferred; current legacy expiry code requires migration before that rollout.

The character engine and memory schema are implemented. See the [backend setup and text integration guide](../backend/README.md) for local execution, daily growth, schema tables, and API usage. Voice transport integration with this engine and measured real-provider voice latency remain integration work.

| Workstream | Document | Implementation location | Owns |
| --- | --- | --- | --- |
| Frontend | [Frontend](frontend.md) | `frontend/` | Recording, kitten face and body, playback, setup, demo panel |
| Voice pipeline | [Pipeline](pipeline.md) | `backend/pipeline/` | One audio-turn endpoint, providers, session history, stage orchestration |
| Character engine | [Character engine](character-engine.md) | `backend/character/` | Profile, 16 MBTI presets, director's 13 rules, affect, prompt and speech validation |
| Memory and time | [Memory and time](memory-and-time.md) | `backend/memory/` | PostgreSQL, turn learning, recall, forgetting, diary, night job, demo clock |
| Shared boundary | [API contracts](api-contracts.md) | Shared server/client types | Requests, responses, identifiers, cancellation, playback receipts and errors |

The requested `server/memory` responsibility maps to the existing `backend/memory/` directory. These are server modules, not four separately deployed services. This documentation change does not rename the project directories.

## Complete turn

```text
Browser audio
  -> speech-to-text
  -> classify input
  -> director (character + memory + clock)
  -> reply words
  -> sentence checks + whole-reply safety checks
  -> text-to-speech
  -> response containing face instructions + audio
  -> browser playback
  -> playback receipt -> learn the completed turn in PostgreSQL
```

Only one endpoint handles the conversational stages: `POST /api/sessions/{session_id}/turns`. Setup, session lifecycle, cancellation, playback receipts, and demo operations have supporting endpoints; the browser does not orchestrate separate STT, reply, and TTS requests.

The dialogue model writes plain words. Application code decides character state, emotion, clock-based sleepiness, memory selection, animation, and persistence. A separate classifier can propose structured observations; it cannot issue actions or mutate state.

## Shared decisions

- A short spoken sentence should receive its first approved audible answer within **five seconds** after recording ends. Measure the real and fake paths separately; do not include recording duration in the processing target.
- `MIU_PROVIDER=fake` is the no-key default. It uses declared transcripts and bundled spoken-audio fixtures, not arbitrary offline speech recognition. `MIU_PROVIDER=real` uses actual speech and AI services through the same interfaces.
- Keep raw conversation history in the current session; PostgreSQL stores selected derived memories, not full transcripts or audio.
- Learn after every completed turn. Save clear, directly stated, low-risk details; clarify ambiguous names and do not save sensitive material. Forgetting is an immediate operation, not a background-learning task.
- Recall at most one unsolicited memory per reply. A follow-up can be a clearly labeled inference expressed as a question, never a fabricated event or promise.
- One profile-scoped clock drives narrative dates, daily mood, bedtime behavior, and follow-ups. Latency and privacy-retention timing use real server time.
- The nightly rollover and the panel's **Next day** action invoke the same idempotent job.
- The panel is for the supervised fictional-data demo. It is not a parent monitoring dashboard.

## Current memory implementation

The optional [vector-memory implementation](vector-memory.md) adds real OpenAI embeddings, pgvector storage, guarded asynchronous indexing and canonical source rehydration. Its verification reports distinguish real-model results from offline contract/database mechanics. The [durable-memory policy](memory-retention-and-recall-policy.md) replaces automatic 30-day deletion in the feature branch.

Character and memory quality evaluation uses real providers under `AGENTS.md`. The fixture walkthrough below is frontend/pipeline development diagnostics only and establishes no model-quality or real-audio performance claim.

## Frontend/pipeline fixture walkthrough — diagnostics only

1. Run the app with PostgreSQL and `MIU_PROVIDER=fake`, with no AI keys configured. Select a fictional profile and the `mochi_puddle_en` fixture in the demo panel.
2. Tap Talk, say **“My dog Mochi fell in a puddle”**, then end recording. Fake mode explicitly uses the selected fixture transcript; the submitted microphone audio is not actually recognized.
3. Miu replies with matching kitten voice and face within five seconds. The frontend sends a completed-playback receipt.
4. The panel shows a pet named Mochi and a child-reported puddle event once learning completes. No bath plan or completed bath is stored.
5. Press **Next day**. After outstanding learning finishes, the clock advances to 09:00 on the next local date. The night job creates a new daily mood, one fictional diary entry, one eligible follow-up, and a reviewed friendship state.
6. The frontend opens a new session and requests its greeting through the turn endpoint. In this neutral seeded scenario, Miu opens with **“Did Mochi get a bath?”** using one memory hook. The question is a possible consequence of the puddle event, not evidence of a bath.
7. Say **“forget that”** immediately after that question. The last referenced puddle event and its follow-up are removed; the separately known pet remains. Next day must not recreate that event's follow-up.
8. Repeat the speech and comfort checks in Vietnamese. Repeat with the real provider and a real spoken sentence when credentials are available.

The exact English opener is a fake-fixture acceptance assertion. Real generation may use a safe equivalent unless a locked demo script is enabled. A distressed child, a safety issue, or a deletion always takes priority over this demo opener.

## Integration order

1. Agree on the shared [API contracts](api-contracts.md), identifiers, and example fixture.
2. Build the fake provider and minimal record/playback interface end to end.
3. Add the character director and safety gates before connecting real generation.
4. Add PostgreSQL learning, recall, deletion, and the shared night job.
5. Connect panel state, demo clock, all 16 personality presets, and the real provider.
6. Run the workstream acceptance cases together. Record actual latency and remaining limitations.
