-- Consent validity is independent from the record's thirty-day retention.
ALTER TABLE address_preferences ADD COLUMN scope text NOT NULL DEFAULT 'persistent'
  CHECK(scope IN ('persistent','day','session'));
ALTER TABLE address_preferences ADD COLUMN valid_local_date date;
ALTER TABLE address_preferences ADD COLUMN session_id text;
ALTER TABLE address_preferences ADD CONSTRAINT address_permission_scope CHECK(
  (scope='persistent' AND valid_local_date IS NULL AND session_id IS NULL)
  OR (scope='day' AND valid_local_date IS NOT NULL AND session_id IS NULL)
  OR (scope='session' AND valid_local_date IS NULL AND session_id IS NOT NULL AND char_length(session_id) BETWEEN 1 AND 128)
);

-- Earlier versions kept only the chosen name, so the original grant's duration
-- cannot be recovered. Revoke uncertain legacy nickname consent rather than
-- silently extending a possible "today" permission. Existing denials survive.
WITH RECURSIVE obsolete(profile_id,id) AS (
  SELECT d.profile_id,d.derived_id FROM memory_dependencies d
    JOIN address_preferences a ON a.profile_id=d.profile_id AND a.id=d.source_id
    WHERE a.allow_nickname
  UNION SELECT d.profile_id,d.derived_id FROM memory_dependencies d
    JOIN obsolete o ON o.profile_id=d.profile_id AND o.id=d.source_id
)
DELETE FROM memory_records r USING obsolete o WHERE r.profile_id=o.profile_id AND r.id=o.id
  AND NOT EXISTS(SELECT 1 FROM address_preferences a WHERE a.profile_id=r.profile_id AND a.id=r.id);
WITH revoked AS (
  UPDATE address_preferences a SET preferred_address=p.display_name,
    allow_nickname=false,nickname=NULL,
    source_evidence=jsonb_build_object('clause',p.display_name,'permission','unverified_legacy_scope')
  FROM profiles p WHERE p.id=a.profile_id AND a.allow_nickname
  RETURNING a.profile_id
)
UPDATE profiles SET deletion_epoch=deletion_epoch+1,state_version=state_version+1
WHERE id IN (SELECT profile_id FROM revoked);
UPDATE relationship_states s SET nickname_reference=NULL
FROM address_preferences a WHERE a.profile_id=s.profile_id AND NOT a.allow_nickname;

-- Small source-grounded learning context, never an ability or personality trait.
-- Its registry/dependency ownership gives it the same expiry and forget rules.
CREATE TABLE activity_checkpoints (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK(kind='word_practice'),
  term text NOT NULL CHECK(char_length(term) BETWEEN 1 AND 80),
  normalized_term text NOT NULL,
  focus text NOT NULL CHECK(focus='reading'),
  language text NOT NULL CHECK(language IN ('vi','en')),
  local_date date NOT NULL,
  source_evidence jsonb NOT NULL CHECK(jsonb_typeof(source_evidence)='object'),
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,kind,normalized_term,focus,language),
  FOREIGN KEY(profile_id,id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
