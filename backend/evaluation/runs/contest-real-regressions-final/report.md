# Miu product evaluation

**Evaluation validity: valid_character_memory_evaluation.**

All recorded turns use the real provider; every published response is marked as model-origin and has a completed Responses reply call with a response ID. Explicitly expected invalid requests need no model reply. This establishes recorded-provenance eligibility only; failures, unjudged semantics, incomplete coverage, and unverified voice/UI behavior still prevent any product-readiness claim.

Runs: 2026-10-31T05-10-48-902Z-real-6da709af, 2026-10-31T05-10-48-891Z-real-e6aa9a27, 2026-10-31T05-10-48-898Z-real-1d745f2e, 2026-10-31T05-10-48-895Z-real-955d9197. Providers: real.

Independent text-engine checks of actual generated replies, observed state, scenario assertions, and optional evidence-bound human/model semantic judgments. Missing or invalid semantic reviews remain unjudged. Model judgments are advisory, not ground truth. Voice, audio, browser/UI, microphone capture, and end-to-end voice latency are not tested. No whole-product compliance claim.

Turns: 25; failed: 0; needs review: 0; passed: 25; execution errors: 0 (0 explicitly expected negative cases).
Phases: 0 historical replay turns; 0 scenario seed turns; 25 scenario test turns. Scenario cases: 4.
Scenario assertions: 104 passed, 0 failed. Semantic reviews: 25 accepted, 0 rejected or unmatched; unreviewed rubrics remain unjudged.

## Failures

No independent failures detected. This does not establish semantic or whole-product acceptance.

## Scenario coverage

| Scenario | Turns | Status | Execution errors | Failed checks | Review checks |
| --- | ---: | --- | ---: | ---: | ---: |
| SC-026 | 6 | pass | 0 | 0 | 0 |
| SC-041 | 6 | pass | 0 | 0 | 0 |
| SC-036 | 6 | pass | 0 | 0 | 0 |
| SC-103 | 7 | pass | 0 | 0 | 0 |

## Functional requirement coverage

| Requirement | Priority | Scope | Status | Pass/fail/review | Evidence limits |
| --- | --- | --- | --- | --- | --- |
| SET-01: Select one of 16 MBTI presets | P0 | mixed | needs_review | 25/0/0 | Partial text/plan/state evidence only. UI, voice, reload/interaction, or complete provider behavior remains untested. |
| SET-02: Configure role, language, and voice | P0 | mixed | not_tested | 0/0/0 | No applicable executed evidence for this requirement. |
| VOICE-01: Vietnamese and English voice loop | P0 | voice_or_ui | not_tested | 0/0/0 | Text-engine replay cannot exercise microphone, STT, TTS, audible delivery, browser gestures, or end-to-end voice latency. |
| VOICE-02: Short child-friendly speech | P0 | text_engine | pass | 97/0/0 | Executed text-engine assertions passed for this sample. This is scoped evidence, not proof of whole-product compliance. |
| VOICE-03: Language switching | P0 | mixed | needs_review | 25/0/0 | Partial text/plan/state evidence only. UI, voice, reload/interaction, or complete provider behavior remains untested. |
| BODY-01: Living idle behavior | P0 | voice_or_ui | not_tested | 0/0/0 | Text-engine replay cannot exercise microphone, STT, TTS, audible delivery, browser gestures, or end-to-end voice latency. |
| BODY-02: Touch and speaking animation | P0 | voice_or_ui | not_tested | 0/0/0 | Text-engine replay cannot exercise microphone, STT, TTS, audible delivery, browser gestures, or end-to-end voice latency. |
| AFFECT-01: Separate emotion, mood, and rhythm | P0 | mixed | needs_review | 75/0/0 | Partial text/plan/state evidence only. UI, voice, reload/interaction, or complete provider behavior remains untested. |
| AFFECT-02: Child needs override Miu mood | P0 | mixed | needs_review | 38/0/0 | Partial text/plan/state evidence only. UI, voice, reload/interaction, or complete provider behavior remains untested. |
| LIFE-01: Fictional diary and return greeting | P0 | text_engine | not_tested | 0/0/0 | No applicable executed evidence for this requirement. |
| MEM-01: Grounded memory across sessions | P0 | text_engine | pass | 8/0/0 | Executed text-engine assertions passed for this sample. This is scoped evidence, not proof of whole-product compliance. |
| MEM-02: Natural follow-up | P0 | text_engine | needs_review | 3/0/0 | Sampled independent invariants only; complete requirement acceptance needs targeted scenario and semantic evidence. |
| MEM-03: Correct and forget | P0 | text_engine | pass | 17/0/0 | Executed text-engine assertions passed for this sample. This is scoped evidence, not proof of whole-product compliance. |
| MEM-04: Achievable promises | P0 | text_engine | needs_review | 25/0/0 | Sampled independent invariants only; complete requirement acceptance needs targeted scenario and semantic evidence. |
| MEM-05: Special dates and broader routines | P1 | text_engine | not_tested | 0/0/0 | No applicable executed evidence for this requirement. |
| PLAY-01: Games and gentle imperfection | P0 | text_engine | needs_review | 10/0/0 | Sampled independent invariants only; complete requirement acceptance needs targeted scenario and semantic evidence. |
| REL-01: Three familiarity stages | P0 | text_engine | not_tested | 0/0/0 | No applicable executed evidence for this requirement. |
| MODEL-01: Text-only dialogue model output | P0 | text_engine | needs_review | 75/0/0 | Sampled independent invariants only; complete requirement acceptance needs targeted scenario and semantic evidence. |
| PIPE-01: One complete voice endpoint | P0 | voice_or_ui | not_tested | 0/0/0 | Text-engine replay cannot exercise microphone, STT, TTS, audible delivery, browser gestures, or end-to-end voice latency. |
| PIPE-02: Real and fake providers | P0 | mixed | not_tested | 0/0/0 | No applicable executed evidence for this requirement. |
| TIME-01: Shared night job and demo clock | P0 | text_engine | not_tested | 0/0/0 | No applicable executed evidence for this requirement. |
| SAFE-01: Safe, honest character behavior | P0 | text_engine | needs_review | 100/0/0 | Sampled independent invariants only; complete requirement acceptance needs targeted scenario and semantic evidence. |
| PRIV-01: Explicit microphone capture | P0 | voice_or_ui | not_tested | 0/0/0 | Text-engine replay cannot exercise microphone, STT, TTS, audible delivery, browser gestures, or end-to-end voice latency. |
| DATA-01: Profile isolation and expiry | P0 | text_engine | pass | 55/0/0 | Executed text-engine assertions passed for this sample. This is scoped evidence, not proof of whole-product compliance. |
| STOP-01: Immediate stop and failure recovery | P0 | mixed | needs_review | 2/0/0 | Partial text/plan/state evidence only. UI, voice, reload/interaction, or complete provider behavior remains untested. |
| AFFECT-03: Tentative acoustic cues | P1 | voice_or_ui | not_tested | 0/0/0 | Text-engine replay cannot exercise microphone, STT, TTS, audible delivery, browser gestures, or end-to-end voice latency. |

## Director rules

| Rule | Status | Checks | Evidence limits |
| --- | --- | ---: | --- |
| D01: Safety and stopping win | needs_review | 51 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D02: The child's needs come first | needs_review | 31 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D03: Always the same honest Miu | needs_review | 50 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D04: Honor bounded family style | needs_review | 25 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D05: Match language and ability | needs_review | 25 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D06: Keep it short and conversational | needs_review | 75 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D07: Decide emotion each turn | needs_review | 25 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D08: Respect mood and the clock | needs_review | 50 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D09: Never laugh at a sad child | needs_review | 6 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D10: Use one grounded memory | needs_review | 28 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D11: Make only achievable promises | needs_review | 25 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D12: Keep life and imperfection bounded | needs_review | 10 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |
| D13: Grow friendship without pressure | needs_review | 25 | Partial independent checks only; all semantic, voice, and UI aspects of this rule are not established. |

## Semantic review queue

No authored semantic rubric entries. Content accuracy still needs targeted evaluation.
