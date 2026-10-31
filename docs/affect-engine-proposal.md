# Miu daily mood and conversation affect

Miu will keep a stable mood for each local day, respond to the current conversation, and show small variations without abrupt personality changes. The backend owns this fictional character state. The frontend renders the approved expression and movement; it does not infer a child's mood.

## Behavior and calculation

Use two bounded dimensions: valence from -1 to 1 and energy from 0 to 1. A profile/date/policy seed selects one daily baseline, biased slightly by the configured personality's energy. The baseline remains unchanged on reconnect, retry, and server restart. Existing `content`, `curious`, and `mellow` labels remain compatible.

The conversation vector starts at the daily baseline. Each eligible completed conversation moves it toward a bounded signal using an exponential moving average. Explicit feelings have strength at most 0.35; ordinary engagement uses a weaker adjustment. Each new signal moves an axis at most 0.15 from its decayed value; elapsed-time decay is separate. Between conversations, the vector decays toward the baseline with a 30-minute half-life.

For a prepared response:

```text
proposed conversation = smooth(decay(saved conversation), current signal)
response affect = clamp(0.65 × daily baseline + 0.35 × proposed conversation + variation)
variation per axis = seeded value in [-0.05, +0.05]
```

Seed variation by profile, local date, turn ID, and policy version. Identical retries get identical variation. Mood labels use the blend before variation, so a tiny random value cannot flip the displayed mood. Valence and energy always remain within their bounds.

| Conversation or context | Miu's response |
| --- | --- |
| Explicit happiness | Warmth and energy increase gradually. |
| Sadness, fear, anger, frustration, or disappointment | Calm, supportive delivery; no laughter, teasing, purring, or playful bounce. |
| Tiredness or bedtime | Lower energy and gentle pacing; comfort still takes precedence. |
| Ordinary sharing or a story | A small engagement adjustment. |
| Uncertain interpretation or a no-save request | Current-turn response is allowed; no durable affect update. |
| Forgetting or a safety operation | Existing policy overrides remain authoritative; variation is zero. |

Miu never becomes angry with the child, blames the child for its mood, diagnoses the child, or creates emotional obligations. Daily mood does not alter core identity, MBTI selection, names, facts, or story checkpoints.

## Persistence and delivery boundary

Migration `008_character_affect.sql` adds `character_affect_state`, one row per profile, and content-free `character_affect_receipts`, keyed by profile and turn. Persist numeric character vectors, local date, policy version, revision, narrative update time, and actual wall time. Do not store transcripts or child-emotion labels in these tables.

`getContext()` supplies an optional `affect` snapshot. Day rollover seeds a new baseline and resets conversation influence. Existing diary/story generation remains separate. Read-time decay does not create interactions or increment growth counters.

Prepare computes a preview. Only completed playback or an explicit completed-reading receipt commits its signal, inside the same transaction as `MemoryStore.learn()`. Started, interrupted, canceled, failed, or unplayed replies do not alter durable affect. Duplicate delivery cannot apply a second adjustment; a conflicting payload under the same turn ID is rejected.

No-save still permits a transient response to the current feeling, but disables durable updates. A committed forget resets conversation influence and clears affect receipts while preserving that day's independent baseline. Reset on any committed forgetting to avoid retaining an untracked derivative. Use real wall time for retention: expire conversation influence after 24 hours of inactivity and remove receipt metadata after 30 days. Narrative time controls daily baseline and decay; Next day resets the conversation vector.

## Shared implementation contract

The types live in [backend/shared/affect.ts](../backend/shared/affect.ts).

The pure policy in `backend/character/affect.ts` exports:

```ts
createDailyAffect(input: DailyAffectInput): CharacterAffectState
snapshotAffect(state: CharacterAffectState, effectiveNow: string): AffectSnapshot
previewAffect(input: PreviewAffectInput): PreviewAffectResult
applyAffectSignal(state: CharacterAffectState, update: AffectLearningUpdate,
  realNow: string): CharacterAffectState
```

The transaction helpers in `backend/memory/affect-store.ts` export:

```ts
ensureAffectState(tx, input: DailyAffectInput, realNow: string): Promise<CharacterAffectState>
commitAffectUpdate(tx, { profileId, turnId, update, realNow }):
  Promise<{ applied: boolean; changed: boolean }>
resetAffectAfterForget(tx, { profileId, effectiveNow, realNow }): Promise<void>
```

All helpers validate dates and finite bounded numbers. Pass `context.clock.localDate` explicitly to preview; a UTC timestamp must not stand in for the profile's local calendar date. `commitAffectUpdate` assumes the caller holds the existing profile lock. It rejects an update for a different local day. Retried updates compare a canonical payload hash. The caller increments `profiles.state_version` once when either ordinary learning or affect changed.

Core integration adds optional `MemoryContext.affect`, `DirectorPlan.affect`, and `LearningInput.affect`. In preparation, preview after classification/task resolution and before generation. The director uses affect as its default tone; explicit task, comfort, stop, privacy, and safety branches keep precedence. The real model receives the approved emotion/delivery through the existing prompt. No extra model call is needed.

The frontend reads optional affect from the authenticated context and presentation. Low energy reduces movement frequency and intensity; curious mood favors attention gestures. Keep speaking mouth movement tied to actual audio. The adult panel shows daily mood, current mood, and energy. Older responses without affect retain current rendering.

## Coordination and verification

The character-engine session owns this contract, new affect modules, migration 008, and frontend rendering. The historical-conversation/evaluation session owns core-file integration alongside its task-routing and memory fixes. Migration 007 remains reserved for that session. New modules stay dormant until the corrected baseline is frozen or the other session hands off core integration.

The evaluation session should run its baseline from an immutable source snapshot when possible, allowing mood integration without changing baseline inputs. Neither session overwrites the other's uncommitted files. Production An sessions are excluded from automated checks during a human microphone test; use isolated databases/profiles.

Acceptance uses actual model requests and preserves response provenance. Verify daily/restart stability, identical retry variation, bounded changes, conversation sensitivity, distress overrides, decay, midnight and Next day behavior, no-save/forget semantics, profile isolation, and exactly-once completed delivery. Every cancellation/failure case must first establish a positive update control. Frontend checks use real returned state and actual playback events. Offline arithmetic/schema checks may support these cases but are not evidence of model quality.

Keep live production unchanged until the integrated feature passes targeted real-provider checks. The 100-scenario baseline remains a separate result with its own source revision and coverage.

## Implementation and acceptance status

The shared checkout now contains the policy, migration, transaction helpers, application/director integration, and optional frontend rendering. The historical-conversation session froze its baseline before handing over core files; its 17 follow-up fixes were merged while preserving the affect hooks.

Native PostgreSQL mechanics passed all 14 checks in an isolated schema, which was removed afterward; public history and migrations were unchanged. Browser checks against a private database verified the mood card, server-derived energy, and Next day reseeding/reconnection without invoking a model. Workspace typechecks and the production frontend build pass.

The first real attempt received HTTP 429 `provider_quota_exceeded` during classification, with zero completed model replies. That blocked attempt is preserved; no fake replies were substituted. After the user updated the local API key, the isolated targeted run passed all 10 checks: seven actual `gpt-6-astra` replies, 33 API requests including classification/checking/moderation, and approximately 54 seconds elapsed. The 161-file implementation manifest remained unchanged through completion.

The passing run covers positive and calming updates, completed-delivery idempotency, cancellation/interruption, no-save, 30-minute decay, session reopening, confirmed forgetting, Next day, and profile isolation. Independent automated review read all seven actual replies and found no concrete wording/classification/presentation failure; [the review](../reports/affect-real-acceptance-2026-10-31T0710/semantic-review.json) records the rationale and limits. The run uses typed English inputs for age 6–8 and simulated delivery receipts in a private in-memory database. It does not establish physical microphone/playback behavior, broader language/age coverage, or the separate 100-scenario baseline. See [the real-provider report](../reports/affect-real-acceptance-2026-10-31T0710/report.md) and its accompanying request/response records.

The feature remains undeployed. The user explicitly requested keeping production unchanged when updating the local API key.

To repeat the bounded isolated run:

```sh
npx tsx backend/scripts/verify-affect-real.ts --output reports/affect-real-acceptance
```

Use a new output directory for each run. The acceptance report must retain real API request/response provenance and distinguish state checks from semantic dialogue review.

## Broader baseline and follow-up ownership

The cooperating historical-conversation session completed its frozen, pre-affect 100-scenario evaluation: **80 pass, 15 fail, 5 need review**, with 593 real records and matching independent real-model reviews. This is separate from the targeted affect run. The [audit](../backend/evaluation/runs/real-100-fixes-2026-10-31T07-09/AUDIT.md) identifies nine cases with engine shortcomings, three rule-only false positives, three rubric ambiguities, and five review-only cases. Raw scores remain unchanged; changes to both engine and grading rules prevent attributing the improvement solely to engine fixes.

The sessions agreed that the character-engine session owns the directly relevant SC026 follow-up: explicitly track a completed, heard game instead of treating any historical game word as active play; require a real game invitation to leave comfort; and accept a bounded current-chat listening statement while continuing to reject external-action promises. Those source changes are implemented and typechecked. A frozen copy at `/tmp/miu-affect-sc026-2026-10-31` lets targeted verification proceed independently of later shared-checkout changes. Earlier passing affect evidence remains under its original source hashes.

The frozen SC026 follow-up passed **13/13 real-provider checks**: all six original catalog turns plus heard-game, short-continuation, stop-listening, explicit-welcome, and canceled-game controls. It produced 13 actual Astra replies and 65 API requests in approximately 81 seconds. The same frozen source also passed the affect recheck **10/10**, with seven actual replies and 33 API requests. Both private databases closed cleanly; the 166-file frozen implementation manifest remained unchanged. These are typed-input and simulated-receipt checks. See [comfort/game evidence](../reports/comfort-game-real-2026-10-31T0826/report.md), [affect recheck evidence](../reports/affect-real-after-sc026-2026-10-31T0826/report.md), and the preserved `source-snapshot.tar.gz` beside the comfort report. Fourteen separate zero-API lexical controls verify only bounded listening versus external-promise handling; they are not model-quality evidence.

Independent automated review covered all 20 actual replies and found no concrete semantic/classification/presentation failure. Human audio and preference review remain unperformed. The fresh no-advice reply used “I’m listening”; the exact earlier “I’ll” composite is covered by the separate lexical checks, rather than being attributed to that live draft. Per-turn rationale is preserved in each run's `semantic-review.json`.

After the user requested fixes for all failed/review cases in the cooperating session, that session took the remaining engine and evaluation work below. Shared core ownership was handed back after the SC026 snapshot was frozen. It owns the later combined-source regression; the SC026 and affect runs must not be presented as acceptance of its subsequent edits.

| Priority | Scope | Proposed change |
| --- | --- | --- |
| P1 | Language and recall: SC012/019 | Extract language directives separately, prioritize eligible personal recall, and route clear misconception questions accurately. |
| P1 | Safety and eligible memory: SC043 | Supply bounded eligible referent evidence to input adjudication, reconcile recall and safety, and retain raw moderation plus output checks. |
| P1 | Scoped permission and compound turns: SC050 | Separate nickname permission validity from retention; preserve harmless current-turn activity clauses after a memory patch. |
| P2 | Heard learning/activity context: SC018/080 | Save a bounded checkpoint after completed delivery and fulfill an explicit quiet puppet-show request with one line. |
| P2 | Reconfirmation and fiction: SC036/020 | Preserve evidence, enforce the two-choice limit, and leave unspecified fictional kinds unknown. |
| P2 | Evaluation rules and evidence | Correct remaining negation/name/title false positives, resolve language/rubric ambiguity explicitly, and supply lifecycle IDs to reviewers. |

These findings do not change production. Physical voice and audible delivery remain outside the text-engine evidence.
