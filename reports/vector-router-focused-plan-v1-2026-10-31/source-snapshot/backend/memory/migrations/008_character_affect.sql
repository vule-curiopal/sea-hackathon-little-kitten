-- Fictional character state only. No transcript, disclosure, or child-emotion
-- label belongs in these tables. The feature remains dormant until core wiring.
CREATE TABLE character_affect_state (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-zA-Z0-9._-]{1,64}$'),
  local_date date NOT NULL,
  daily_mood text NOT NULL CHECK (daily_mood IN ('content','curious','mellow')),
  baseline_valence double precision NOT NULL CHECK (baseline_valence BETWEEN -1 AND 1),
  baseline_energy double precision NOT NULL CHECK (baseline_energy BETWEEN 0 AND 1),
  conversation_valence double precision NOT NULL CHECK (conversation_valence BETWEEN -1 AND 1),
  conversation_energy double precision NOT NULL CHECK (conversation_energy BETWEEN 0 AND 1),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  last_interaction_at timestamptz CHECK (last_interaction_at IS NULL OR isfinite(last_interaction_at)),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  updated_real_at timestamptz NOT NULL CHECK (isfinite(updated_real_at))
);

CREATE TABLE character_affect_receipts (
  profile_id uuid NOT NULL REFERENCES character_affect_state(profile_id) ON DELETE CASCADE,
  turn_hash text NOT NULL CHECK (turn_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-zA-Z0-9._-]{1,64}$'),
  local_date date NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (profile_id,turn_hash)
);
CREATE INDEX character_affect_receipt_expiry ON character_affect_receipts(profile_id,created_at);
