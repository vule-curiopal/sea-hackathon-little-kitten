# Miu engine evaluation

This environment runs synthetic conversations through the actual `MiuApplication`, character director, provider, memory store, and playback-receipt lifecycle. The catalog contains **102 scenarios, 207 conversations, and 550 scenario turns**. Every scenario has multiple conversations, and every scenario turn has explicit assertions and a semantic acceptance rubric.

**Character and memory evaluation requires the real provider and actual model requests.** This is the user's project policy, recorded in [AGENTS.md](../../AGENTS.md). The fake provider is reserved for frontend and pipeline development. Offline unit or harness doubles can check local logic, but their output is not character, memory, or model-quality evidence.

The input history is the [365-day fictional An dataset](../fixtures/conversations/README.md). The runner replays its **child messages only**. Miu's reference replies in that dataset never become engine answers, heard dialogue, or directly inserted memories. The answers saved here are the application's actual replies, including generic fallbacks and execution failures.

## Run the environment

Run commands from the repository root with dependencies installed and Node 22.18 or newer. The evaluation CLI loads the project `.env` when present for real execution; credentials can also come from the server-side process environment. The Node commands below explicitly select `.env` with `--env-file` as an alternative entry point. Neither workflow prints or copies its contents.

```sh
npm run eval:catalog
node --env-file=.env --import tsx backend/scripts/run-engine-evaluation.ts --provider real --history full --output backend/evaluation/runs/my-real-run
```

`eval:catalog` validates the authored cases and exports [scenarios/catalog.v1.json](scenarios/catalog.v1.json). The core cases cover everyday questions, games, nonsense, language switching, names, tâm sự, mood, memory, correction, deletion, and privacy. The advanced cases add configuration, fictional life, story resumption, stopping, retries, clocks, expiry, and relationship boundaries. See [core.ts](scenarios/core.ts) and [advanced.ts](scenarios/advanced.ts) for the actual inputs and expected behavior.

The evaluation CLI defaults to `real` and rejects `--provider fake`; the runner also enforces the real-provider requirement. Real runs call the configured classification, reply, and safety services while using an isolated **in-memory PGlite database**. They do not connect through `DATABASE_URL` or modify production memories. A generic acknowledgement does not satisfy a scenario that requires arithmetic, a game move, a correction, or a specific answer. A blocked real request remains a recorded failure rather than receiving a substitute fake answer.

Real behavioral runs are labeled `run_kind: character_memory_evaluation`. Offline checks of the runner, evaluator, or unit contracts are labeled `harness_self_test` and support no model-quality conclusion. Inspect actual provider/API execution and reply authorship evidence: a `real` mode string alone does not establish that a model generated an answer.

Choose a new output directory for each engine run; the runner refuses to overwrite an existing run directory. Earlier files under [runs/baseline-fake](runs/baseline-fake) and `runs/growing-year-baseline` are retained only as **`diagnostics_not_model_evaluation`**. They used fake or authored output, provide no character or memory quality evidence, and must not be pooled with real-provider evaluation results.

Select a smaller run with repeated `--scenario` arguments or a catalog-order limit:

```sh
node --env-file=.env --import tsx backend/scripts/run-engine-evaluation.ts --provider real --history none --scenario SC-001 --scenario SC-044 --output backend/evaluation/runs/two-real-cases
node --env-file=.env --import tsx backend/scripts/run-engine-evaluation.ts --provider real --history none --limit 10 --output backend/evaluation/runs/first-ten-real
```

`--history full` first replays all 365 daily historical conversations as one standalone chronological history. It then resets state before each isolated scenario and replays only that scenario's declared `history_dates` before its test conversations. State persists between conversations within a scenario and stays isolated from every other scenario.

`--history none` is the default and skips the standalone year replay. It **does not skip scenario-specific historical seeds**. Both modes load and validate the historical fixture because selected scenarios can depend on it. Use `--history full` explicitly when the standalone year should also be replayed. Consequently, a full run's total conversations and turn records exceed the catalog's 207 conversations and 550 scenario turns.

Serving and evaluation share classification instructions, assertion-scope validation, and persistence guards. Evaluation additionally requires a real reply request for exact authored plans and records provider provenance. [SC-101 and SC-102](scenarios/memory-regressions.ts) cover mixed statements/questions, negation, affirmative reports, retraction after reload, and legacy-state repair. SC-102's `initial_memory` is deliberately corrupt authored state with no assertion provenance, labeled `synthetic_legacy_fixture_not_learning_evidence` in both its definition and the run manifest. Its initial records establish the repair precondition only; they cannot establish successful learning. All responses and correction behavior still run through the real provider and application.

```sh
node --env-file=.env --import tsx backend/scripts/run-engine-evaluation.ts --provider real --history none --scenario SC-031 --scenario SC-101 --scenario SC-102 --output backend/evaluation/runs/memory-regression-real --fail-on fail
```

With credentials already supplied to the process, the npm entry point is `npm run eval:run -- --provider real --history full --output NEW_DIRECTORY`. For the separate continuous daily-growth evaluation, see the [real-model growth workflow](../README.md#evaluate-daily-growth-with-real-openai-models): `npm run eval:growth -- --provider real --output NEW_DIRECTORY`. That workflow also requires actual model requests; its former fake baseline is diagnostic material only.

## Delivery, time, and state

For ordinary turns, the runner calls `prepareTurn`, then sends a simulated `started` receipt and a `completed` receipt through the real application. A configured interrupted turn sends `started` followed by `interrupted`; a canceled turn calls the actual cancellation operation. Selected cases retry the same turn request or completion receipt to check idempotency. Session boundaries close and reopen real application sessions; an explicit reload transition recreates the application while retaining the scenario's database.

Assertions inspect actual state before and after these operations. They can therefore detect whether learning, deletion, checkpoints, profile isolation, and invalidation happened, rather than accepting a spoken claim that they happened. Simulated receipts establish the harness's delivery state; they do not establish that a person heard audio.

Each scenario controls the clock in `Asia/Ho_Chi_Minh`. Ordinary chronological gaps advance both fixture wall time and narrative time, exercising the application's daily rollover and privacy expiry. Explicit `next_day` transitions call the application's Next day operation and advance narrative time without artificially aging privacy records. `next_day_retry` repeats the same operation identifier. The runner records the resulting state and receipts instead of editing engine-owned clock rows to manufacture expected outcomes.

## Inspect saved evidence

| File | Contents |
| --- | --- |
| `transcripts.md` | Readable child inputs and actual Miu answers, with timestamps, provider mode, delivery state, and execution errors. |
| `turns.jsonl` | One record per attempted application turn: input, actual response and presentation, before/after memory snapshots, wall and narrative timestamps, delivery, retries, assertions, rubric, and classifier/reply/safety provider traces. |
| `conversations.jsonl` | Conversation boundaries, profile, phase, transition details, turn counts, and error counts. |
| `scenarios.json` | The exact selected scenario definitions for this run. |
| `manifest.json` | Run identity, provider, completion status, scope, model settings, labeled legacy-state preconditions, and hashes of relevant implementation files, the specification, scenario selection, and historical fixture. |
| `report.json`, `report.md` | Independent checks, scenario failures, semantic review queue, functional-requirement coverage, and director-rule coverage. |
| `review-tasks.jsonl` | Human-review templates bound to each exact scenario-turn record and its rubric. |

Turn phases are `history`, `scenario_history`, and `scenario`. The first two contain engine answers to replayed historical child inputs; `scenario` contains the authored acceptance cases. Raw dialogue and state snapshots are included because this harness uses fictional test data. These artifacts are synthetic testing evidence, not a production transcript archive.

## Rebuild a report without rerunning Miu

```sh
npm run eval:report -- --input backend/evaluation/runs/my-real-run/turns.jsonl --output backend/evaluation/runs/my-real-report --fail-on fail
```

The evaluator reads recorded evidence and does not call the engine or an API. `--fail-on fail` exits unsuccessfully when any turn has a failed check. `--fail-on review` also exits unsuccessfully when any turn needs review. The default `--fail-on none` writes evidence even when failures exist; a successful command exit alone is not a passing evaluation. The engine-run command supports the same exit policies.

Independent checks cover bounded reply length, question count, director/presentation consistency, identity and relationship boundaries, grounded follow-up shape, observed deletion, delivery and learning behavior, and scenario-specific text/state assertions. The report includes all **26 functional requirements** from [product specification §13](../../docs/product-specification.md#13-functional-requirements) and all **13 director rules**. A listed row is a coverage account, not an assertion that the requirement passed.

Semantic rubrics remain `needs_review` until a valid independent human or model review is supplied. Structural correctness and the engine's own safety verdict do not prove factual accuracy, a coherent game, an appropriate emotional response, or a complete correction. Missing evidence remains visible. A short generic reply can pass length checks while failing the scenario's answer requirement.

## Human semantic review

Create a working copy of a run's `review-tasks.jsonl` and inspect the corresponding transcript and `turns.jsonl` records. For each reviewed turn:

1. Preserve `key` and `evidence_sha256` exactly, and keep `source` as `human`.
2. Fill `reviewer` with a nonempty reviewer identifier.
3. Keep every criterion's exact zero-based `index` and `criterion` text. Set its status to `pass`, `fail`, or `needs_review`, and add a nonempty evidence explanation using the actual reply and observed state.
4. Fill the overall status and evidence. Any failed criterion requires an overall failure; an unresolved criterion prevents an overall pass.

Unedited templates have blank reviewer/evidence fields and are not accepted as completed reviews. Reviews are bound to the full immutable turn record by a SHA-256 hash. Changed logs, changed criteria, missing or duplicate criteria, stale hashes, and multiple reviews for the same turn cannot silently certify a pass. Provide one review per turn in a review file; unreviewed turns remain unresolved.

```sh
npm run eval:report -- --input backend/evaluation/runs/my-real-run/turns.jsonl --reviews backend/evaluation/runs/human-review/reviews.jsonl --output backend/evaluation/runs/human-report --fail-on review
```

A valid semantic review can resolve its rubric and relevant semantic flags. It cannot override a failed deterministic assertion, an execution failure, or a rule violation observed in the recorded evidence.

## Real-provider configuration and optional model judge

Real-provider execution is required for this environment and makes API requests. A small live sample uses the same required provider as a full run:

```sh
node --env-file=.env --import tsx backend/scripts/run-engine-evaluation.ts --provider real --history none --scenario SC-001 --output backend/evaluation/runs/live-sample
```

Real execution requires `OPENAI_API_KEY`. The application provider also reads `OPENAI_CLASSIFY_MODEL`, `OPENAI_REPLY_MODEL`, `OPENAI_CHECK_MODEL`, and `OPENAI_MODERATION_MODEL`; the run manifest records the effective model settings. This uses actual classification, reply, and safety services through the application's provider adapter. It still exercises the text application path and simulated delivery receipts.

The optional judge evaluates recorded answers independently of the engine's `provider.check` verdict. Select its model explicitly and start with a conversation sample:

```sh
node --env-file=.env --import tsx backend/scripts/judge-engine-answers.ts --input backend/evaluation/runs/my-real-run/turns.jsonl --model YOUR_JUDGE_MODEL --output backend/evaluation/runs/judge-sample --limit 5
```

`--limit` counts scenario conversations, not individual turns. The judge reviews ordered conversation evidence and available prior context, then writes `reviews.jsonl`, `judge-manifest.json`, and combined reports. Optional `--concurrency` accepts 1–4. Judging an existing real-provider run does not rerun the engine or replace its recorded answers. Applying a real model judge to fake output does not turn that output into a real character or memory evaluation.

The implementation uses the Responses API with structured output and `store: false`; see [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). The test catalog supplies fixed inputs and acceptance criteria, while the judge supplies separate semantic assessments; see [evaluation datasets](https://developers.openai.com/api/docs/guides/evaluation-getting-started). Judge outcomes remain fallible evidence. Invalid, missing, contradictory, or failed judge responses leave the affected criteria unresolved, and independent failures retain priority.

## Scope of the result

This harness measures text execution and inspects application state and presentation plans. It does not test microphone capture, STT, TTS, audible playback, browser behavior, physical gestures, touch animation, actual acoustic cues, or end-to-end voice latency. `elapsed_ms` and provider-stage timings describe text processing only.

Unexercised voice/UI requirements are marked `not_tested`, and mixed requirements retain their incomplete scope; an observed independent failure still takes precedence. Passing a sampled text assertion does not establish whole-product acceptance or completion of a P1 feature. Use the generated reports to identify concrete failures, unresolved semantic judgments, and the voice/UI checks still needing their own execution environment.
