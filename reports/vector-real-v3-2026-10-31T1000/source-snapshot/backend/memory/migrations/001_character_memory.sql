CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  demo_key text NOT NULL UNIQUE CHECK (char_length(demo_key) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  age_band text NOT NULL CHECK (age_band IN ('4-5','6-8')),
  language_mode text NOT NULL CHECK (language_mode IN ('vi','en','follow_child')),
  timezone text NOT NULL,
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  deletion_epoch integer NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  created_at timestamptz NOT NULL
);
CREATE TABLE miu_configs (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  personality text NOT NULL CHECK (personality IN ('ISTJ','ISFJ','INFJ','INTJ','ISTP','ISFP','INFP','INTP','ESTP','ESFP','ENFP','ENTP','ESTJ','ESFJ','ENFJ','ENTJ')),
  role text NOT NULL CHECK (role IN ('friend','big_sibling','teacher')),
  voice_id text NOT NULL DEFAULT 'miu-default',
  canon_version text NOT NULL DEFAULT 'miu-v1'
);
CREATE TABLE demo_clocks (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('real','demo')),
  effective_anchor timestamptz NOT NULL,
  wall_anchor timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
-- Registry gives every heterogeneous dependency endpoint a real, scoped FK.
CREATE TABLE memory_records (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('entity','preference','relationship','event','story','followup','checkpoint','promise','diary','self_statement','milestone')),
  source_turn_id text NOT NULL,
  candidate_key text NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('child_reported','reported_plan','inferred_question','approved_fiction','supported_promise')),
  scope text NOT NULL CHECK (scope IN ('reported_real','fictional')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (profile_id,id),
  UNIQUE (profile_id,source_turn_id,candidate_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX memory_expiry ON memory_records(profile_id,expires_at);
CREATE TABLE memory_dependencies (
  profile_id uuid NOT NULL,
  source_id uuid NOT NULL,
  derived_id uuid NOT NULL,
  PRIMARY KEY (profile_id,source_id,derived_id),
  FOREIGN KEY (profile_id,source_id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id,derived_id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  CHECK (source_id <> derived_id)
);
CREATE TABLE entities (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('person','pet','object','story_character')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  normalized_name text NOT NULL,
  species text,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,kind,normalized_name),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE entity_aliases (
  profile_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  alias text NOT NULL,
  PRIMARY KEY(profile_id,entity_id,alias),
  FOREIGN KEY(profile_id,entity_id) REFERENCES entities(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE facts (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('hobby','like','dislike','fear','self_description','story_preference','routine')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 300),
  normalized_value text NOT NULL,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,category,normalized_value),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE social_connections (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  entity_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('mother','father','sibling','friend','teacher','grandparent','cousin','relative','other')),
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,entity_id,relation),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id,entity_id) REFERENCES entities(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE events (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  subject_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('fell_in_puddle','reported_event','planned_activity')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 500),
  local_date date NOT NULL,
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id,subject_id) REFERENCES entities(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE child_stories (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  cast_names text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE followups (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  rule_id text NOT NULL,
  due_local_date date NOT NULL,
  question_en text NOT NULL,
  question_vi text NOT NULL,
  status text NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','reserved','presented','resolved','canceled')),
  reserved_turn_id text,
  reserved_until timestamptz,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,source_id,rule_id),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id,source_id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE INDEX due_followups ON followups(profile_id,status,due_local_date);
CREATE TABLE story_checkpoints (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  template_id text NOT NULL,
  chapter integer NOT NULL CHECK(chapter >= 0),
  status text NOT NULL CHECK(status IN ('active','complete')),
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_active_story ON story_checkpoints(profile_id) WHERE status='active';
CREATE TABLE promises (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  capability text NOT NULL CHECK(capability='resume_story'),
  status text NOT NULL CHECK(status IN ('open','fulfilled','canceled')),
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id,checkpoint_id) REFERENCES story_checkpoints(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE miu_self_statements (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  canon_reference text NOT NULL,
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE diary_entries (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  local_date date NOT NULL,
  template_id text NOT NULL,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,local_date),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE daily_states (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  mood text NOT NULL CHECK(mood IN ('content','curious','mellow')),
  growth_days integer NOT NULL CHECK(growth_days >= 0),
  growth_theme text NOT NULL,
  diary_template_id text NOT NULL,
  episode_template_id text NOT NULL,
  UNIQUE(profile_id,local_date)
);
CREATE TABLE character_growth (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  first_local_date date NOT NULL,
  last_local_date date NOT NULL,
  growth_days integer NOT NULL DEFAULT 0 CHECK(growth_days >= 0)
);
CREATE TABLE relationship_states (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'getting_acquainted' CHECK(stage IN ('getting_acquainted','buddies','best_friends')),
  familiarity_permitted boolean NOT NULL DEFAULT false,
  nickname_reference uuid,
  FOREIGN KEY(profile_id,nickname_reference) REFERENCES memory_records(profile_id,id) ON DELETE SET NULL (nickname_reference)
);
CREATE TABLE night_job_runs (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY(profile_id,local_date)
);
CREATE TABLE clock_requests (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  expected_version integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(profile_id,request_id)
);
CREATE TABLE turn_learning (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  deletion_epoch integer NOT NULL,
  status text NOT NULL CHECK(status IN ('complete','discarded')),
  completed_at timestamptz NOT NULL,
  PRIMARY KEY(profile_id,turn_id)
);
