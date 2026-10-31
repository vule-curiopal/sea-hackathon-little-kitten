-- Mutation receipts establish retry identity, not playback or heard dialogue.
-- Hashes/opaque IDs only: no discarded names or raw correction text is retained.
CREATE TABLE memory_operation_receipts (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  turn_id text NOT NULL CHECK(char_length(turn_id) BETWEEN 1 AND 128),
  operation_kind text NOT NULL CHECK(operation_kind='entity_rename'),
  target_record_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  invalidated_record_ids uuid[] NOT NULL DEFAULT '{}',
  applied_state_version integer NOT NULL CHECK(applied_state_version > 0),
  applied_deletion_epoch integer NOT NULL CHECK(applied_deletion_epoch >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(profile_id,turn_id),
  FOREIGN KEY(profile_id,target_record_id) REFERENCES entities(profile_id,id) ON DELETE CASCADE
);
