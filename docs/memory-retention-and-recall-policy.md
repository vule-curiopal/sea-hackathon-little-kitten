# Durable memory and age-based recall

**User decision, 2026-10-31: retain saved memories; do not automatically delete them after 30 days.**

An older memory may be less likely to come to mind, using an age-dependent random factor. This affects conversational recall, not whether the fact still exists in storage. The [vector integration plan](vector-memory-integration-plan.md) describes a proposed curve, seeded decisions and evaluation. The `feat/vector-memory` branch now implements durable storage and vector retrieval; the random age-availability policy remains unimplemented pending its product decisions. See [implementation details](vector-memory.md).

## Storage and eligibility

- Retain selected, permitted, source-grounded memories and their necessary derived index until explicit forgetting/deletion. A correction may retire its superseded active facts and dependent representations.
- Do not infer that every transcript, sensitive disclosure or assistant statement becomes a saved memory. Existing capture/no-save/fiction/evidence rules remain.
- Keep actual creation time, learned narrative date, explicit child reconfirmation date, source IDs and revisions. No required age-based `expiresAt` for ordinary durable memory.
- Day/session permission is a hard current-use restriction, separate from durable historical storage. Yesterday's nickname cannot become today's allowed address through search or randomness.
- Preserve explicit forgetting and dependency deletion. A stale job, backup, summary or vector cannot resurrect deleted content.
- Raw audio/session text, technical leases, daily presentation state and content-free operational diagnostics keep their separate lifecycle rules. Durable memory does not mean retaining full raw conversations.

## Age-dependent availability

Calculate age from when the memory was learned or explicitly reconfirmed, not the date of an old event newly reported today. The proposed clock is the profile's narrative local calendar, making Next day and year-scale synthetic tests reproducible; retain real timestamps independently.

Apply the age gate after retrieval and source-eligibility checks; evaluate retrieval correctness separately using known benchmark sources. Runtime candidate absence is not proof that no memory exists and cannot be relabeled intentional forgetting. If skipped, Miu may express temporary uncertainty or ask for a reminder without saying the child never told it or claiming deletion. Apply the decision consistently across duplicate/derived historical context, while preserving facts the child supplies in the current turn.

Use a stable draw across retries, paraphrases and workers within a defined window. Reindexing or an unrelated deletion must not reroll the draw. A genuine reminder may increase availability or explicitly reconfirm the same source; passive reads do not strengthen memory automatically. Once an episode has been recalled or recovered in the active conversation, keep it in working context until that conversation ends rather than making Miu immediately forget it again. This temporary continuity does not renew durable memory age.

Safety, deletion/no-save decisions, current identity/corrections, permission boundaries and supported active commitments remain deterministic controls. The exact application to direct ordinary historical questions versus spontaneous recall is still a user preference to settle before implementation. Numerical grace/half-life/floor values in the vector plan are illustrative, not accepted defaults.

## Migration and remaining age-policy work

The frozen baseline used the former 30-day expiry model. In `feat/vector-memory`, migration 011 makes ordinary expiry nullable, preserves surviving canonical rows, records learned/reconfirmation dates, and separates technical cleanup and hard permission validity. Some historical tests, including SC054/055 and the original frozen 100-case run, explicitly test legacy deletion and remain evidence for that old policy.

Completed storage work and remaining acceptance requirements:

1. Inventory every canonical/derived expiry write and purge, including entities, events, facts, stories, learning checkpoints, correction/retired-name receipts and supported commitments. Preserve necessary correction controls while their canonical sources survive.
2. Choose an explicit schema migration: nullable legacy expiry or separate durable-memory/hard-validity fields. Do not use a far-future timestamp to disguise indefinite storage.
3. Preserve hard permission/session/job validity while removing ordinary age-based deletion. Migrate surviving rows; do not reconstruct already deleted data from reference fixtures.
4. Version the product policy, catalog, evaluator and source evidence. Test durable survival at 30 days, a year and multiple years, plus explicit forgetting and correction races.
5. Add separately observable seeded recall behavior. Verify stored source/vector membership is unchanged by aging and skips, while output recall rates follow the configured curve.

No production migration or configuration change was performed. The local branch's implementation is separate from deployment; the undecided age curve and direct-versus-spontaneous policy remain future work.
