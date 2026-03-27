-- Add cursor-based pagination to match_thoughts

DROP FUNCTION IF EXISTS match_thoughts(VECTOR, FLOAT, INT, JSONB, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  filter_type TEXT DEFAULT NULL,
  after_date TIMESTAMPTZ DEFAULT NULL,
  before_date TIMESTAMPTZ DEFAULT NULL,
  cursor_distance FLOAT DEFAULT NULL,
  cursor_id UUID DEFAULT NULL
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
    t.id, t.content, t.metadata,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at, t.group_id, t.thought_type,
    t.chunk_index, t.total_chunks, t.summary
  FROM thoughts t
  WHERE t.deleted_at IS NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
    AND (filter_type IS NULL OR t.thought_type = filter_type)
    AND (after_date IS NULL OR t.created_at >= after_date)
    AND (before_date IS NULL OR t.created_at <= before_date)
    AND (
      cursor_distance IS NULL
      OR (t.embedding <=> query_embedding) > cursor_distance
      OR (abs((t.embedding <=> query_embedding) - cursor_distance) < 1e-9 AND t.id > cursor_id)
    )
  ORDER BY t.embedding <=> query_embedding, t.id
  LIMIT match_count;
END;
$$;
