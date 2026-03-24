-- Persistent capture queue for reliable async processing
-- Ensures no data loss when Ollama/Twingate is unavailable

CREATE TABLE capture_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  source TEXT,
  metadata JSONB,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, complete, failed
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_capture_queue_status ON capture_queue (status, created_at);
