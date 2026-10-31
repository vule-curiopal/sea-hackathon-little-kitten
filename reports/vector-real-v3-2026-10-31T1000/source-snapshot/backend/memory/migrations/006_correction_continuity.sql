-- Existing operation receipts have no fabricated historical name evidence.
-- Entity/profile deletion already cascades through the receipt's composite FK.
ALTER TABLE memory_operation_receipts
  ADD COLUMN previous_name_hash text
  CHECK(previous_name_hash IS NULL OR previous_name_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX memory_operation_retired_names
  ON memory_operation_receipts(profile_id,target_record_id,created_at)
  WHERE previous_name_hash IS NOT NULL;
