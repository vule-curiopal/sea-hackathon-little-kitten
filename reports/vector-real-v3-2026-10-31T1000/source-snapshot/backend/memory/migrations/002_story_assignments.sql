-- Existing profiles keep their original adventure and any active checkpoint.
-- New profiles select a catalog story in the same transaction as creation.
ALTER TABLE miu_configs
  ADD COLUMN assigned_story_id text NOT NULL DEFAULT 'moon-boat-v1';
