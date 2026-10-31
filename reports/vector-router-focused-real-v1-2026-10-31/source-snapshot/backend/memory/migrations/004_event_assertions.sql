-- Only the bounded asserted clause is retained, never the full utterance.
-- Legacy rows stay explicitly without source evidence; no backfilled provenance.
ALTER TABLE events ADD COLUMN source_evidence jsonb;
