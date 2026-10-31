# Miu Character Engine and Memory Backend

This backend implements Miu's character director, PostgreSQL schema, grounded child memories, named people and social connections, resumable stories, and daily fictional growth. The integrated server connects the React UI, real speech providers, and persistent character engine through shared preparation and playback boundaries. A separate text API remains available for engine development.

## Run locally

Use Node.js 22.19 or newer.

```sh
npm install
npm run typecheck
npm start
```

`npm start` builds the frontend and serves the integrated app at `http://127.0.0.1:3001`. It loads the existing `.env`, uses real OpenAI and ElevenLabs providers, and requires both credentials. Character generation fails explicitly when a real provider fails. With `DATABASE_URL` configured, the engine uses PostgreSQL; `DATABASE_SSH_TUNNEL=true` restores and verifies its SSH forward before connecting. A remote connection failure does not select local storage. Review [`.env.example`](../.env.example) for configuration.

`npm run demo` uses an isolated in-memory PostgreSQL engine, fictional profiles, and the fake provider. It makes no OpenAI calls, reads no `.env`, and illustrates preferences/social names, Mochi learning, daily growth, next-day follow-up, and forgetting. It is a development demonstration, not behavioral evaluation evidence.

For the standalone text harness with local storage and a fake development provider:

```sh
DATABASE_URL= DATABASE_SSH_TUNNEL=false MIU_PROVIDER=fake npm run start:engine
```

The text harness uses the same default address. Without a PostgreSQL URL it stores development data in PGlite at `.miu-data/`; `MIU_DATA_DIR` changes that directory. The variables above explicitly select local fake development. Standalone voice development remains available through `npm run dev:voice`.

For an existing PostgreSQL database, set `DATABASE_URL` and run `npm run db:migrate`. Startup also applies outstanding migrations. Migrations use a locked receipt table so replay is safe; the same schema runs on PostgreSQL and PGlite.

`npm run db:setup-production` provisions an isolated Miu database and application role on an existing remote PostgreSQL server using `SSH_HOST`, `SSH_USER`, and `SSH_PASSWORD`. It requires remote administrative access, preserves unrelated databases/services, and rejects conflicting unmarked names. It updates database parameters directly in the existing `.env`, preserves existing speech-provider logging settings, and opens a localhost SSH forward. It does not install PostgreSQL or create a separate credential file. `npm run db:tunnel` restores/verifies the forward independently; integrated startup and the migrate/import/verify commands also ensure it automatically. Local archive imports selected with `--data-dir` skip the remote tunnel.

## Username and password accounts

The integrated server provides registration and login using only a username and password. The existing `/register` and `/login` frontend forms call these endpoints and `/app/talk` requires a signed-in account. Each account owns a separate persistent profile; a client cannot select another account's profile by changing a request field.

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/auth/register` | `{ "username": "new_user", "password": "a long password" }` | `201`, `{ "user": { "id", "username", "profile_key" } }` |
| `POST /api/auth/login` | `{ "username": "sam", "password": "1" }` | `200`, same user shape |
| `GET /api/auth/me` | Session cookie | `200`, same user shape, or `401` |
| `POST /api/auth/logout` | Session cookie | `204`, revokes the session and clears its cookie |

Usernames are case-insensitive, 3–32 ASCII letters, numbers, underscores, dots or hyphens; the first character must be a letter, number or underscore. Registration and login accept any nonempty string password, including one character, with no password length or complexity rules. Passwords are not trimmed; the general HTTP request body limit still applies. Passwords use salted, versioned scrypt hashes with bounded KDF concurrency; the chosen parameters follow the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Only hashes of random authentication tokens are stored. Sessions expire after seven real days, independently of the demo clock.

The requested test login is **`sam` / `1`**. Startup creates it when `MIU_SEED_TEST_USER=true`, or when that flag is unset and `DEMO_MODE=true`. It links to the existing `an` profile, retaining that test user's data; restarting does not reset an existing account's password. Set `MIU_SEED_TEST_USER=false` to disable creation of this fixture. Fresh regular accounts receive their own profile and do not inherit An's memories or use their login identifier as the character's name.

Authentication uses an `HttpOnly`, `SameSite=Strict` cookie, with `Secure` on HTTPS and in `NODE_ENV=production`. Frontend requests include credentials; credentials and authentication tokens are never written to local storage. Serve the frontend and API from the same origin, as in the integrated deployment. Separately configured origins must be explicitly allowed and remain same-site for the strict cookie. State-changing requests validate browser origin, and login/registration are rate limited.

`POST /api/sessions` accepts `{ "request_id": "UUID", "demo_profile_key": "account" }` (or omits the selector) to open the signed-in account's profile. Subsequent profile, panel, turn and playback requests require both its engine bearer and the matching account cookie. Logout revokes access even if an old engine bearer is retained. An explicit `guest` selector opens an isolated public demo; unauthenticated legacy `an`/`binh` selectors also create fresh guest profiles, and never reopen the registered test account. The standalone text and voice development harnesses retain their separate demo contracts; account endpoints belong to the integrated server.

## Review Miu and the test user in HTML

```sh
npm run review:characters
```

Open [reports/character-review.html](../reports/character-review.html) in a browser. It is a self-contained offline snapshot with Miu’s canon and archived style, An’s fictional profile and preference changes, source-linked statements, and searchable conversations. It reads the existing `.miu-data` archive through a temporary database copy and a read-only SQL transaction. It never runs migrations, calls a model, or changes the original database.

Use `--data-dir PATH`, `--output PATH.html`, or `--dataset DATASET_KEY_OR_ID` to select another local PGlite archive or output. Regenerate the file to refresh its snapshot. Missing archives fail explicitly. Authored reference dialogue, current runtime memory counts, and Miu’s code-defined character settings remain labeled separately; the page makes no model-quality claim.

## Import the generated year of conversations

```sh
npm run db:import-history
npm run db:verify-history
```

The import loads the generated fictional An history from November 1, 2025 through October 31, 2026: **365 sessions, 1,466 exchanges, and 2,932 messages**. It uses `DATABASE_URL` when configured, otherwise persistent PGlite at `MIU_DATA_DIR` or `.miu-data`. To explicitly select local storage, use `npm run db:import-history -- --data-dir .miu-data`.

The importer validates both JSONL exports and the manifest before writing, then imports the complete dataset in one transaction. Importing identical content again is a no-op. Changed content under the same dataset identity is rejected rather than overwriting an earlier import. The verification command reopens the database and checks the imported rows against the source.

Historical rows are explicitly synthetic reference material, separate from runtime profiles and learned memories. Authored Miu replies retain their reference provenance; child mood labels remain author annotations. Import does not claim that playback, learning, forgetting, or safety operations occurred. Runtime personal-memory expiry and delivery rules still apply to actual conversations.

The `historical_datasets`, `historical_profiles`, `historical_sessions`, and `historical_messages` tables preserve the manifest, fictional profile, session dates/languages/tags, original message IDs, proper names, timestamps, and text. `--source <directory>` selects another export directory in the same validated fixture format. This archive importer accepts the declared synthetic dataset only.

For SQL inspection:

```sql
SELECT source_profile_id, count(*) AS sessions,
       min(local_date) AS first_day, max(local_date) AS last_day
FROM historical_sessions
GROUP BY dataset_id, source_profile_id;

SELECT s.local_date, m.message_id, m.role, m.timestamp_source, m.content
FROM historical_messages m
JOIN historical_sessions s
  ON s.dataset_id = m.dataset_id AND s.session_id = m.session_id
ORDER BY s.local_date, m.ordinal;
```

## Evaluate daily growth with real OpenAI models

```sh
npm run eval:growth -- --output backend/evaluation/runs/my-growth-run
```

The command loads the project `.env` and uses the configured **real OpenAI provider**. `OPENAI_API_KEY` and accessible classification, dialogue, and checking models are required. There is no fake-provider evaluation option and no substitute fake reply when a real request fails. The standalone `npm run demo` remains an authored development demonstration, separate from model evaluation.

By default, the command reads the imported archive at `.miu-data`, verifies its checksum against the generated exports, and requests a replay of all 1,466 child turns across 365 dates through the application. One isolated database and profile persist for the run. The source archive and normal development memories are not modified. Each source assistant reply remains reference evidence and is never supplied as a heard engine response.

At each local midnight, the harness advances simulated real privacy time and effective narrative time, invokes maintenance, and measures SQL state before session-open catch-up can hide a missing daily job. It repeats the update to check idempotency, opens the day's session, and sends started/completed delivery receipts only for approved returned text. A blocked or failed real-model request stops the replay with a recorded blocking stage/code. Later dates and turns remain unattempted rather than receiving fabricated results.

The run writes `report.md`, `analysis.json`, `days.jsonl`, `turns.jsonl`, `snapshots.jsonl`, the independent expectation catalog, and the final isolated state. The report identifies the configured models, recorded provider calls, model-authored replies, authored bypasses if any, attempted coverage, and blocking errors. A `real` label alone does not certify that a response came from a model; inspect its per-turn execution evidence. Output directories must be new so previous evidence remains available. Use `--archive-dir <directory>` for another imported local database or `--from-files` to replay the generated exports without a database archive.

The 40 curated expectations are anchored to exact child words across all 12 months. They test natural name and preference capture, corrections, recent recall, privacy, supported story continuity, and real-time retention. Positive prerequisites prevent an absent memory from being mislabeled as successful deletion or expiry. Expected facts come from those source anchors, not a local parser. Optional local parser compatibility diagnostics remain separate development artifacts and are excluded from real-model evaluation results.

Automatic state and structural checks do not establish full dialogue quality. Semantic expectations require independent review of the actual model replies; a generation-time safety check is not an independent quality judgment. No voice/audio behavior is tested. `--fail-on fail` makes observable assertion failures return a nonzero process exit code for CI; execution blocks are reported as failed/blocked real-model attempts.

Earlier files under `evaluation/runs/growing-year-baseline` and `evaluation/runs/baseline-fake` are retained as **`diagnostics_not_model_evaluation`**. They used authored/fake output and support no conclusions about actual OpenAI model performance. Their raw evidence is preserved for provenance, and it must not be pooled with real-model results.

For a contest deadline, run the focused real-model smoke suite:

```sh
npm run eval:quick -- --concurrency 4 --judge-model gpt-6-astra
```

This runs 32 child turns across six scenarios covering Vietnamese proper names, corrections, memory consent, next-day idempotency, story continuation, and personality continuity. Four independent databases run concurrently; turns within each scenario stay sequential. It uses the configured engine models and an explicitly selected independent judge. Omit `--judge-model` for state/structural checks only; semantic criteria then remain unreviewed. Reports and authentic API evidence are saved in a new directory under `backend/evaluation/runs`. Use repeated `--scenario SC-...` flags to choose other cases. This focused suite does not establish full-year behavior; keep the year replay as the broader check.

The quick command exits unsuccessfully for behavioral failures by default. `--fail-on none` keeps the report without a quality exit gate; `--fail-on review` also fails unresolved review. `diagnostics.json` separates execution errors, checker rejection codes, scenario assertions, and semantic review coverage. A completed run is distinct from a passing run.

## Data model

The migrations live in [memory/migrations](memory/migrations/001_character_memory.sql). Every personal record belongs to one profile, and composite foreign keys prevent references across profiles.

| Data | Storage |
| --- | --- |
| Child display name, age band, language, timezone | `profiles` |
| Miu's MBTI style, role, canon, assigned story | `miu_configs` |
| Proper names, pets, toys, fictional story characters | `entities`, `entity_aliases` |
| Hobbies, likes, dislikes, everyday fears, self-described traits, story preferences, routines | `facts` with a bounded `category` |
| People around the child and their relationships | `social_connections` linked to named people |
| Child-reported events and plans | `events` |
| Child-created stories and their named cast | `child_stories` |
| Next-day questions with source evidence | `followups` |
| Heard chapter and resumable activity state | `story_checkpoints` |
| Diary, current mood, daily growth theme and day count | `diary_entries`, `daily_states`, `character_growth` |
| Narrative clock and idempotent rollover | `demo_clocks`, `night_job_runs`, `clock_requests` |
| Provenance, expiry, deletion graph, learning receipts | `memory_records`, `memory_dependencies`, `turn_learning` |
| Idempotent entity-correction receipts | `memory_operation_receipts` |

The schema also reserves supported promises, approved Miu self-statements, and relationship milestones for future explicit capture flows. Those tables do not imply that arbitrary generated promises or relationship progression are implemented.

Child personality means a volunteered self-description such as “I am creative.” The engine does not assign the child an MBTI type or infer psychological traits. Miu's own selected personality is one of all 16 bounded style presets.

The current implementation still expires personal memories after 30 real days. This is legacy behavior: the [updated product policy](../docs/memory-retention-and-recall-policy.md) requires durable saved memories and age-based recall without deletion; its runtime migration is pending. Full transcripts live only in the current session and expire after 30 minutes idle. The database stores selected fields and content-free turn receipts. Names preserve Vietnamese accents. Supported capture patterns are intentionally bounded; uncertain or unsupported details are clarified or left unsaved.

Memory candidates must have literal evidence in an affirmative source clause. The classifier and storage boundary both reject question substrings, negated reports, hypothetical outcomes, and quoted or pretend real-world events. Independent asserted clauses can still be learned from a mixed utterance. New event records retain the bounded source clause, excerpt offsets, assertion type, polarity, and originating turn; legacy records retain absent provenance. The full input is used transiently for validation and cleared after playback.

## Character and learning behavior

`character/` exports `decide`, `buildPrompt`, `validateLocal`, `fallback`, canon, and presets. The deterministic director applies D01–D13 and supplies emotion, delivery, rhythm, allowed facts, and one memory hook. Comfort suppresses playful expressions. The model supplies words inside that plan.

`MiuApplication.prepareTurn()` prepares a response without learning from it. A valid `started` delivery receipt can mark a hook presented. A subsequent `completed` receipt transactionally learns the accepted child facts and advances any actually delivered story scene. Canceled, interrupted, rejected, or unheard story scenes do not advance progress. Duplicate turns and receipts are idempotent.

Completed word-reading practice stores only its literal topic, reading focus and source reference; named forgetting removes that checkpoint. Address permissions carry persistent, current-day or actual-session scope. The application passes the real server session ID through extraction, writes and reads; reopening cannot reuse a session grant. A separate safe activity clause in a nickname request can remain in current conversation context after old replay/history is invalidated.

Every published draft must pass local validation, raw output moderation and independent contextual checking. One bounded new draft may repair speech/grounding failures. A raw output flag may also trigger one shorter rephrasing only for a benign accepted input and an otherwise independently approved free-form draft with no semantic issues. The original flagged draft stays rejected; all gates run again on the replacement. Actual unsafe/unsupported-action judgments and repeated flags remain terminal, and exact authored speech is not rewritten through this exception. `generation.repairReason` and both attempts remain available in synthetic evaluation logs. This does not override a moderation decision or establish a new memory before completed playback.

Explicit questions such as “What is my dog's name?” and “What is my hobby?” select one eligible stored fact. A due follow-up is an inferred question with source IDs. For Mochi, “fell in a puddle” can authorize “Did Mochi get a bath?”; it cannot establish that a bath happened.

“Forget that” resolves against heard references or the latest learnable statement. Deletion removes dependent records, clears session/replay content, and increments a deletion epoch so stale work cannot reinsert it. Full-profile forgetting requires a confirmation that was actually delivered. Error responses after a committed deletion also carry `memory.invalidate_replay` so clients can clear cached content.

Explicit event retractions such as “I did not say Mochi got a bath today” resolve against a matching stored event, including after reopening. “I did not say that” uses the immediately preceding child utterance and clarifies when its target is ambiguous. Retraction removes the event and dependent hooks while preserving the subject, unrelated memories, and friendship stage. It commits independently of speech delivery; a later provider failure still carries cache invalidation. A retraction does not record a negative real-world outcome. Ordinary sharing uses grounded model wording; the checker receives the same bounded dialogue evidence and operation result as generation.

An accepted reporting correction carries `reportStatus: denied_by_child` in transient reply context. Miu accepts that the child did not make the disputed report; uncertainty can remain about whether the physical event happened. This distinction prevents a polite acknowledgement from leaving the actual correction unresolved.

Explicit entity-name corrections resolve the original entity within the active profile and rename it transactionally. The UUID remains stable, the correction becomes its source provenance, dependent references are updated or invalidated, and ordinary entity insertion is suppressed for that turn. Correction receipts contain fingerprints and opaque IDs rather than discarded names or raw dialogue. Ambiguous identities require clarification.

Scoped hashes of retired spellings allow a later child-supplied old name to resolve to the same corrected entity after reopening. They do not restore old aliases or reconstruct undisclosed names. In the legacy implementation these receipts expire after 30 real days and cascade away with entity/profile deletion. The durable-memory migration must preserve authoritative correction handling for surviving sources rather than treating this deadline as the new policy. Quoted, hypothetical, reported, and pretend corrections cannot rename a real entity.

Do-not-save requests suppress current-turn capture without deleting existing memories. Suppressed disclosures are excluded from later session dialogue context. Generation and checking share a bounded grounding payload containing relevant eligible records, current-turn evidence, active story metadata, and actual operation outcomes. Explicit preference and story-title questions can therefore use stored data without advancing a chapter. Session-level game and question boundaries remain active until the child explicitly welcomes those activities again. Hobby equality handles the optional Vietnamese activity verb while preserving the source wording for display.

## Daily growth

One profile timezone and effective clock drive narrative dates. While the server runs, idle maintenance checks for rollover each minute. Opening a session or reading context catches up after downtime. No background speech is started.

Rollover creates the current day's authored mood, diary, fictional story episode, growth theme, and eligible follow-up questions exactly once. `growthDays` advances with local calendar dates, independent of visits. The initial small diary/theme library rotates; the persisted day count continues growing. Daily themes express curiosity, imagination, patience, listening, trying, and kindness while Miu retains its selected core personality.

The Next day operation targets 09:00 on the following local date, commits clock and daily state together, and closes the previous session. Repeated request IDs do not advance another day. It refuses while a turn awaits completion or cancellation. Privacy retention always follows actual wall time.

The [story library](stories/index.ts) supplies assigned adventures; chapter advancement and daily fictional episodes have separate clocks. A story checkpoint advances through heard delivery, while daily fictional growth advances through calendar rollover.

## Text integration API

Run `npm run start:engine` for this standalone harness. Its `/api/engine` routes are separate from the integrated voice server's `/api/sessions`, `/api/demo/panel`, and `/api/demo/next-day` routes. The harness `/health` reports `audio: false`. Both modes use the fictional `an` and `binh` demo profiles; these tokens are not production authentication or child registration.

| Method and route | Request or result |
| --- | --- |
| `GET /health` | Provider mode and text/audio capabilities |
| `POST /api/engine/sessions` | `{ "demo_profile_key": "an" }` → session ID, demo token, scoped context |
| `POST /api/engine/sessions/{id}/turns` | `{ "request_id": "<uuid>", "kind": "utterance", "text": "My dog Mochi fell in a puddle" }` |
| `POST /api/engine/sessions/{id}/turns` | `{ "request_id": "<uuid>", "kind": "greeting" }` for a new eligible session |
| `POST /api/engine/sessions/{id}/turns/{turn}/playback` | A unique request ID, `started` then `completed` or `interrupted`, and response `state_version` |
| `DELETE /api/engine/sessions/{id}/turns/{turn}` | Cancel pending generation/delivery |
| `DELETE /api/engine/sessions/{id}` | Close and discard session context |
| `GET /api/engine/profile` | Current scoped memories, social circle, growth, clock, and story state |
| `PATCH /api/engine/config` | Personality, role, language mode, or approved voice; optional idempotent request ID |
| `POST /api/engine/next-day` | `{ "request_id": "<uuid>", "expected_clock_version": 1 }` |

After opening a session, send `Authorization: Bearer <demo_token>` on subsequent requests. Request IDs are UUIDs. Mutations use JSON and reject unknown fields. Text-harness receipts acknowledge deliberate delivery in this harness; the voice pipeline must send them based on actual audio playback. Keep one active turn per profile. Responses and committed deletion errors carry version/invalidation information which clients must honor.

## OpenAI adapter

Integrated `npm start` uses real providers and requires `OPENAI_API_KEY` plus ElevenLabs credentials. The standalone engine adapter defaults to `MIU_PROVIDER=fake` when no mode is set; select its real mode with `MIU_PROVIDER=real` and `OPENAI_API_KEY`. Behavioral evaluations require real requests and reject a fake provider. The classifier and contextual checker use strict Structured Outputs; dialogue uses plain text. Responses calls use `store: false`, no database tools, bounded output, cancellation, and no automatic retries. Input/output moderation and contextual checking supplement the local validators. Official references: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses).

Stage defaults are `gpt-5.6-luna` for classification, reply generation and contextual checking, using supported `reasoning.effort: none` to avoid unnecessary reasoning latency. Explicit `OPENAI_CLASSIFY_MODEL`, `OPENAI_REPLY_MODEL`, and `OPENAI_CHECK_MODEL` values override these defaults without silently retrying another model. Older GPT-6 Astra overrides retain supported `low` reasoning. `OPENAI_MODERATION_MODEL` remains `omni-moderation-latest`; both input and output moderation still run, and contextual approval remains required before delivery. Evaluate the chosen configuration with actual provider requests; earlier model comparisons retain their original provenance.

Classification uses a compact strict JSON wire format mapped back to the same canonical observations before source-evidence validation. Scoped identities include known species and toy subtype; oversized historical exchanges are omitted whole instead of cutting off a possible negation. Typed pet-identity questions use eligible profile records, preserve same-species ambiguity, and cannot recover deleted or expired identities from transient history. Isolated unit tests may use transport mocks to test these contracts; they are not model-performance evidence. `eval:growth` requires real provider execution, while real voice latency remains a separate speech/UI measurement.

Use adult testers and fictional data for this prototype. `store: false` does not configure zero provider retention. Real child data requires the provider controls described in the [OpenAI under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance) and [data controls](https://developers.openai.com/api/docs/guides/your-data).
