# Vector memory implementation

Implemented on `feat/vector-memory` in its own worktree. The branch starts from
the frozen affect/SC026 source recorded in `vector-base-source.json`; it does
not silently include the other session's unfinished correctness/latency edits.
The first commit records that baseline and the following feature commit contains
this implementation. Production configuration and data are unchanged.

## Retrieval and source authority

Typed identity, current preference, permission, routine and date intents retain
their exact result, including missing or ambiguous results. Semantic search is
limited to approved historical/topic questions in the conversation domain.
Deterministic EN/VI topic extraction removes response-language directives and
politeness; it rejects oversized or additional disclosures instead of sending a
whole conversation upstream. Query vectors are ephemeral and uncached.

The initial semantic corpus contains canonical child-reported events,
explicitly volunteered preferences, and literal child-authored story excerpts.
Names, current favorite slots, permission rows, inferred traits, authored Miu
diaries/catalog text, session transcripts and synthetic archive answers are
excluded. A document dependent on address permission is also excluded. Planned
events retain their reported-plan status and conditions; fiction stays fiction.

One source produces one literal projection with source/dependency revisions and
a content hash. The provider payload contains no profile/session UUIDs. The
512-byte UTF-8 ceiling conservatively bounds token count; oversized complete
projections remain available to lexical search and are never truncated.

The application uses `text-embedding-3-large` at 1536 dimensions; the embedding
adapter also supports separately configured model spaces, uses floating-point output, validates count/index/model/dimensions,
and rejects non-finite or zero vectors. It makes no automatic SDK retries and
logs only bounded request/model/usage/error metadata. The configuration and API
shape follow [OpenAI's embedding reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

Per-profile lexical token coverage and exact cosine candidates are fused with
reciprocal-rank fusion: up to 20 candidates per lane, 30 in the union, and three
evidence cards. Cosine similarity is relevance, never factual confidence.
Current-query proper-name anchors constrain discovery with exact Unicode
boundaries; they do not establish identity or retain forgotten names. Canonical
actor kind/species, real/fictional scope, and bounded event-outcome guards prevent
a related fall/spill from establishing a bath, breakage or swimming outcome.
These lexical/ontology checks do not prove arbitrary natural-language entailment.

Before returning evidence, search reloads canonical tables and rechecks source,
dependency, revision and hash guards. The director, real reply model and checker
receive the same bounded evidence. Publication, cached replay and playback each
revalidate those cards, including their literal text and active generation. A
search miss permits honest uncertainty rather than an invented replacement or a
claim that storage was deleted.

## Persistence and workers

Migration `010_vector_memory.sql` adds revision tracking, generation metadata,
search documents/dependencies, embeddings and a content-free transactional job
queue. All personal joins and foreign keys include the profile. Source changes
invalidate derived documents; source deletion cascades through documents,
vectors and jobs. Search never uses the synthetic historical archive.

Completed learning commits its source and indexing job in one transaction.
Prepare, started playback, interruption, cancellation and no-save do not index
new disclosures. Workers claim a lease, read eligible content, release the
transaction, call the real provider, then conditionally commit. Current source
and dependency revisions/hash, deletion epoch, generation and lease must still
match. Provider failures are terminal until explicit retry; bounded lease
recovery after a crashed worker is a separate path. Canonical learning remains
valid if the embedding provider is unavailable.

An unrelated deletion fences an in-flight request conservatively but does not
make every surviving stored vector unreadable. Corrected/deleted content cannot
return through an old worker response. Model/dimension/projection settings form
an immutable generation; changing an active model requires an explicit rebuild
and cutover, rather than mixing coordinates.

Migration `011_durable_memories.sql` removes age-based expiry from surviving
canonical memories, adds learned/reconfirmation dates, and keeps technical
diary/follow-up deadlines separate. New inferred follow-up questions are limited
to recent 30-day events so technical cleanup cannot recreate a year-old hook;
the saved event and vector remain durable. It does not reconstruct previously deleted
content. Scoped address validity from migration 009 is enforced independently
of durable storage. Passive recall does not renew a memory's age. The separate
random age-availability policy remains pending its unresolved product choices.

## Database modes and bounds

Feature-off startup needs no vector extension or embedding key. Feature-on
`pgvector` explicitly initializes the extension and vector column. The pinned
PGlite package includes its vector module; no new package is required. Native
PostgreSQL needs compatible pgvector binaries and extension privileges supplied
by its operator. Optional extension DDL is separate from always-run migrations.

`array_exact` is an explicit extension-free cosine backend, not a silently
selected fallback. The application initially projects at most 1000 eligible
sources per profile and performs bounded exact search. Capacity overflow is
reported and degrades semantic retrieval without discarding canonical learning.
Larger corpora need paginated projection/indexing and a measured indexing plan;
ANN/HNSW is not part of this version.

The default query-embedding deadline is 1000 ms; unavailable or late embeddings
leave eligible lexical/typed retrieval available. This is an additional search
budget, not an established end-to-end audible latency SLO. The bounded real
acceptance harness uses an explicitly recorded 5000 ms query budget.

## Configuration and operations

The parameters are documented in `.env.example`. Add them to the existing
server-side `.env` when selecting a deployment configuration; never expose the
OpenAI key to the browser. No production environment was changed for this task.

```dotenv
MIU_MEMORY_SEARCH_ENABLED=1
MEMORY_VECTOR_BACKEND=pgvector
OPENAI_EMBEDDING_MODEL=text-embedding-3-large
OPENAI_EMBEDDING_DIMENSIONS=1536
OPENAI_EMBEDDING_TIMEOUT_MS=10000
MEMORY_SEARCH_TIMEOUT_MS=1000
MEMORY_MIN_COSINE_SIMILARITY=0.30
```

The 0.30 dense cutoff and 0.25 lexical-coverage cutoff are initial experimental
policy settings, measured on the small recorded calibration corpus. Changing
model/projection/normalization requires a new generation and fresh evaluation.
The integrated voice bridge and standalone text server both accept this setup.
The enabled service projects surviving canonical sources at startup and drains
jobs asynchronously. To enqueue a selected profile manually without provider
requests, then explicitly generate its real embeddings:

```sh
npm run memory:index -- --env-file /path/to/.env --profile an
npm run memory:index -- --env-file /path/to/.env --profile an --run
```

These commands migrate the configured database. `--data-dir LOCAL_DIRECTORY`
selects an isolated PGlite directory even if the environment has a server URL.
`--all-profiles` explicitly selects all profiles. `--max-batches` bounds work;
`--retry-failed` explicitly requeues failed jobs after the provider problem is
resolved. A selected-profile drain cannot claim another profile's jobs. Output
contains counts, generation/configuration, usage and error codes, not personal
text, names, vectors or credentials.

## Verification

`npm run verify:vector -- --env-file /path/to/.env --output NEW_DIRECTORY`
runs a fresh isolated database with real dialogue and embedding requests.
Its versioned benchmark binds expected IDs to actual completed canonical
captures and uses new sessions for recall, so prior assistant dialogue cannot
serve as the answer. It records lexical/dense/fused/final-card results, actual
API provenance, source fingerprints, and independent semantic-review status.

The benchmark includes EN/VI and cross-language paraphrases, typed missing and
ambiguous slots, profile isolation, no-answer, canceled/no-save captures,
correction/stale-worker exclusion, explicit forgetting, and controlled
365-day survival. It uses typed synthetic inputs and simulated playback
receipts; it establishes no physical microphone, audible playback, native
PostgreSQL, broad held-out quality target or year-long operational soak.

Separate offline tests cover adapter contracts, pure projection/ranking
boundaries, and database/queue mechanics. Those checks do not establish model
quality. The original 100-scenario result and prior affect runs remain attached
to their own source versions and are not relabeled as vector results.

The first real run passed 21/23 machine cases and failed both cross-language
queries; independent review also found a story-routing defect and an extra
irrelevant evidence card. That [failed run](../reports/vector-real-v2-2026-10-31T0900/report.md)
and its source archive are preserved. Subsequent [model/projection comparison](../reports/vector-embedding-calibration-v1-2026-10-31/report.md)
and [topic calibration](../reports/vector-topic-calibration-v1-2026-10-31/report.md)
used three actual embedding requests in total; they are calibration data, not a
held-out quality claim. The revised source uses actor/outcome filtering and
minimal topics as well as the changed model; any score improvement includes
all those changes. The real v3 run produced **28/29 machine passes**, with all
eight positive EN/VI/cross-language queries returning the correct sole source
card and genuine dense support. The remaining failure was pet-name routing of a
swimming question; its words were honest but vector search had been skipped.
See the [v3 report](../reports/vector-real-v3-2026-10-31T1000/report.md).

The final router fix passed a separate **8/8 real-model follow-up**, covering
actual captures, explicit/bare/ambiguous pet identity, known episodic recall and
that exact swimming negative. The negative now makes a real query-embedding
request and returns no unsupported evidence. All eight drafts/check results
and their API IDs are retained. See [focused evidence](../reports/vector-router-focused-real-v1-2026-10-31/report.md).
This is separate coverage, not a claim that the full 29-case suite was rerun on
the final source. The earlier v3 run had one bounded repair whose first rejected
draft was not retained; its published final draft is bound to the actual API ID,
and that provenance limit remains explicit.

Both runs closed their isolated databases and preserved unchanged source
fingerprints. Independent automated review found no unsupported outcome,
fiction-as-real claim or forgotten-source disclosure in their published words.
The corpus differs slightly because real classification captured two equivalent
hobby preference IDs in v2 and one in v3; that source-ID count change is not
credited as a retrieval improvement. Native PostgreSQL installation/runtime,
physical voice and broad production quality remain unverified by these runs.
