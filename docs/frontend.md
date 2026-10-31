# Frontend implementation specification

Location: `frontend/`. Dependencies: [API contracts](api-contracts.md), [pipeline](pipeline.md), [character engine](character-engine.md), and [memory/time panel data](memory-and-time.md).

## Outcome

A child taps Talk, says a short sentence in Vietnamese or English, and hears Miu answer with a matching face in about five seconds or less after recording ends. The kitten also feels present without speech: it blinks, moves its ears and tail, stretches, accepts pats, and dozes. The fake-provider demo works without AI keys.

The child view contains Miu, Talk, Stop, Pet, Repeat, and optional short captions. Conversation history is not the primary screen. Setup and demo diagnostics live outside the child play surface.

## Screens and responsibilities

| Surface | Required content |
| --- | --- |
| Family/demo setup | Fictional profile selection; exactly one of 16 MBTI types; friend, big sibling, or teacher role; Vietnamese, English, or follow-language mode; approved voice selection |
| Play | Miu's face and body; visible capture state; large Talk and Stop controls; Pet and Repeat; optional activity choices |
| Demo panel | Provider mode and fixture selector; clock; Next day; current character state; learned records; diary; promises; friendship; stage latency and learning status |
| Error state | Localized, understandable retry guidance without stack traces or provider internals |

Use the MBTI choices and fixed identity from the [product specification](product-specification.md). A preset changes behavior style; it does not swap the kitten, erase memory, or change the child's personality. Refresh configuration after a successful change, and clear any stale presentation response.

The demo panel uses fictional data and is hidden from the child view by default. It is a developer/judge tool, not a parent monitoring or surveillance feature. Production account and panel authorization are outside this prototype.

## Recording and turn lifecycle

1. Obtain microphone permission only after a deliberate Talk action. Keep the browser media stream closed while idle, sleeping, petting, or showing a diary.
2. Record at most 20 seconds. Tap again to submit; Stop cancels without submitting. Clearly distinguish these actions.
3. Release microphone tracks when recording finishes, on Stop, on navigation, or on permission failure. Post one multipart turn request; do not call separate AI services from the browser.
4. While waiting, show attentive/thinking movement. Keep Stop available. Never play a filler that falsely suggests the question was answered.
5. Check the response's session, turn, state version, and local cancellation generation before decoding or playing anything. Discard old responses after a profile change, reset, session close, or cancellation.
6. Decode the approved audio and start playback with the returned face plan. Report `started` when sound actually begins, not when the HTTP response arrives.
7. On normal audio completion send a `completed` playback receipt; on an interruption send `interrupted`. Retain receipt IDs for idempotent retries while the session is alive.
8. Show pending learning only in the demo panel. Accept another child turn once the server permits it; the server exposes pending learning context or briefly serializes turns so immediate follow-ups do not lose information.

Start a new Talk turn by first canceling current playback and server work. Abort the fetch, call the cancellation route with its known turn ID, stop audio nodes and decorative sounds, then release capture. Aborting the HTTP request alone is insufficient to prevent server-side work.

If the browser blocks autoplay after a delayed response, show a clear Play button. Count the interaction as autoplay-blocked in diagnostics rather than reporting a misleading latency pass. Unlocking audio on the initiating click is an optimization, not a reason to hide playback failure.

## UI state machine

| State | Entry | Allowed transitions |
| --- | --- | --- |
| Ready | Session loaded or previous reply finished | Record, pet, doze, end |
| Recording | Talk pressed and capture succeeds | Submit to processing; Stop to ready/end |
| Processing | Recording submitted | Approved response to speaking; Stop to ready; failure to error |
| Speaking | Audio starts | Natural end to ready; Talk/Stop to interrupted |
| Dozing | Idle timeout | Touch to gentle wake; Talk to wake then recording |
| Comfort | Server presentation requires calm | Suppress playful overlays until server clears comfort |
| Error | Capture, API, or playback failure | Retry or stop |
| Ended | Session ended | Deliberate new-session action only |

Comfort is a presentation overlay, not an excuse to keep recording or block Stop. A local pet action may give a subtle visual response during comfort but must not start a cheerful purr, giggle, or startle.

## Face, body, and audio

- Render the server-selected emotion and delivery. The frontend may choose a bounded idle variation but cannot reinterpret sadness as excitement or select a different emotion from text.
- Use the playback audio's amplitude to open and close Miu's mouth. Analyze only the approved playback buffer; mouth animation is not a reason to keep the microphone active.
- Start gesture offsets relative to actual audio playback time. Stop mouth/body speech gestures when audio stops, even if a timer remains queued.
- Blink, flick an ear, swish the tail, and stretch locally without a model call. Proposed timing: variation every 4–12 seconds, settle after 45 seconds, doze after 90 seconds of no interaction.
- Pet uses a gentle touch/drag gesture or accessible button. Debounce purr playback; do not stack overlapping clips or mask speech. Honor server `allow_purr` and comfort state.
- Wake with a brief, gentle surprised expression. Waking never opens the microphone by itself.
- Pause decorative audio and animation in a hidden tab. On return, recompute the visible state instead of replaying missed actions.
- Repeat replays the last approved, non-deleted response without another model request or new memory writes. Clear the repeat buffer when a related memory is forgotten or the session/profile changes.

Use at least 48-by-48 CSS pixel primary targets, keyboard control, visible focus, strong contrast, captions, non-color recording indicators, and reduced-motion support. Offer text fallback for microphone denial, labeled as text input rather than a successful voice test.

## Fake mode without keys

Display `Fake provider` in the demo panel. The selected fixture determines the fake transcript, reply, and bundled spoken clip. Record and send a real microphone blob to exercise the upload path, but make clear that fake STT does not recognize arbitrary audio.

Minimum fixtures: Mochi puddle in English and Vietnamese, explicit sadness, unclear name, forgetting, safe refusal, promise/resume, ordinary greeting, and next-day Mochi greeting. The frontend loads real speech clips through the same API response shape as the real provider. A beep or a text-only reply does not satisfy the voice acceptance condition.

Never show an API-key prompt in fake mode. A missing real-provider key is a configuration error, not a silent switch to fake responses.

## Demo panel

Read `GET /api/demo/panel` on entry and after turns, receipts, setup changes, learning, and clock actions. A low-frequency poll while learning is pending is sufficient; do not poll for continuous child monitoring.

Show:

- Current provider and fixture ID; input-mode marker; latest turn ID and lifecycle.
- Effective date/time and timezone, daily mood, rhythm, turn emotion, personality, role, and friendship stage.
- The pipeline's ordered stage durations and end-to-end recording-stop-to-audio-start time.
- One selected recall/follow-up with its evidence kind: direct fact, planned event, or inferred question.
- Recently learned people, pets, facts, events, promises, approved Miu self-statements, and pending clarification.
- Diary entry, night-job status, learning status, and a terse director-rule trace.

Avoid full prompts, provider responses, raw recordings, and sensitive disclosures. Render all names and text as escaped data. Clear cached panel and repeat content immediately after deletion or reset.

### Next day interaction

1. Disable Next day while recording, processing, speaking, or learning. If the server still reports a conflict, leave the clock unchanged and show the reason.
2. Submit one idempotent Next day request using the current clock version. Disable duplicate clicks; retry with the same request ID.
3. After success, discard the old session's audio, captions, and pending requests. Fetch the new panel state.
4. Open a new session and send `kind=greeting` through the turn endpoint. This explicit action authorizes the greeting; the night job itself never starts audio.
5. Play the approved greeting and send its playback receipt. If autoplay is blocked, require a Play tap.

In the seeded neutral Mochi scenario, the greeting is exactly “Did Mochi get a bath?” in fake mode. Do not also read out the diary or a second memory. The panel can show the new diary without Miu speaking it.

## Acceptance checklist

- Fake mode boots with no AI keys and reaches an audible response after recording; each required fixture has matching text and real speech audio.
- Complete five-turn conversations in both languages; preserve Mochi and other proper names across language switches.
- In the demo test set, recording-stop-to-first-audio latency is at most five seconds at p95, measured separately for fake and real providers. Report first-load/autoplay failures separately.
- Stop cancels capture, speech, purrs, queued gestures, and stale output within 300 milliseconds locally.
- Pet, doze, and wake do not open the microphone; local idle animation works with networking disabled.
- A sad child produces no laughing, celebratory motion, or startling wake overlay, even when the daily mood is lively.
- Next day shows a new diary and clock, then the Mochi opener. Duplicate clicks do not skip dates.
- “Forget that” removes the displayed event/follow-up and prevents repeat, captions, panel caches, or later greetings from reintroducing it.
- All 16 presets are selectable; profile switches expose no previous profile's memories or audio.
