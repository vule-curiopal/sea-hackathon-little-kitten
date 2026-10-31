-- Additional source-grounded detail; records still share the same retention,
-- profile ownership, dependency closure, and deletion registry.
ALTER TABLE entities ADD COLUMN object_type text;
ALTER TABLE entities ADD COLUMN represents text;
ALTER TABLE facts ADD COLUMN slot text CHECK(slot IS NULL OR slot='favorite_color');
ALTER TABLE facts ADD COLUMN qualifiers jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(qualifiers)='object');
ALTER TABLE facts ADD COLUMN source_evidence jsonb;
ALTER TABLE social_connections ADD COLUMN source_evidence jsonb;
ALTER TABLE events ADD COLUMN conditions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(conditions)='array');
CREATE UNIQUE INDEX one_current_preference_slot ON facts(profile_id,slot) WHERE slot IS NOT NULL;

CREATE TABLE address_preferences (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  preferred_address text NOT NULL CHECK(char_length(preferred_address) BETWEEN 1 AND 80),
  allow_nickname boolean NOT NULL,
  nickname text CHECK(nickname IS NULL OR char_length(nickname) BETWEEN 1 AND 80),
  source_evidence jsonb NOT NULL,
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  CHECK(allow_nickname OR nickname IS NULL)
);

-- A turn can contain multiple independent explicit updates. The semantic key
-- makes retries idempotent while rejecting a changed payload for the same key.
CREATE TABLE memory_patch_receipts (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  turn_id text NOT NULL CHECK(char_length(turn_id) BETWEEN 1 AND 128),
  patch_key text NOT NULL,
  patch_kind text NOT NULL CHECK(patch_kind IN ('relationship','preference','routine','address')),
  target_record_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  invalidated_record_ids uuid[] NOT NULL DEFAULT '{}',
  applied_state_version integer NOT NULL,
  applied_deletion_epoch integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(profile_id,turn_id,patch_key),
  FOREIGN KEY(profile_id,target_record_id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
