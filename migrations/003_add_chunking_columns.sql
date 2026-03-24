-- Add columns for hybrid chunk + summary pipeline
-- Supports long-form content (transcripts, articles) split into linked chunks

-- New columns on thoughts table (all nullable — existing rows unaffected)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS group_id UUID;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS thought_type TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS chunk_index INT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS total_chunks INT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS summary TEXT;

-- Index for fetching all chunks belonging to a transcript
CREATE INDEX idx_thoughts_group_id ON thoughts (group_id) WHERE group_id IS NOT NULL;

-- Index for filtering by thought type
CREATE INDEX idx_thoughts_type ON thoughts (thought_type) WHERE thought_type IS NOT NULL;

-- Update match_thoughts to also return new columns
-- Must drop first because return type changed (new OUT parameters)
DROP FUNCTION IF EXISTS match_thoughts(VECTOR, FLOAT, INT, JSONB);

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ,
  group_id UUID,
  thought_type TEXT,
  chunk_index INT,
  total_chunks INT,
  summary TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at,
    t.group_id,
    t.thought_type,
    t.chunk_index,
    t.total_chunks,
    t.summary
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
