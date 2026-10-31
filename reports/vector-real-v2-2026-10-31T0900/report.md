Real vector verification: completed_with_unresolved_failures

| Check | Status |
| --- | --- |
| capture_en_pet_event | passed |
| capture_en_hobby | passed |
| capture_child_story | passed |
| capture_vi_hobby | passed |
| capture_vi_pet_event | passed |
| index_corpus | passed |
| en_event_paraphrase | passed |
| en_hobby_paraphrase | passed |
| vi_hobby_paraphrase | passed |
| vi_to_en_event | failed |
| en_to_vi_event | failed |
| fictional_story_paraphrase | passed |
| unknown_no_answer | passed |
| typed_precedence | passed |
| typed_missing_app | passed |
| typed_ambiguous_app | passed |
| profile_isolation | passed |
| canceled_capture | passed |
| no_save_capture | passed |
| stale_embedding_after_correction | passed |
| forget_cascade | passed |
| after_forget_no_answer | passed |
| durability_365_days | passed |

Actual dialogue API requests: 100; actual embedding requests: 12. Fixed tiny benchmark; no 95% quality claim. Typed inputs and simulated receipts only. Separate semantic review pending. No production accessed.

Independent automated review of all 20 actual replies identified an additional story-routing/wording defect, both cross-language retrieval misses, and one irrelevant extra evidence card. See [independent-semantic-review.json](independent-semantic-review.json). Raw machine case counts remain unchanged. This run did not pass acceptance.
