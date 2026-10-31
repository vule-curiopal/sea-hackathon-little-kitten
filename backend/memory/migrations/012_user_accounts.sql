-- Authentication identifiers and credentials never enter character memory.
CREATE TABLE user_accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9_][a-z0-9_.-]{2,31}$'),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 32 AND 256),
  profile_id uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
