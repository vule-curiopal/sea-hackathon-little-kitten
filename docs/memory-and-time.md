# Memory and time implementation specification

Location: `backend/memory/`, the server-side memory responsibility referred to as `server/memory`. Storage: **PostgreSQL**. Dependencies: [pipeline](pipeline.md), [character engine](character-engine.md), and [API contracts](api-contracts.md).

## Outcome

Miu learns selected details after every completed turn, recalls one relevant memory, honors “forget that,” and carries an authored fictional life into the next day. One clock and one idempotent night job drive follow-ups, diary, daily mood, and friendship review. The demo panel shows what was learned and why a follow-up is eligible.

The key demonstration is:

> Child: “My dog Mochi fell in a puddle.”
>
> Next day, Miu: “Did Mochi get a bath?”

Persist the dog and reported puddle event. The bath is an **inferred question**, not a reported plan or completed event. This distinction must survive storage, retrieval, prompts, panel display, and deletion.

## PostgreSQL data model

Use UUID primary keys, UTC `timestamptz` for real instants, explicit profile-scoped local dates for narrative scheduling, and a profile foreign key on every personal-data table. Index profile/category/status/due-date lookups. All reads and writes require a server-resolved profile predicate; never query by an unscoped memory ID supplied by a client or model.

| Table | Essential fields and responsibility |
| --- | --- |
| `profiles` | Fictional child identity, age band, locale, timezone, configuration reference, state version, deletion epoch |
| `miu_configs` | One MBTI type, role, language mode, approved voice, canon version |
| `entities` | Profile, kind (`person`, `pet`, `object`), display name, minimal attributes, source, confirmation, expiry |
| `entity_aliases` | Profile-scoped alias to stable entity; correction and deletion dependencies |
| `facts` | Subject, predicate, minimal value, evidence kind, source turn, confirmation, real/fictional scope, expiry |
| `events` | Subject, event type, source wording projection, narrative date/precision, reported/planned status, source turn, expiry |
| `promises` | Supported commitment, actor (`miu` or child-reported person), checkpoint, due-session/date, proposed/open/fulfilled/canceled state |
| `miu_self_statements` | Approved canon/diary reference and supported claim, heard turn, fictional scope; no invented canon |
| `memory_dependencies` | Source-to-derived edges for aliases, facts, events, follow-ups, diary references, shared jokes, and checkpoints |
| `followups` | Source event/promise, due local date, question template, evidence kind, eligible/reserved/presented/resolved/canceled status, expiry |
| `daily_states` | Profile, local date, authored mood, energy, selected diary-event ID, state version |
| `diary_entries` | Profile/date, authored template ID, minimal fictional context, expiry; unique one per profile/date |
| `relationship_states` | Stage, child-approved familiarity/nickname/joke references, eligible shared milestones; no engagement score |
| `story_checkpoints` | Approved template, cast references, choices, next scene, supporting promise and expiry |
| `demo_clocks` | Profile, real/demo mode, effective instant/offset, timezone, clock version |
| `night_job_runs` | Profile, target local date, idempotency key, status and completion; no dialogue text |
| `turn_learning` | Unique profile/turn key, filtered projection, deletion epoch, pending/complete/failed status, retry metadata, short expiry |

Full session dialogue and raw audio are not PostgreSQL records. `turn_learning` contains only a validated minimal projection needed for reliable derived writes, not a serialized transcript. Remove processed projection content after successful application. Operational metadata can remain for the short diagnostic retention window.

Keep only the current daily mood row after successful rollover; historical night-job receipts do not retain a mood history. Promises reported about other people remain child-reported claims, never commitments Miu can guarantee or fulfill.

Enforce unique `(profile_id, source_turn_id, candidate_key)` for derived facts/events and `(profile_id, turn_id)` for learning. Enforce unique `(profile_id, local_date)` for diary/daily state/night-job completion. Use foreign keys or validated dependency edges with profile consistency so one profile cannot reference another's entity or checkpoint.

## Learn after each turn

### Inputs and eligibility

Receive a `TurnLearningInput` from the pipeline after completed playback: session/turn IDs, source narrative date and clock version, deletion epoch, validated input candidates, approved spoken text projection, referenced canon/diary IDs, heard status, and proposed supported activity/promise transitions.

The dialogue model does not write memory or generate a durable summary. Classification may suggest candidates; application rules validate evidence and scope. For the MVP, deterministic English/Vietnamese patterns support a small reliable set. Unknown or ambiguous details become a clarification, not an invented fact.

| Category | Example | Learning rule |
| --- | --- | --- |
| People | “My sister is Lan” | Save a clear volunteered name/relationship; no contact details or inferred identity |
| Pets | “My dog Mochi…” | Save pet name/species from explicit evidence; do not guess breed or ownership beyond the statement |
| Facts | “I like dinosaurs” | Save low-risk preferences; not diagnoses or inferred personality labels |
| Events | “…fell in a puddle” | Save as child-reported event with the available time precision; no invented aftermath |
| Promises | Approved “Next time we can finish this story” | Save only after heard playback and a real checkpoint/capability exists |
| Miu self-statements | “I like cardboard boxes” | Match approved canon or diary before saving; never let arbitrary generated lore become authority |

Clear, directly stated low-risk facts may be saved without a separate confirmation turn. Ask when names, entity identity, corrections, or permission to use a nickname are uncertain. An explicit “don't remember this” suppresses persistence; “remember this” still cannot authorize sensitive storage. Conversational preference does not replace any required legal consent.

### Transaction

1. Validate profile, turn completion, supported categories, evidence spans, retention, and deletion epoch.
2. Deduplicate by turn/candidate key. Resolve entities conservatively; similar names alone cannot merge people or pets.
3. Save validated entities, facts, events, and heard supported claims in one transaction with source IDs and expiry.
4. Link dependencies and update exact checkpoint/promise transitions. Do not mark an offered future activity as fulfilled before it happens.
5. Record shared milestones only when they actually occurred and familiarity was welcomed. Do not count elapsed minutes, disclosures, or visit streaks.
6. Mark learning complete and discard processed projection content. Expose typed outcomes and status to the panel without raw private passages.

Retries are idempotent. If a deletion incremented the profile's epoch, reject an older pending projection and clear it so forgotten content cannot be reinserted. It is acceptable for the MVP to discard an entire stale projection rather than salvage unrelated details incorrectly.

Until learning completes, the pipeline must either use a validated pending projection as session context or briefly serialize the next turn. Next day refuses to run while learning remains pending. A database failure is visible and retryable; the panel must not report uncommitted learning as successful.

## Recall one memory

Retrieve active same-profile candidates with provenance, confirmation and expiry checked. Suggested ordering for a neutral greeting: an eligible due follow-up, an open supported promise, a topic-relevant fact, then an approved shared moment. For an ordinary turn, the child's current topic and needs take priority over this ordering.

Return one `RecallHook` containing reference ID, source IDs, minimal supported facts, evidence kind, permitted question/claim, expiry, and deletion epoch. The director may use it or suppress it. A diary entry is an alternative opener, not an additional memory to stack into the same greeting.

Reserve a due hook while generating so concurrent requests cannot select it twice. Release reservation if the turn fails before playback; mark it presented on a valid started receipt. A completed response alone does not prove it was heard. If the child declines the topic, cancel or snooze it without repeated probing. Recheck deletion/version before returning cached speech that mentions it.

## Follow-up rules and the Mochi case

Use an authored rule library rather than allowing the model to invent obligations:

| Evidence | Derived hook | Restrictions |
| --- | --- | --- |
| Reported `fell_in_puddle` event for a known dog | Next-day bath question | `inferred_question`; no bath fact, plan, promise, or concern assumed |
| Explicit “tomorrow is my drawing day” | Ask how the drawing went after that date | `reported_plan`; do not assume attendance or success |
| Miu's open story promise | Offer exact checkpoint | `supported_promise`; child can decline |

For Mochi, store `entity.kind=pet`, `species=dog`, `name=Mochi`, and `event.type=fell_in_puddle`, with the source narrative date. The night job creates a hook due the next local date with English template “Did Mochi get a bath?” and Vietnamese template “Mochi được tắm chưa?”. The selected question must never be converted into `bath_completed=true`.

If the child later says “No bath,” mark the question resolved without inferring harm. If they say “Yes, yesterday,” save the bath only as a new child-reported event with that time precision. If the puddle story includes distress or danger, the comfort/safety route wins and the bath opener can be suppressed.

## Forgetting and correction

“Forget that” resolves against server-owned session references: first the most recent explicitly referenced memory/follow-up in Miu's heard reply, otherwise the most recent learnable child statement. If multiple targets remain plausible, ask one clarification and delete nothing yet.

Example: immediately after “Did Mochi get a bath?”, “forget that” removes the puddle event and its derived hook. The independently learned pet identity remains. “Forget Mochi” instead removes the pet and every dependent fact, event, alias, follow-up, promise, joke, and checkpoint reference. “Forget everything about me” requires one simple confirmation, then clears the profile's derived personal data.

In one transaction, increment deletion epoch/state version, delete the target/dependency closure, cancel related queued learning and prepared replies, remove dependent promise references, and invalidate affected replay/idempotency data. Scrub related current-session text, pending references, frontend captions, repeat buffers, and panel caches. Preserve only content-free operation metadata. A source-less follow-up cannot survive.

A forgotten source is absent from subsequent night-job queries, so the job cannot recreate its hook. Do not rely only on hiding one vector or marking a visible card dismissed. The prototype has no persistent content backups or content-bearing logs. A deletion acknowledgment is authorized only after the database transaction succeeds; later cancellation does not undo it.

Corrections keep the stable entity ID, retire invalid aliases as requested, update dependent display values, and cancel stale generated responses. Invalidate outdated assumptions without fabricating an event that was never reported.

## Clock design

Use one injectable `Clock` interface throughout the server:

- `wallNow()` and monotonic durations: actual timestamps for latency, expiry, technical deadlines, and diagnostics.
- `effectiveNow(profile)`, `localDate(profile)`, and `clockVersion`: narrative time for daily mood, bedtime rhythm, diary, event dates, and follow-up scheduling.

Default timezone can be `Asia/Ho_Chi_Minh` for the demo; store it explicitly. Do not request location. The demo panel may advance within the day or use Next day. Do not allow backward movement except a full explicit demo reset. Add one calendar date in the configured timezone rather than assuming every local day is exactly 24 hours.

Demo time must not prolong privacy retention or overwrite latency measurements. A 30-day memory expiry is based on real server time. Narrative records also become ineligible when their event/date window is no longer relevant. Store both source effective time and real creation time when needed.

## Shared Next day and night job

`runNightJob(profile, targetLocalDate)` is the single implementation used by a scheduled rollover, startup/open catch-up, and the demo panel. It makes no dialogue-model request and plays no audio. Its authored diary, mood, follow-up, and relationship rules must work with the fake provider and no keys.

Under a profile-scoped lock and transaction:

1. Reject or defer while a turn is active or accepted learning remains pending. Snapshot clock/state/deletion versions.
2. Check unique profile/target-date completion; return the existing result if already applied. Expire invalid source data before deriving anything.
3. Create due follow-ups from eligible reported events, explicit plans, and supported promises. Deduplicate by source and rule. Do not recreate presented/resolved hooks for the same event.
4. Select one authored fictional indoor diary event for the target date. It can reference a known safe shared object only through a tracked dependency; otherwise keep it independent of child data.
5. Create the new daily mood once and evaluate friendship stage from validated shared milestones and child permission. Review can leave the stage unchanged; advancing a day alone never increases friendship.
6. Commit the daily state, diary, hooks, relationship review, and job completion atomically. Increment relevant versions and expire old transient sessions.

Next day advances to 09:00 on the next local date in the same transaction as the completed job and closes the old session. Repeated request IDs return the same outcome. Concurrent calls with an old clock version return a conflict. On failure, neither time nor partial daily state advances.

In real-clock mode, a scheduler can request rollover after local midnight. If unavailable, session-open catch-up ensures the current date exists before its greeting. If several days were skipped, create the current day's state only, with no backlog of spoken diary entries or friendship penalties. Work from an already completed old-date turn keeps its source date; no active turn silently changes date mid-response.

### Diary and friendship boundaries

Diary templates are fictional indoor moments: window raindrops, a funny dream, a cardboard fort. Store the chosen template and fictional scope. Never infer actual rain, surveillance, movement, or household conditions. One diary entry per profile/date; no guilt if it is never read.

Stages are `getting_acquainted`, `buddies`, and `best_friends`. A completed shared activity plus welcomed familiarity can support `buddies`; another validated shared moment plus explicit permission for a nickname or recurring joke can support `best_friends`. These are tone presets, not exclusive claims. Seeded history can demonstrate all stages without repeated visits. Recomputing after expiry/deletion removes unsupported references without withdrawing kindness.

## Panel read model

`GET /api/demo/panel` returns a profile-scoped projection:

| Group | Fields |
| --- | --- |
| Clock | Effective time/date, timezone, clock mode/version, next-day availability |
| Character | MBTI, role, daily mood, rhythm, latest turn emotion, terse director-rule trace |
| Memory | Minimal entity/fact/event cards, evidence kind, source handle, expiry, learning status |
| Follow-through | Selected/due follow-up, promise status and checkpoint summary |
| Life | Current fictional diary, friendship stage and permitted shared references, last night-job result |
| Pipeline | Provider mode, fixture, turn status, stage times, client audio-start latency when reported |

Do not expose raw prompts, recordings, full conversation archives, unfiltered candidate projections, or sensitive disclosures. Use typed bounded fields and escape all display text. The demo panel is unavailable outside demo mode; it is not a parent control surface.

## Retention and acceptance

Session text: session-only, 30-minute inactivity expiry. Derived personal memories/diary/promises: 30 real days unless explicitly reconfirmed, with no renewal merely from retrieval. Daily mood: current state only, no child mood history. Diagnostic operation metadata: seven real days, content-free. Pending learning projections: process promptly and purge within the session inactivity window if unrecoverable.

Acceptance requires PostgreSQL integration checks for:

- One completed turn learns supported people, pets, facts, events, authorized promises, and approved Miu self-statements, with idempotent retries.
- Direct evidence is required; unheard/self-invented claims and sensitive details never become canonical memory.
- Mochi's puddle statement, completed learning, Next day, and new greeting produce the bath question without an asserted bath plan or outcome.
- Repeated Next day and scheduler/catch-up calls yield one diary/mood/job per date and no duplicate follow-up.
- Advancing a day alone does not increase friendship; authorized shared experiences can.
- Immediate “forget that,” entity-wide forgetting, dependent deletion, and a concurrent stale learner cannot restore the forgotten content.
- Failed transactions leave no partial clock/day advance or false deletion acknowledgment.
- Profile isolation, expiry, and session-text disposal hold after reload/restart. Clock changes affect sleepiness while privacy expiry still follows wall time.
