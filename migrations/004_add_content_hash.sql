-- Add content hash for duplicate detection
-- SHA-256 hash of content, used to prevent duplicate ingestion

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE capture_queue ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Unique index on content_hash for transcript masters (the primary dedup target)
-- Partial index: only transcript_master rows need uniqueness enforcement
CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_content_hash_master
  ON thoughts (content_hash)
  WHERE content_hash IS NOT NULL AND thought_type = 'transcript_master';

-- Index on capture_queue for fast dedup lookups against pending/processing items
CREATE INDEX IF NOT EXISTS idx_capture_queue_content_hash
  ON capture_queue (content_hash)
  WHERE content_hash IS NOT NULL AND status IN ('pending', 'processing');
