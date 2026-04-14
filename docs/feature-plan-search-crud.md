# Feature Plan: Search Filtering, CRUD, Date Ranges, Pagination, and MCP Parity

This document details the implementation plan for five enhancements to Engram, ordered by dependency so earlier features unblock later ones.

> **Validated 2026-03-27 by HerculeanInfra** against the actual Engram codebase at `~/dev/engram`.
> Current schema: migrations 001–004, `match_thoughts` has `filter JSONB` param (unused by HTTP layer),
> `updated_at` column + trigger exist from 001, `content_hash` from 004. No `deleted_at`, no PATCH/DELETE routes,
> MCP exposes 4 tools (search, capture, stats, health). All assumptions in this plan confirmed accurate.

---

## 1. Expose JSONB Metadata Filter on `/search`

### Motivation

The `match_thoughts` SQL function already accepts a `filter JSONB` parameter that supports containment queries (`@>` operator), but the `/search` HTTP endpoint never passes it through. This is zero-migration, zero-schema-change work — the database already supports it.

### Changes

**`index.js` — `/search` route (~5 lines changed)**

Accept a `filter` query parameter as a JSON string, parse it, and forward it to `match_thoughts`:

```
GET /search?q=project+planning&filter={"type":"decision"}
GET /search?q=alice&filter={"people":["Alice"]}
```

- Parse `filter` from query string via `JSON.parse`, default to `{}`.
- Validate that the parsed value is a plain object (not an array, not null). Return 400 on malformed JSON.
- Pass it as the 4th argument to `match_thoughts`:
  ```js
  const result = await pool.query(
    `SELECT * FROM match_thoughts($1::vector, $2, $3, $4::jsonb)`,
    [`[${embedding.join(",")}]`, parseFloat(threshold), parseInt(limit, 10), JSON.stringify(parsedFilter)],
  );
  ```

**`mcp-server/src/engram-client.ts`**

- Add optional `filter` parameter to the `search` function.
- Append `filter` to the `URLSearchParams` when provided.

**`mcp-server/src/tools/memory.ts` — `engram_search` tool**

- Add an optional `filter` Zod schema:
  ```ts
  filter: z.record(z.unknown()).optional()
    .describe("JSONB metadata filter (e.g. {\"type\": \"decision\"})"),
  ```
- Pass through to client.

### Migration

None. `match_thoughts` already handles the `filter` parameter. The JSONB filter passthrough is truly standalone.

> **Note:** The `thought_type` filter shorthand (below) requires `filter_type TEXT` in `match_thoughts`, which is added in migration 005 (Feature 2). Ship the JSONB filter passthrough in PR 1; the type shorthand ships with PR 2.

### Testing

```bash
# All decisions (metadata filter)
curl "localhost:3700/search?q=test&filter=%7B%22type%22%3A%22decision%22%7D"

# Invalid JSON returns 400
curl "localhost:3700/search?q=test&filter=notjson"
```

### `thought_type` filter shorthand (ships with PR 2, requires migration 005)

The JSONB `filter` works for metadata fields, but `thought_type` is a top-level column, not inside `metadata`. Agents commonly want to exclude chunks from search results. Add a `type` query param as an ergonomic shorthand:

```
GET /search?q=budgets&type=thought              # regular thoughts (not transcripts)
GET /search?q=budgets&type=transcript_master    # only masters
GET /search?q=budgets&type=!transcript_chunk    # exclude chunks (prefix ! = NOT)
```

> **Important: NULL backfill.** Currently, regular (non-transcript) thoughts have `thought_type = NULL`, not `'thought'`. The filter `AND t.thought_type = 'thought'` would match zero rows. Migration 005 must backfill NULLs:
> ```sql
> UPDATE thoughts SET thought_type = 'thought' WHERE thought_type IS NULL;
> ALTER TABLE thoughts ALTER COLUMN thought_type SET DEFAULT 'thought';
> ```
> After this, all rows have an explicit type and the equality filter works uniformly.

**`index.js` — `/search` route:**

- Read `type` from `req.query`. If present, pass to `match_thoughts` via the `filter_type` parameter (added in migration 005):
  ```sql
  AND (filter_type IS NULL OR t.thought_type = filter_type)
  ```
- The `!` prefix (negation) is handled in the route layer before calling `match_thoughts`. Since `match_thoughts` only supports equality, negation uses over-fetch + post-filter:
  ```js
  let filterType = req.query.type || null;
  let excludeType = null;
  if (filterType && filterType.startsWith("!")) {
    excludeType = filterType.slice(1);
    filterType = null; // don't pass to SQL
  }

  // Over-fetch 3x when negating, then trim to requested limit
  const fetchLimit = excludeType ? parseInt(limit, 10) * 3 : parseInt(limit, 10);

  const result = await pool.query(
    `SELECT * FROM match_thoughts($1::vector, $2, $3, $4::jsonb, $5)`,
    [embedding, threshold, fetchLimit, filter, filterType],
  );

  let rows = result.rows;
  if (excludeType) {
    rows = rows.filter(r => r.thought_type !== excludeType).slice(0, parseInt(limit, 10));
  }
  ```
  Note: Over-fetching 3x is sufficient at current scale (280 thoughts, ~65% chunks). If the ratio of excluded rows grows significantly, increase the multiplier or push negation into SQL via an `exclude_type TEXT` parameter.

**MCP server — `engram_search` tool:**

```ts
type: z.string().optional()
  .describe("Filter by thought_type (e.g. 'thought', 'transcript_master'). Prefix with ! to exclude (e.g. '!transcript_chunk')"),
```

**Testing (after migration 005):**
```bash
# Only regular thoughts (non-transcript)
curl "localhost:3700/search?q=test&type=thought"

# Exclude chunks but include masters and regular thoughts
curl "localhost:3700/search?q=test&type=!transcript_chunk"
```

---

## 2. DELETE and UPDATE Endpoints

### Motivation

There is currently no way to remove or correct a thought after capture. This blocks privacy/GDPR compliance, prevents fixing misclassified metadata, and leaves no mechanism for agents to self-correct stored memories.

### Changes

**Migration: `migrations/005_add_soft_delete.sql`**

> **Note:** Engram migrations are 001–004. This is Engram's 005, distinct from HerculeanInfra/Olympus `migrations/005_seed_agents_from_registry.sql` (different repo, different database).

```sql
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Backfill NULL thought_type → 'thought' so type filtering works uniformly
UPDATE thoughts SET thought_type = 'thought' WHERE thought_type IS NULL;
ALTER TABLE thoughts ALTER COLUMN thought_type SET DEFAULT 'thought';

-- Partial index: speed up queries that filter out deleted rows
CREATE INDEX IF NOT EXISTS idx_thoughts_not_deleted
  ON thoughts (created_at) WHERE deleted_at IS NULL;

-- Drop and recreate match_thoughts to filter out deleted rows + add filter_type
DROP FUNCTION IF EXISTS match_thoughts(VECTOR, FLOAT, INT, JSONB);

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  filter_type TEXT DEFAULT NULL
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
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

This is a soft delete. The row stays in the database but is excluded from all search results. A future hard-delete or retention policy can be layered on later.

**`index.js` — UUID validation helper**

All `:id` routes (DELETE, PATCH, POST restore) must validate the UUID before querying PostgreSQL. An invalid UUID causes a PG error (`invalid input syntax for type uuid`) that leaks as a 500. Add a shared guard at the top of each route:

```js
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid thought ID" });
```

**`index.js` — New routes**

`DELETE /thoughts/:id` — Soft delete a thought. If the thought is a `transcript_master`, also soft-delete all its chunks (same `group_id`).

```
DELETE /thoughts/:id
→ 200 { status: "deleted", id, deleted_at, chunks_deleted: N }
→ 404 { error: "Thought not found" }
```

Implementation:
```js
app.delete("/thoughts/:id", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid thought ID" });

  const thought = await pool.query(
    `UPDATE thoughts SET deleted_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, group_id, thought_type, deleted_at`,
    [id],
  );

  if (thought.rows.length === 0) {
    return res.status(404).json({ error: "Thought not found" });
  }

  let chunksDeleted = 0;
  const row = thought.rows[0];

  // Cascade to chunks if deleting a master
  if (row.thought_type === "transcript_master" && row.group_id) {
    const cascade = await pool.query(
      `UPDATE thoughts SET deleted_at = NOW()
       WHERE group_id = $1 AND thought_type = 'transcript_chunk' AND deleted_at IS NULL`,
      [row.group_id],
    );
    chunksDeleted = cascade.rowCount;
  }

  res.json({
    status: "deleted",
    id: row.id,
    deleted_at: row.deleted_at,
    chunks_deleted: chunksDeleted,
  });
});
```

`PATCH /thoughts/:id` — Update metadata on an existing thought. Does not re-embed (content is immutable after capture).

```
PATCH /thoughts/:id
Body: { "metadata": { "type": "decision", "topics": ["budgets"] } }
→ 200 { id, metadata, updated_at }
→ 404 { error: "Thought not found" }
```

Implementation:
```js
app.patch("/thoughts/:id", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid thought ID" });
  const { metadata } = req.body;

  if (!metadata || typeof metadata !== "object") {
    return res.status(400).json({ error: "metadata object required" });
  }

  // Merge: spread existing metadata with new values
  const result = await pool.query(
    `UPDATE thoughts
     SET metadata = metadata || $1::jsonb
     WHERE id = $2 AND deleted_at IS NULL
     RETURNING id, metadata, updated_at`,
    [JSON.stringify(metadata), id],
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Thought not found" });
  }

  res.json(result.rows[0]);
});
```

Key design decisions:
- Metadata merge uses PostgreSQL `||` (concat) operator — new keys are added, existing keys are overwritten, unmentioned keys are preserved.
- Content is immutable. Changing content would require re-embedding, which is a different (more expensive) operation. If the user needs different content, they should capture a new thought and delete the old one.
- The `updated_at` trigger already exists from migration 001.

`POST /thoughts/:id/restore` — Undo a soft delete. If the thought is a `transcript_master`, also restore all its chunks.

```
POST /thoughts/:id/restore
→ 200 { status: "restored", id, chunks_restored: N }
→ 404 { error: "Thought not found or not deleted" }
```

Implementation:
```js
app.post("/thoughts/:id/restore", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid thought ID" });

  const thought = await pool.query(
    `UPDATE thoughts SET deleted_at = NULL
     WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING id, group_id, thought_type`,
    [id],
  );

  if (thought.rows.length === 0) {
    return res.status(404).json({ error: "Thought not found or not deleted" });
  }

  let chunksRestored = 0;
  const row = thought.rows[0];

  // Cascade restore to chunks if restoring a master
  if (row.thought_type === "transcript_master" && row.group_id) {
    const cascade = await pool.query(
      `UPDATE thoughts SET deleted_at = NULL
       WHERE group_id = $1 AND thought_type = 'transcript_chunk' AND deleted_at IS NOT NULL`,
      [row.group_id],
    );
    chunksRestored = cascade.rowCount;
  }

  res.json({
    status: "restored",
    id: row.id,
    chunks_restored: chunksRestored,
  });
});
```

This completes the soft-delete lifecycle — delete and restore are symmetric operations.

**`/stats`, `/transcript/:groupId`, and other read endpoints** should also add `WHERE deleted_at IS NULL` to their queries to hide soft-deleted rows.

### Affected queries in `index.js`

These existing queries need a `AND deleted_at IS NULL` clause added:
- `/stats` — the `SELECT COUNT(*)` query (see enhanced version below)
- `/transcript/:groupId` — both the master and chunks queries
- `/health` — not affected (only queries `capture_queue`)

### Enhanced `/stats` with `thought_type` breakdown

The current `/stats` query counts all rows in a single aggregate. With soft delete landing, enhance it to also break down by `thought_type`. This gives agents visibility into how many masters vs chunks vs regular thoughts exist — directly useful for the task extraction pipeline (knowing how many non-chunk thoughts to process).

```sql
-- Main stats (existing, add deleted_at filter)
SELECT
  COUNT(*) as total_thoughts,
  COUNT(DISTINCT metadata->>'type') as unique_types,
  COUNT(DISTINCT metadata->>'source') as unique_sources,
  MIN(created_at) as oldest,
  MAX(created_at) as newest
FROM thoughts
WHERE deleted_at IS NULL;

-- Type breakdown (new)
SELECT thought_type, COUNT(*) as count
FROM thoughts
WHERE deleted_at IS NULL
GROUP BY thought_type
ORDER BY count DESC;
```

Add the breakdown to the stats response as `type_counts`:
```json
{
  "total_thoughts": 280,
  "unique_types": 7,
  "type_counts": {
    "transcript_chunk": 184,
    "transcript_master": 12,
    "thought": 84
  },
  ...
}
```

### Known gap: `content_hash` on batch imports

`POST /capture/batch` (used for migration scripts) does not set `content_hash` (added in migration 004). Only the queue worker populates it during normal capture flow. This means batch-imported thoughts lack dedup protection. Not a blocker for this feature, but worth a follow-up to add `content_hash = sha256(content)` in the batch insert path.

---

## 3. Date-Range Filtering on Search

### Motivation

The `idx_thoughts_created_at` index (from migration 001) exists but no query path uses it. Agents frequently need temporal scoping: "what happened last week", "decisions before the deadline", etc.

### Changes

**Migration: update `match_thoughts` — `migrations/006_add_date_filter.sql`**

Add `after_date` and `before_date` parameters to the function:

```sql
DROP FUNCTION IF EXISTS match_thoughts(VECTOR, FLOAT, INT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(1024),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  filter_type TEXT DEFAULT NULL,
  after_date TIMESTAMPTZ DEFAULT NULL,
  before_date TIMESTAMPTZ DEFAULT NULL
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
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

Note: This migration incorporates the `deleted_at IS NULL` clause from feature #2. Migrations 005 and 006 must be applied in order.

**`index.js` — `/search` route**

Accept `after` and `before` query params as ISO 8601 strings:

```
GET /search?q=budgets&after=2025-01-01&before=2025-06-30
```

- Parse with `new Date()`, validate that the result is not `NaN`. Return 400 on invalid dates.
- Pass as positional arguments to `match_thoughts` (note `filter_type` from Feature 1 is now the 5th param):
  ```js
  const result = await pool.query(
    `SELECT * FROM match_thoughts($1::vector, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)`,
    [
      `[${embedding.join(",")}]`,
      parseFloat(threshold),
      parseInt(limit, 10),
      JSON.stringify(parsedFilter),
      filterType,    // from Feature 1 type shorthand
      after || null,
      before || null,
    ],
  );
  ```

**`mcp-server/src/engram-client.ts`**

- Add optional `after` and `before` string parameters to `search()`.

**`mcp-server/src/tools/memory.ts`**

- Add Zod fields:
  ```ts
  after: z.string().optional().describe("ISO 8601 date — only return thoughts after this date"),
  before: z.string().optional().describe("ISO 8601 date — only return thoughts before this date"),
  ```

---

## 4. Pagination

### Motivation

Search results are capped at `limit` with no way to access further results. Agents scanning through memories hit a wall. Cursor-based pagination (using similarity score + ID as cursor) avoids the offset-performance trap and works naturally with vector search.

### Approach: Keyset Pagination via Similarity Cursor

The `match_thoughts` function already orders by `embedding <=> query_embedding` (cosine distance). We paginate by adding a "seen" boundary: "give me results worse than similarity X, excluding ID Y."

This is preferred over OFFSET-based pagination because:
- OFFSET rescans rows on every page (O(n) per page).
- Keyset is stable even if new thoughts are inserted between pages.

### Changes

**Migration: `migrations/007_add_pagination.sql`**

```sql
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
      OR ((t.embedding <=> query_embedding) = cursor_distance AND t.id > cursor_id)
    )
  ORDER BY t.embedding <=> query_embedding, t.id
  LIMIT match_count;
END;
$$;
```

The cursor logic: "skip all rows with distance < cursor_distance, and for ties at the same distance, skip IDs already seen." Adding `t.id` as a tiebreaker to ORDER BY guarantees deterministic ordering.

> **Float precision caveat:** The `= cursor_distance` equality check on cosine distances is fragile — rounding differences between JavaScript's `Number` (IEEE 754 double) and PostgreSQL's `FLOAT4`/`FLOAT8` can cause rows to be skipped or duplicated. At 280 thoughts this is unlikely to bite, but for correctness:
> - Round `cursor_distance` to 10 decimal places in the cursor string: `parseFloat((1 - lastRow.similarity).toFixed(10))`
> - In SQL, use a small epsilon for the tie-break: `abs((t.embedding <=> query_embedding) - cursor_distance) < 1e-9` instead of exact equality
> - Alternatively, cast both sides to `FLOAT8` explicitly to ensure consistent precision

**`index.js` — `/search` route**

- Accept optional `cursor` query param, formatted as `<distance>:<uuid>` (e.g., `0.35:abc123-...`).
- Parse into `cursor_distance` (float) and `cursor_id` (UUID).
- Include a `next_cursor` in the response when results equal the limit:
  ```json
  {
    "query": "budgets",
    "count": 10,
    "results": [...],
    "next_cursor": "0.412:9f3a1b2c-..."
  }
  ```
- `next_cursor` is built from the last result's cosine distance and ID:
  ```js
  const lastRow = enrichedResults[enrichedResults.length - 1];
  const nextCursor = enrichedResults.length === parseInt(limit, 10)
    ? `${1 - lastRow.similarity}:${lastRow.id}`
    : null;
  ```

**Client usage pattern:**

```bash
# Page 1
curl "localhost:3700/search?q=budgets&limit=5"
# → { next_cursor: "0.35:abc-123" }

# Page 2
curl "localhost:3700/search?q=budgets&limit=5&cursor=0.35:abc-123"
# → { next_cursor: "0.52:def-456" }

# Page 3 (last page, fewer than limit results)
curl "localhost:3700/search?q=budgets&limit=5&cursor=0.52:def-456"
# → { next_cursor: null }
```

**MCP server**: Add optional `cursor` string param to `engram_search`. Include `next_cursor` in the formatted response text so agents can paginate.

---

## 5. MCP Server Tool Parity

### Motivation

The MCP server currently exposes 4 tools but the main API has 7 endpoints. Agents interacting exclusively through MCP cannot retrieve full transcripts, monitor the queue, or perform batch imports. With features #2-4 adding delete, update, and richer search, the gap widens further.

### New MCP Tools

**`engram_transcript`** — Retrieve a full transcript by group ID.

```ts
server.tool(
  "engram_transcript",
  "Retrieve a full transcript and all its chunks by group ID. Use this after search returns a transcript_chunk to get the complete context.",
  {
    group_id: z.string().uuid().describe("The group_id from a search result"),
  },
  async ({ group_id }) => { ... },
);
```

Client addition in `engram-client.ts`:
```ts
export async function transcript(groupId: string): Promise<TranscriptResult> {
  const res = await engramFetch(`/transcript/${groupId}`);
  return res.json() as Promise<TranscriptResult>;
}
```

Format the response as markdown: summary at top, then numbered chunks.

**`engram_queue`** — Check queue processing status.

```ts
server.tool(
  "engram_queue",
  "Check the status of the capture processing queue — how many items are pending, processing, complete, or failed.",
  {},
  async () => { ... },
);
```

Client addition:
```ts
export async function queue(): Promise<QueueResult> {
  const res = await engramFetch("/queue");
  return res.json() as Promise<QueueResult>;
}
```

**`engram_delete`** — Soft-delete a thought (depends on feature #2).

```ts
server.tool(
  "engram_delete",
  "Delete a thought from semantic memory. If the thought is a transcript master, all its chunks are also deleted. This is a soft delete — the data can be recovered.",
  {
    id: z.string().uuid().describe("The thought ID to delete"),
  },
  async ({ id }) => { ... },
);
```

Client addition:
```ts
export async function deleteThought(id: string): Promise<DeleteResult> {
  const res = await engramFetch(`/thoughts/${id}`, { method: "DELETE" });
  return res.json() as Promise<DeleteResult>;
}
```

**`engram_restore`** — Undo a soft delete (depends on feature #2).

```ts
server.tool(
  "engram_restore",
  "Restore a previously deleted thought. If the thought is a transcript master, all its chunks are also restored.",
  {
    id: z.string().uuid().describe("The thought ID to restore"),
  },
  async ({ id }) => { ... },
);
```

Client addition:
```ts
export async function restoreThought(id: string): Promise<RestoreResult> {
  const res = await engramFetch(`/thoughts/${id}/restore`, { method: "POST" });
  return res.json() as Promise<RestoreResult>;
}
```

**`engram_update`** — Update thought metadata (depends on feature #2).

```ts
server.tool(
  "engram_update",
  "Update metadata on an existing thought. Merges with existing metadata — unmentioned keys are preserved. Content cannot be changed (capture a new thought instead).",
  {
    id: z.string().uuid().describe("The thought ID to update"),
    metadata: z.record(z.unknown()).describe("Metadata fields to add or overwrite"),
  },
  async ({ id, metadata }) => { ... },
);
```

Client addition:
```ts
export async function updateThought(
  id: string,
  metadata: Record<string, unknown>,
): Promise<UpdateResult> {
  const res = await engramFetch(`/thoughts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata }),
  });
  return res.json() as Promise<UpdateResult>;
}
```

### Interface additions in `engram-client.ts`

```ts
export interface TranscriptResult {
  group_id: string;
  master: ThoughtResult;
  chunks: ThoughtResult[];
}

export interface QueueResult {
  queue_stats: Array<{ status: string; count: number; latest: string }>;
}

export interface DeleteResult {
  status: string;
  id: string;
  deleted_at: string;
  chunks_deleted: number;
}

export interface RestoreResult {
  status: string;
  id: string;
  chunks_restored: number;
}

export interface UpdateResult {
  id: string;
  metadata: Record<string, unknown>;
  updated_at: string;
}
```

### Batch import intentionally excluded

`/capture/batch` is not exposed as an MCP tool. It bypasses LLM extraction and is designed for bulk migration scripts, not agent use. Agents should use `engram_capture` which routes through the full pipeline.

---

## Implementation Order

These features have a dependency chain:

```
1. JSONB metadata filter  (standalone — no migration, ships alone)
   ↓
2. Soft delete + update + restore + stats breakdown + type shorthand  (migration 005)
   ↓
3. Date-range filtering  (migration 006 — builds on 005's function signature)
   ↓
4. Pagination  (migration 007 — builds on 006's full function signature)
   ↓
5. MCP parity  (no migration — depends on 2 for delete/update/restore tools)
```

Feature 1 ships the JSONB filter passthrough alone (truly no migration). The `thought_type` shorthand requires `filter_type TEXT` in `match_thoughts`, so it moves to PR 2 where migration 005 adds that parameter along with `deleted_at`, the NULL backfill, and the partial index. Features 2-4 chain through migrations that each rebuild `match_thoughts`. Feature 5 can be developed in parallel but should ship after 2 lands (since it exposes delete/update/restore).

Each feature is a single PR. The migrations are incremental (each `DROP FUNCTION` + `CREATE OR REPLACE` replaces the prior version cleanly).

### Combined migration option

Each migration drops and recreates `match_thoughts` with one more parameter. If features 2–4 ship in a tight sequence (same day/week), consider combining 005–007 into a single `005_search_enhancements.sql` that adds `deleted_at`, the partial index, `filter_type`, and the final `match_thoughts` with all parameters (filter, type, date range, cursor). This avoids three consecutive `DROP FUNCTION` + `CREATE` cycles on production. The trade-off is a larger single PR vs cleaner atomic PRs — use judgment based on velocity.

If combining, the `match_thoughts` signature goes straight to the final form:
```sql
match_thoughts(
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
```

### Suggested PR sequence

| PR | Feature | Files touched |
|----|---------|---------------|
| 1 | JSONB metadata filter only | `index.js`, `engram-client.ts`, `tools/memory.ts` |
| 2 | Soft delete + update + restore + stats breakdown + type shorthand | `migrations/005_*.sql`, `index.js`, `engram-client.ts`, `tools/memory.ts` |
| 3 | Date-range filtering | `migrations/006_*.sql`, `index.js`, `engram-client.ts`, `tools/memory.ts` |
| 4 | Pagination | `migrations/007_*.sql`, `index.js`, `engram-client.ts`, `tools/memory.ts` |
| 5 | MCP parity (transcript, queue, delete, restore, update) | `engram-client.ts`, `tools/memory.ts` |

> **Reviewed 2026-03-27** — Engram agent identified 5 issues (PR sequencing, UUID guard omission, DROP signature, negation post-filter, NULL thought_type). All addressed in this revision.
