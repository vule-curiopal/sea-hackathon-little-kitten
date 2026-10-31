# Voice pipeline implementation specification

Location: `backend/pipeline/`. Shared interface: [API contracts](api-contracts.md). Collaborators: [character engine](character-engine.md), [memory and time](memory-and-time.md), and [frontend](frontend.md).

## Outcome and scope

One endpoint accepts a child's audio and returns Miu's approved voice plus facial presentation:

`POST /api/sessions/{session_id}/turns`

The endpoint owns **audio in → speech-to-text → classify → director → reply → safety checks → text-to-speech → face plus audio out**. It also owns transient session conversation history, provider selection, turn IDs, timing, cancellation, and failure handling. The browser must not assemble this sequence across individual provider endpoints.

The latency goal is first audible approved speech within five seconds after the child ends a short recording. PostgreSQL learning follows completed playback and stays outside the critical response path, except operations such as forgetting that must succeed before acknowledgment.

## Stage contracts

| Stage | Inputs | Output and constraints |
| --- | --- | --- |
| 1 Audio in | Demo profile token, session ID, request ID, bounded microphone blob | Validated format, duration and size; cancellation context; ephemeral audio only |
| 2 Speech-to-text | Audio, language preference | Transcript, `vi`/`en`, uncertain spans; never invent a name when unclear |
| 3 Classify | Transcript and bounded session context | Advisory intent, explicitly stated feeling, confidence/uncertainty, memory candidates, safety route; no executable actions |
| 4 Director | Classification, history, profile, clock, daily state, one recall candidate | Deterministic dialogue plan and presentation from the character engine; resolve forget before drafting acknowledgment |
| 5 Reply | Character-built prompt and allowed plan | Plain spoken words only; no state JSON, action tags, or tool calls |
| 6 Safety | Each candidate sentence, combined reply, input context and director plan | Approved final text or localized fallback; no unapproved sentence reaches synthesis |
| 7 Text-to-speech | Approved text, selected voice/language/delivery | Actual speech audio and duration; preserve names; no model-selected sound effects |
| 8 Face and audio out | Approved audio, director plan, versions | One response envelope with audio, face plan, final text and timings |

A `greeting` turn skips audio and STT, uses an application-generated greeting intent, and follows the remaining stages. It is allowed only at an eligible user-initiated session opening. It is not an endpoint for unsolicited background speech.

## Classification is observation, not control

Use bounded types rather than arbitrary classifier text:

```json
{
  "intent": "share_event",
  "language": "en",
  "child_context": {
    "stated_feeling": null,
    "distress": "not_stated"
  },
  "uncertain_spans": [],
  "memory_candidates": [
    {"kind": "pet", "name": "Mochi", "species": "dog", "evidence": "My dog Mochi"},
    {"kind": "event", "subject_name": "Mochi", "event_type": "fell_in_puddle", "evidence": "fell in a puddle"}
  ],
  "safety_route": "ordinary"
}
```

The server validates schema, quoted evidence, and supported categories. Uncertainty stays uncertainty. A real classifier's suggestions cannot write memories, choose Miu's mood, issue a deletion, or override a deterministic safety rule. A validated intent may invoke a supported application operation, with explicit reference resolution and authorization.

## Real and fake providers

Select one provider at server startup using `MIU_PROVIDER=fake|real`; default to `fake` for local development. Both implement the same logical interface:

| Method | Real adapter | Fake adapter |
| --- | --- | --- |
| `transcribe(audio, context)` | Configured speech recognition service | Transcript declared by the selected fixture; no arbitrary audio recognition |
| `classify(text, context)` | Structured classification with schema validation, plus application guards | Deterministic bilingual rules and scripted observations |
| `reply(prompt, context)` | Configured text-generation service; plain-text result only | Fixed reply selected from the actual director plan and supported scenario |
| `checkSafety(text, context)` | Configured safety service plus local sentence/plan validators | Strict fixture allowlist plus the same local validators |
| `synthesize(text, voice, delivery)` | Configured speech synthesis service | Bundled spoken clip matching the exact approved text, language, and supported delivery |

The real adapter must call actual external services for arbitrary supported speech; fixture playback or returning text alone does not satisfy it. Choose the service vendor and model IDs at implementation time and keep them behind this interface. All service credentials remain server-side.

Configuration must include `MIU_PROVIDER`, `DATABASE_URL`, `DEMO_MODE`, and the real adapter's documented credentials/model/voice settings when enabled. Fake mode requires no AI credentials, makes no outbound AI calls, and still uses PostgreSQL for the memory demo. Fail fast if real mode lacks required configuration; never silently substitute fake output.

### Fake-provider fixture requirements

| Fixture | Required behavior |
| --- | --- |
| `mochi_puddle_en` | Input transcript “My dog Mochi fell in a puddle”; neutral acknowledgment, e.g. “Oh, Mochi found a puddle.” |
| `mochi_puddle_vi` | Equivalent volunteered pet/event detail in Vietnamese; preserve Mochi |
| `mochi_next_day_en` | Greeting “Did Mochi get a bath?” only if the real memory service selected the eligible hook |
| `mochi_next_day_vi` | Equivalent question, e.g. “Mochi được tắm chưa?” |
| `sad_en` / `sad_vi` | Comfort override; no giggle, purr, playful mistake, or startling gesture |
| `unclear_name` | One clarification; no confirmed guessed-name write |
| `forget_last` | Real deletion succeeds before the matched acknowledgment clip can play |
| `promise_resume` | Application-supported story commitment with a persisted checkpoint |
| `safe_refusal` | Approved age-appropriate refusal in the active language |
| `greeting` / `retry` | Neutral greeting or error clip when no memory hook is eligible |

Fixtures do not bypass the director, memory database, safety, cancellation, or night job. In particular, Next day cannot return the Mochi clip if the source event was forgotten. Fake audio is honest simulated processing, explicitly labeled in diagnostics. Missing fixtures fail clearly; do not replace speech with a beep, silently use a paid service, or pretend a browser speech recognizer is offline.

Bundled clips and their metadata are implementation deliverables; this documentation change does not supply audio assets. Run a fixture consistency check so approved text, clip transcript, language, duration, and calm/cheerful delivery agree.

## Session conversation history

- Store the recent conversation in server memory for the session, keyed by the server-resolved profile and session ID. Do not use PostgreSQL as a full transcript archive.
- Keep up to 12 completed exchanges, additionally bounded by a prompt-size budget. Before trimming, run required learning for the affected completed turns. Older durable context comes from selected memories, not a hidden full transcript.
- Track user input, approved assistant text, delivery status, source memory IDs, and pending confirmation/reference handles. Keep generated-but-unheard responses out of assumed shared history.
- A completed playback receipt finalizes the exchange and schedules learning once. Interrupted replies are not stored as heard promises or Miu self-statements. Clearly validated child facts may still be learned from an accepted input, subject to cancellation policy; the MVP can conservatively discard interrupted turns entirely.
- Serialize completed-turn learning or expose a validated pending projection before the next turn reads memory. “Yes” must resolve the right pending question; “forget that” must work immediately after a just-spoken memory reference.
- End sessions explicitly or after 30 minutes of inactivity, discard raw text, and retain only eligible derived records. If the server restarts, a new session may lose transient history; durable memory still works.
- Never append stale/canceled output. A deletion also scrubs related transient history and repeat/reference caches, not only database retrieval.

## Commit and playback semantics

The response can prepare a story transition or promise, but does not mark it as heard. Keep prepared transitions associated with the turn until completed playback. On a valid completed receipt, atomically mark completion and enqueue its learning record without full transcript logging. A started receipt only records that a memory hook was presented, preventing repeat questions after interruption.

Learning receives a short-lived in-memory turn context and minimal validated projection. Durable retry records, if needed, contain only the filtered projection and dependency IDs, never raw audio, complete dialogue, or sensitive passages. If the process dies before a projection is durable, report failure/pending loss rather than pretending the turn was learned.

Forgetting is different: resolve and commit the deletion before generating “I forgot that.” Invalidate dependent turns and pending learning so they cannot restore deleted material. Do not reverse a completed deletion because playback was later stopped. A storage failure must never produce a success acknowledgment.

## Latency budget and timeout behavior

Proposed budget for a short, warmed-up utterance, measured from recording end to first audible speech:

| Work | Budget |
| --- | --- |
| Upload and request handling | 200 ms |
| Speech-to-text | 850 ms |
| Classification | 350 ms |
| Context lookup, director, and prompt | 150 ms |
| Reply generation | 1,600 ms |
| Sentence and whole-reply checks | 150 ms |
| Speech synthesis | 1,050 ms |
| Response transfer, decode, playback start | 650 ms |
| Total | 5,000 ms |

These allocations are design targets, not provider guarantees. Instrument monotonic stage durations on the server and recording-stop-to-audio-start on the client. The acceptance target is p95 at or below five seconds over 30 short turns per language per provider on the demo network. Report cold start, network, and autoplay results rather than excluding failures silently.

Use a total response deadline and stage timeouts; do not allow unbounded safety rewrites or provider retries. Permit at most one constrained rewrite if time remains, then use a pre-approved localized fallback. A fallback that fails to answer the child's request counts as degraded service, not a successful latency pass. Do not reduce validation to meet the clock.

Learning, panel refresh, and night-job work do not block speech. Required forget writes, pending confirmation resolution, and version checks do. Avoid parallel turn processing for the same profile; independent static configuration and current-state reads may be fetched together after establishing a consistent version.

## Failure and cancellation

Propagate a cancellation token through STT, classification, reply, safety, and TTS. Where a provider cannot cancel, discard its result. Recheck session/profile/clock/deletion versions before publishing and before any write. Responses cached for an idempotent retry must be invalidated or sanitized after dependent content is forgotten.

No safe text means no synthesis. No usable audio means an error response, not a blank success. An unsupported real voice, unclear transcription, expired session, unknown fixture, or storage failure must use a specific contract error. Log request IDs, stage names, durations, and error codes without audio or conversation content.

## Acceptance checklist

- One multipart request traverses all eight stages and returns usable audio and a face plan.
- Fake mode passes the end-to-end path with outbound AI access disabled and no AI keys.
- Real mode recognizes actual speech and returns actual generated speech in Vietnamese and English; its failures remain visible.
- Session history supports a pronoun, a clarification, and a follow-up without losing the active context.
- Unsafe second sentences never get synthesized after a safe first sentence; whole-reply checks also run.
- Stop, retry, duplicate receipts, duplicate requests, and profile switches cause no double learning, stale playback, or unsupported promise.
- Forget immediately before a pending learner finishes cannot recreate the forgotten event.
- The Mochi next-day opener depends on persisted memory and the night job, not just a fixture name.
- Record fake and real latency separately against the five-second target, and mark any missing real-provider validation explicitly.
