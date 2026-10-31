-- Optional derived retrieval data. No vector extension is required to migrate.
ALTER TABLE memory_records ADD COLUMN content_revision bigint NOT NULL DEFAULT 1
  CHECK (content_revision BETWEEN 1 AND 9007199254740991);

CREATE TABLE search_generations (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  model text NOT NULL CHECK (model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$'),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  projection_version text NOT NULL CHECK (char_length(projection_version) BETWEEN 1 AND 100),
  normalizer_version text NOT NULL CHECK (char_length(normalizer_version) BETWEEN 1 AND 100),
  distance text NOT NULL CHECK (distance='cosine'),
  backend text NOT NULL CHECK (backend IN ('pgvector','array_exact')),
  status text NOT NULL CHECK (status IN ('building','shadow','active','retired')),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  UNIQUE (id,dimensions)
);
CREATE UNIQUE INDEX one_active_search_generation ON search_generations(status) WHERE status='active';

CREATE TABLE memory_search_documents (
  profile_id uuid NOT NULL,
  id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  projection_version text NOT NULL CHECK (char_length(projection_version) BETWEEN 1 AND 100),
  projection_key text NOT NULL CHECK (char_length(projection_key) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('event','preference','child_story')),
  scope text NOT NULL CHECK (scope IN ('reported_real','fictional')),
  document_text text NOT NULL CHECK (octet_length(document_text) BETWEEN 1 AND 16384),
  embedding_eligible boolean NOT NULL,
  learned_local_date date,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  PRIMARY KEY (profile_id,id),
  UNIQUE (profile_id,source_id,projection_version,projection_key),
  UNIQUE (profile_id,id,source_revision,content_hash),
  FOREIGN KEY (profile_id,source_id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE,
  CHECK (NOT embedding_eligible OR octet_length(document_text)<=512)
);
CREATE INDEX memory_search_document_profile ON memory_search_documents(profile_id,projection_version);

CREATE TABLE memory_search_document_dependencies (
  profile_id uuid NOT NULL,
  document_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (profile_id,document_id,source_id),
  FOREIGN KEY (profile_id,document_id) REFERENCES memory_search_documents(profile_id,id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id,source_id) REFERENCES memory_records(profile_id,id) ON DELETE CASCADE
);
CREATE INDEX memory_search_dependency_source ON memory_search_document_dependencies(profile_id,source_id);

CREATE FUNCTION memory_vector_coordinates_valid(coordinates real[], dimensions integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT array_ndims(coordinates)=1 AND array_lower(coordinates,1)=1
    AND cardinality(coordinates)=dimensions AND dimensions BETWEEN 1 AND 16000
    AND NOT EXISTS (SELECT 1 FROM unnest(coordinates) x
      WHERE x IS NULL OR NOT (x::double precision BETWEEN -3.4028234663852886e38 AND 3.4028234663852886e38))
    AND EXISTS (SELECT 1 FROM unnest(coordinates) x WHERE x<>0)
$$;

CREATE TABLE memory_embeddings (
  profile_id uuid NOT NULL,
  document_id uuid NOT NULL,
  generation_id text NOT NULL,
  source_revision bigint NOT NULL,
  content_hash text NOT NULL,
  dimensions integer NOT NULL,
  coordinates real[] NOT NULL,
  vector_hash text NOT NULL CHECK (vector_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (profile_id,document_id,generation_id),
  FOREIGN KEY (profile_id,document_id,source_revision,content_hash)
    REFERENCES memory_search_documents(profile_id,id,source_revision,content_hash) ON DELETE CASCADE,
  FOREIGN KEY (generation_id,dimensions) REFERENCES search_generations(id,dimensions) ON DELETE CASCADE,
  CHECK (memory_vector_coordinates_valid(coordinates,dimensions))
);

CREATE TABLE embedding_jobs (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL,
  document_id uuid NOT NULL,
  generation_id text NOT NULL REFERENCES search_generations(id) ON DELETE CASCADE,
  source_revision bigint NOT NULL,
  content_hash text NOT NULL,
  captured_deletion_epoch integer NOT NULL CHECK (captured_deletion_epoch>=0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','done','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_token uuid,
  lease_expires_at timestamptz,
  worker_id text CHECK (worker_id IS NULL OR worker_id ~ '^[a-zA-Z0-9._:-]{1,100}$'),
  next_attempt_at timestamptz NOT NULL CHECK (isfinite(next_attempt_at)),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-zA-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  FOREIGN KEY (profile_id,document_id,source_revision,content_hash)
    REFERENCES memory_search_documents(profile_id,id,source_revision,content_hash) ON DELETE CASCADE,
  UNIQUE (profile_id,document_id,generation_id,source_revision,content_hash),
  CHECK (status<>'leased' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND isfinite(lease_expires_at)))
);
CREATE INDEX embedding_job_queue ON embedding_jobs(status,next_attempt_at,created_at);

-- A source correction invalidates every copied dependency, across generations.
-- Epochs are not attached to surviving stored vectors: unrelated forgetting must
-- not erase or globally hide them.
CREATE FUNCTION memory_vector_invalidate_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.content_revision=OLD.content_revision THEN RETURN NEW; END IF;
  p:=OLD.profile_id; s:=OLD.id;
  DELETE FROM memory_search_documents d WHERE d.profile_id=p AND
    (d.source_id=s OR EXISTS(SELECT 1 FROM memory_search_document_dependencies x
      WHERE x.profile_id=p AND x.document_id=d.id AND x.source_id=s));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION memory_vector_source_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_revision<OLD.content_revision OR NEW.content_revision>OLD.content_revision+1 THEN
    RAISE EXCEPTION 'invalid_source_revision';
  END IF;
  IF NEW.content_revision=OLD.content_revision AND
    (to_jsonb(NEW)-'content_revision'-'learned_local_date'-'last_reconfirmed_local_date') IS DISTINCT FROM
    (to_jsonb(OLD)-'content_revision'-'learned_local_date'-'last_reconfirmed_local_date') THEN
    NEW.content_revision:=OLD.content_revision+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_vector_revision BEFORE UPDATE ON memory_records
  FOR EACH ROW EXECUTE FUNCTION memory_vector_source_revision();
CREATE TRIGGER memory_vector_invalidate_update AFTER UPDATE ON memory_records
  FOR EACH ROW EXECUTE FUNCTION memory_vector_invalidate_source();
CREATE TRIGGER memory_vector_invalidate_delete BEFORE DELETE ON memory_records
  FOR EACH ROW EXECUTE FUNCTION memory_vector_invalidate_source();

CREATE FUNCTION memory_vector_typed_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid;
BEGIN
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN p:=OLD.profile_id;
    IF TG_TABLE_NAME='entity_aliases' THEN s:=OLD.entity_id; ELSE s:=OLD.id; END IF;
  ELSE p:=NEW.profile_id;
    IF TG_TABLE_NAME='entity_aliases' THEN s:=NEW.entity_id; ELSE s:=NEW.id; END IF;
  END IF;
  UPDATE memory_records SET content_revision=content_revision+1 WHERE profile_id=p AND id=s;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vector_entity_revision AFTER INSERT OR UPDATE OR DELETE ON entities FOR EACH ROW EXECUTE FUNCTION memory_vector_typed_revision();
CREATE TRIGGER vector_alias_revision AFTER INSERT OR UPDATE OR DELETE ON entity_aliases FOR EACH ROW EXECUTE FUNCTION memory_vector_typed_revision();
CREATE TRIGGER vector_fact_revision AFTER INSERT OR UPDATE OR DELETE ON facts FOR EACH ROW EXECUTE FUNCTION memory_vector_typed_revision();
CREATE TRIGGER vector_social_revision AFTER INSERT OR UPDATE OR DELETE ON social_connections FOR EACH ROW EXECUTE FUNCTION memory_vector_typed_revision();
CREATE TRIGGER vector_event_revision AFTER INSERT OR UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION memory_vector_typed_revision();
CREATE TRIGGER vector_story_revision AFTER INSERT OR UPDATE OR DELETE ON child_stories FOR EACH ROW EXECUTE FUNCTION memory_vector_typed_revision();

CREATE FUNCTION memory_vector_dependency_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- A cascading registry deletion must never update another canonical tuple
    -- already being deleted by the same statement. Drop only derived rows.
    DELETE FROM memory_search_documents d WHERE d.profile_id=OLD.profile_id AND
      (d.source_id=OLD.derived_id OR EXISTS(SELECT 1 FROM memory_search_document_dependencies x
        WHERE x.profile_id=d.profile_id AND x.document_id=d.id AND x.source_id=OLD.derived_id));
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  UPDATE memory_records SET content_revision=content_revision+1 WHERE profile_id=NEW.profile_id AND id=NEW.derived_id;
  RETURN NEW;
END $$;
CREATE TRIGGER vector_dependency_revision AFTER INSERT OR UPDATE OR DELETE ON memory_dependencies
  FOR EACH ROW EXECUTE FUNCTION memory_vector_dependency_revision();

CREATE FUNCTION memory_vector_immutable_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
    RAISE EXCEPTION 'immutable_search_generation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_search_generation BEFORE UPDATE ON search_generations
  FOR EACH ROW EXECUTE FUNCTION memory_vector_immutable_generation();
