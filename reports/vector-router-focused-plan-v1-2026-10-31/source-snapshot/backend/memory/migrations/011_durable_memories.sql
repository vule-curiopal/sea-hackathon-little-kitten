-- Canonical memories survive age. Permission validity and technical leases
-- have separate fields and must not be extended by this migration.
ALTER TABLE memory_records ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE memory_records ADD COLUMN learned_local_date date;
ALTER TABLE memory_records ADD COLUMN last_reconfirmed_local_date date;

UPDATE memory_records r SET
  learned_local_date=(r.created_at AT TIME ZONE p.timezone)::date,
  last_reconfirmed_local_date=(r.created_at AT TIME ZONE p.timezone)::date,
  expires_at=CASE WHEN r.kind IN ('diary','followup') THEN r.expires_at ELSE NULL END
FROM profiles p WHERE p.id=r.profile_id;

ALTER TABLE memory_records ALTER COLUMN learned_local_date SET NOT NULL;
ALTER TABLE memory_records ALTER COLUMN last_reconfirmed_local_date SET NOT NULL;
ALTER TABLE memory_records ADD CONSTRAINT memory_reconfirmation_monotonic
  CHECK(last_reconfirmed_local_date >= learned_local_date);

-- Existing row age is anchored to actual surviving provenance. There is no
-- reconstruction of content previously removed by the legacy expiry policy.
CREATE INDEX memory_learned_date ON memory_records(profile_id,learned_local_date);
