-- Explicitly synthetic reference archives are separate from runtime child memory.
-- Reference assistant messages have no heard/playback/learning authority.
CREATE TABLE historical_datasets (
  id uuid PRIMARY KEY,
  dataset_key text NOT NULL UNIQUE CHECK(char_length(dataset_key) BETWEEN 1 AND 200),
  schema_version text NOT NULL CHECK(schema_version='miu-synthetic-year-v1'),
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic),
  response_origin text NOT NULL DEFAULT 'authored_reference' CHECK(response_origin='authored_reference'),
  content_checksum text NOT NULL CHECK(content_checksum ~ '^[0-9a-f]{64}$'),
  from_date date NOT NULL,
  to_date date NOT NULL,
  timezone text NOT NULL CHECK(timezone='Asia/Ho_Chi_Minh'),
  expected_profiles integer NOT NULL CHECK(expected_profiles=1),
  expected_sessions integer NOT NULL CHECK(expected_sessions=365),
  expected_messages integer NOT NULL CHECK(expected_messages > 0),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK(to_date >= from_date)
);
CREATE TABLE historical_profiles (
  dataset_id uuid NOT NULL REFERENCES historical_datasets(id) ON DELETE CASCADE,
  source_profile_id text NOT NULL CHECK(char_length(source_profile_id) BETWEEN 1 AND 100),
  display_name text NOT NULL CHECK(char_length(display_name) BETWEEN 1 AND 80),
  age_band text NOT NULL CHECK(age_band='6-8'),
  language_mode text NOT NULL CHECK(language_mode='follow_child'),
  timezone text NOT NULL CHECK(timezone='Asia/Ho_Chi_Minh'),
  persona jsonb NOT NULL CHECK(jsonb_typeof(persona)='object'),
  PRIMARY KEY(dataset_id,source_profile_id)
);
CREATE TABLE historical_sessions (
  dataset_id uuid NOT NULL,
  session_id text NOT NULL CHECK(char_length(session_id) BETWEEN 1 AND 100),
  source_profile_id text NOT NULL,
  local_date date NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  started_at_source text NOT NULL,
  ended_at_source text NOT NULL,
  language text NOT NULL CHECK(language IN ('vi','en','mixed')),
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 300),
  tags text[] NOT NULL CHECK(cardinality(tags)>0),
  child_age_years integer NOT NULL CHECK(child_age_years IN (6,7)),
  child_mood_source text NOT NULL CHECK(child_mood_source='author_annotation'),
  child_mood_start text NOT NULL,
  child_mood_end text NOT NULL,
  miu_daily_mood text NOT NULL CHECK(miu_daily_mood IN ('content','curious','mellow')),
  response_origin text NOT NULL DEFAULT 'authored_reference' CHECK(response_origin='authored_reference'),
  PRIMARY KEY(dataset_id,session_id),
  UNIQUE(dataset_id,source_profile_id,local_date),
  UNIQUE(dataset_id,session_id,source_profile_id),
  FOREIGN KEY(dataset_id,source_profile_id) REFERENCES historical_profiles(dataset_id,source_profile_id) ON DELETE CASCADE,
  CHECK(ended_at > started_at)
);
CREATE INDEX historical_sessions_by_date ON historical_sessions(dataset_id,local_date);
CREATE TABLE historical_messages (
  dataset_id uuid NOT NULL,
  message_id text NOT NULL CHECK(char_length(message_id) BETWEEN 1 AND 120),
  session_id text NOT NULL,
  source_profile_id text NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 12),
  role text NOT NULL CHECK(role IN ('user','assistant')),
  speaker text NOT NULL CHECK(char_length(speaker) BETWEEN 1 AND 80),
  occurred_at timestamptz NOT NULL,
  timestamp_source text NOT NULL,
  content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 6000),
  PRIMARY KEY(dataset_id,message_id),
  UNIQUE(dataset_id,session_id,ordinal),
  FOREIGN KEY(dataset_id,session_id,source_profile_id) REFERENCES historical_sessions(dataset_id,session_id,source_profile_id) ON DELETE CASCADE
);
CREATE INDEX historical_messages_chronological ON historical_messages(dataset_id,occurred_at,message_id);
