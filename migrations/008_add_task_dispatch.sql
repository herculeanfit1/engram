-- Task dispatch log: tracks action_items sent to DudeDash
-- Dedup via unique index on action_item_hash

CREATE TABLE task_dispatch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id UUID NOT NULL REFERENCES thoughts(id),
  action_item_hash TEXT NOT NULL,
  action_item_text TEXT NOT NULL,
  dudedash_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_dispatch_dedup ON task_dispatch_log (action_item_hash);
CREATE INDEX idx_dispatch_status ON task_dispatch_log (status) WHERE status != 'dispatched';
CREATE INDEX idx_dispatch_thought ON task_dispatch_log (thought_id);
