Real integrated HTTP verification: completed_with_unresolved_failures

| Check | Status | Error |
| --- | --- | --- |
| startup | passed |  |
| an_session_config | failed | not_found |
| prepare_does_not_learn | blocked | dependency_an_session_config |
| completed_delivery_learns_once | blocked | dependency_prepare_does_not_learn |
| receipt_retry_is_idempotent | blocked | dependency_completed_delivery_learns_once |
| rename_preserves_entity_identity | blocked | dependency_completed_delivery_learns_once |
| next_day_reopen_recall | blocked | dependency_rename_preserves_entity_identity |
| cancel_unheard_preference | blocked | dependency_an_session_config |
| no_save_suppresses_capture | blocked | dependency_rename_preserves_entity_identity |
| binh_profile_isolation | blocked | dependency_rename_preserves_entity_identity |
| real_audio_stt_engine_tts | blocked | dependency_an_session_config |
| actual_openai_request_provenance | failed | no_actual_model_reply_response_ids |
| public_database_preserved | passed |  |

Playback receipts are simulated HTTP started/completed/interrupted messages. No physical iPad, microphone, speaker playback, or child listening was verified.

Actual OpenAI requests: 0; completed reply responses with IDs: 0.
