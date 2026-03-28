import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import express from "express";
import pg from "pg";

const app = express();
app.use(express.json({ limit: "2mb" }));

// PostgreSQL connection
const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "engram",
  user: process.env.DB_USER || "engram",
  password: process.env.DB_PASSWORD,
  max: 10,
});

// Ollama config (needed for /search embedding generation on main thread)
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "bge-m3";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "qwen2.5:32b";
const OLLAMA_AUTH = process.env.OLLAMA_AUTH || "";

// Content hashing for dedup (needed by /capture on main thread)
function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// UUID validation
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ollamaHeaders() {
  const h = { "Content-Type": "application/json" };
  if (OLLAMA_AUTH) h.Authorization = `Basic ${OLLAMA_AUTH}`;
  return h;
}

// Generate embedding via Ollama (needed for /search on main thread)
async function generateEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Ollama embeddings API returned ${response.status}: ${body}`,
    );
  }

  const data = await response.json();
  return data.embedding;
}

// Test DB connection on startup
pool
  .connect()
  .then((client) => {
    client.release();
    console.log("PostgreSQL connected");
  })
  .catch((err) => console.error("PostgreSQL connection failed:", err.message));

// ============================================================
// Worker Thread Lifecycle
// ============================================================

let worker;

function spawnWorker() {
  worker = new Worker(new URL("./processor.worker.js", import.meta.url), {
    workerData: {
      dbHost: process.env.DB_HOST || "localhost",
      dbPort: parseInt(process.env.DB_PORT || "5432", 10),
      dbName: process.env.DB_NAME || "engram",
      dbUser: process.env.DB_USER || "engram",
      dbPassword: process.env.DB_PASSWORD,
      ollamaUrl: OLLAMA_URL,
      ollamaAuth: OLLAMA_AUTH,
      ollamaEmbedModel: EMBED_MODEL,
      ollamaChatModel: CHAT_MODEL,
      dudedashUrl: process.env.DUDEDASH_URL || "",
      dudedashApiKey: process.env.DUDEDASH_API_KEY || "",
      dispatchEnabled: process.env.DISPATCH_ENABLED !== "false",
    },
  });

  worker.on("message", (msg) => {
    switch (msg.type) {
      case "ready":
        console.log("[Main] Worker thread ready");
        break;
      case "complete":
        console.log(
          `[Main] Processed: ${msg.thoughtId} (${msg.chars} chars, ${msg.chunks ?? 0} chunks, ${msg.ms}ms)`,
        );
        // Future Phase 3.5: fire n8n webhook here (fire-and-forget)
        break;
      case "error":
        console.error(`[Main] Failed: ${msg.thoughtId} — ${msg.error}`);
        break;
      case "log":
        if (msg.level === "error") {
          console.error(`[Main<-Worker] ${msg.message}`);
        } else {
          console.log(`[Main<-Worker] ${msg.message}`);
        }
        break;
    }
  });

  worker.on("error", (err) => {
    console.error("[Main] Worker error:", err);
  });

  worker.on("exit", (code) => {
    if (code !== 0 && !shuttingDown) {
      console.error(
        `[Main] Worker exited (code ${code}), respawning in 5s...`,
      );
      setTimeout(spawnWorker, 5000);
    }
  });

  console.log("[Main] Worker thread spawned");
}

let shuttingDown = false;

spawnWorker();

// ============================================================
// Express Routes
// ============================================================

// POST /capture - Queue a thought for async processing
app.post("/capture", async (req, res) => {
  try {
    const { content, metadata: extraMetadata, source } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Content required" });
    }

    const hash = contentHash(content);

    // Dedup check: look for matching hash in processed thoughts or pending queue
    const [existingThought, existingQueue] = await Promise.all([
      pool.query(
        `SELECT id, group_id, created_at FROM thoughts
         WHERE content_hash = $1 AND thought_type = 'transcript_master'
         LIMIT 1`,
        [hash],
      ),
      pool.query(
        `SELECT id, created_at, status FROM capture_queue
         WHERE content_hash = $1 AND status IN ('pending', 'processing')
         LIMIT 1`,
        [hash],
      ),
    ]);

    if (existingThought.rows.length > 0) {
      const existing = existingThought.rows[0];
      console.log(
        `[Dedup] Duplicate detected (thought ${existing.id}), hash ${hash.substring(0, 12)}`,
      );
      return res.status(409).json({
        status: "duplicate",
        message: "Content already exists",
        existing_id: existing.id,
        group_id: existing.group_id,
        created_at: existing.created_at,
      });
    }

    if (existingQueue.rows.length > 0) {
      const existing = existingQueue.rows[0];
      console.log(
        `[Dedup] Duplicate detected (queued ${existing.id}), hash ${hash.substring(0, 12)}`,
      );
      return res.status(409).json({
        status: "duplicate",
        message: "Content already queued for processing",
        queued_id: existing.id,
        queue_status: existing.status,
        created_at: existing.created_at,
      });
    }

    const result = await pool.query(
      `INSERT INTO capture_queue (content, source, metadata, content_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [content, source || null, extraMetadata || null, hash],
    );

    console.log(
      `[Queue] Enqueued: ${result.rows[0].id} (${content.length} chars)`,
    );

    res.json({
      status: "queued",
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      message: "Capture queued for processing",
    });

    // Wake up worker to process immediately instead of waiting for poll interval
    if (worker) worker.postMessage({ type: "wake" });
  } catch (error) {
    console.error("Capture error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /capture/batch - Batch capture (for imports)
app.post("/capture/batch", async (req, res) => {
  try {
    const { thoughts } = req.body;

    if (!Array.isArray(thoughts) || thoughts.length === 0) {
      return res.status(400).json({ error: "Array of thoughts required" });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const thought of thoughts) {
      try {
        const embedding = await generateEmbedding(thought.content);
        const metadata = thought.metadata || {
          type: "imported",
          topics: [],
          people: [],
          action_items: [],
        };

        const result = await pool.query(
          `INSERT INTO thoughts (content, embedding, metadata)
           VALUES ($1, $2::vector, $3)
           RETURNING id, created_at`,
          [thought.content, `[${embedding.join(",")}]`, metadata],
        );

        results.push({ id: result.rows[0].id, status: "ok" });
        succeeded++;
      } catch (err) {
        results.push({
          content: thought.content.substring(0, 50),
          status: "error",
          error: err.message,
        });
        failed++;
      }
    }

    res.json({ total: thoughts.length, succeeded, failed, results });
  } catch (error) {
    console.error("Batch capture error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /queue - Queue monitoring
app.get("/queue", async (_req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        status,
        COUNT(*)::int AS count,
        MAX(created_at) AS latest
      FROM capture_queue
      GROUP BY status
      ORDER BY status
    `);
    res.json({ queue_stats: stats.rows });
  } catch (error) {
    console.error("Queue stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /search - Semantic search with parent transcript surfacing
app.get("/search", async (req, res) => {
  try {
    const {
      q,
      limit = 10,
      threshold = 0.7,
      filter,
      type,
      after,
      before,
      cursor,
    } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" required' });
    }

    let parsedFilter = {};
    if (filter) {
      try {
        parsedFilter = JSON.parse(filter);
        if (
          typeof parsedFilter !== "object" ||
          parsedFilter === null ||
          Array.isArray(parsedFilter)
        ) {
          return res
            .status(400)
            .json({ error: "filter must be a JSON object" });
        }
      } catch {
        return res.status(400).json({ error: "Invalid JSON in filter" });
      }
    }

    // thought_type filter: equality via SQL, negation (! prefix) via post-filter
    let filterType = type || null;
    let excludeType = null;
    if (filterType?.startsWith("!")) {
      excludeType = filterType.slice(1);
      filterType = null;
    }

    // Date range validation
    const afterDate = after ? new Date(after) : null;
    const beforeDate = before ? new Date(before) : null;
    if (after && Number.isNaN(afterDate.getTime())) {
      return res.status(400).json({ error: "Invalid date in after" });
    }
    if (before && Number.isNaN(beforeDate.getTime())) {
      return res.status(400).json({ error: "Invalid date in before" });
    }

    // Cursor parsing
    let cursorDistance = null;
    let cursorId = null;
    if (cursor) {
      const colonIdx = cursor.indexOf(":");
      if (colonIdx === -1) {
        return res
          .status(400)
          .json({ error: "Invalid cursor format (expected distance:uuid)" });
      }
      cursorDistance = parseFloat(cursor.slice(0, colonIdx));
      cursorId = cursor.slice(colonIdx + 1);
      if (Number.isNaN(cursorDistance) || !UUID_RE.test(cursorId)) {
        return res
          .status(400)
          .json({ error: "Invalid cursor format (expected distance:uuid)" });
      }
    }

    const fetchLimit = excludeType
      ? parseInt(limit, 10) * 3
      : parseInt(limit, 10);

    const embedding = await generateEmbedding(q);

    const result = await pool.query(
      `SELECT * FROM match_thoughts($1::vector, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz, $8, $9)`,
      [
        `[${embedding.join(",")}]`,
        parseFloat(threshold),
        fetchLimit,
        JSON.stringify(parsedFilter),
        filterType,
        afterDate ? afterDate.toISOString() : null,
        beforeDate ? beforeDate.toISOString() : null,
        cursorDistance,
        cursorId,
      ],
    );

    let rows = result.rows;
    if (excludeType) {
      rows = rows
        .filter((r) => r.thought_type !== excludeType)
        .slice(0, parseInt(limit, 10));
    }

    // Collect group_ids from chunk results to fetch parent transcripts
    const groupIds = [
      ...new Set(
        rows
          .filter((r) => r.thought_type === "transcript_chunk" && r.group_id)
          .map((r) => r.group_id),
      ),
    ];

    const parentTranscripts = {};
    if (groupIds.length > 0) {
      const parents = await pool.query(
        `SELECT group_id, summary, total_chunks
         FROM thoughts
         WHERE group_id = ANY($1) AND thought_type = 'transcript_master'`,
        [groupIds],
      );
      for (const p of parents.rows) {
        parentTranscripts[p.group_id] = {
          group_id: p.group_id,
          summary: p.summary,
          total_chunks: p.total_chunks,
          full_content_available: true,
        };
      }
    }

    // Enrich results with parent info
    const enrichedResults = rows.map((r) => {
      if (
        r.thought_type === "transcript_chunk" &&
        r.group_id &&
        parentTranscripts[r.group_id]
      ) {
        return {
          ...r,
          parent_transcript: parentTranscripts[r.group_id],
        };
      }
      return r;
    });

    // Build next_cursor from last result when page is full
    const requestedLimit = parseInt(limit, 10);
    let nextCursor = null;
    if (enrichedResults.length === requestedLimit) {
      const lastRow = enrichedResults[enrichedResults.length - 1];
      const distance = parseFloat((1 - lastRow.similarity).toFixed(10));
      nextCursor = `${distance}:${lastRow.id}`;
    }

    res.json({
      query: q,
      count: enrichedResults.length,
      results: enrichedResults,
      next_cursor: nextCursor,
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /transcript/:groupId - Fetch full transcript by group
app.get("/transcript/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params;

    const master = await pool.query(
      `SELECT id, content, summary, metadata, total_chunks, created_at
       FROM thoughts
       WHERE group_id = $1 AND thought_type = 'transcript_master'
         AND deleted_at IS NULL`,
      [groupId],
    );

    if (master.rows.length === 0) {
      return res.status(404).json({ error: "Transcript not found" });
    }

    const chunks = await pool.query(
      `SELECT id, content, chunk_index, metadata, created_at
       FROM thoughts
       WHERE group_id = $1 AND thought_type = 'transcript_chunk'
         AND deleted_at IS NULL
       ORDER BY chunk_index`,
      [groupId],
    );

    res.json({
      group_id: groupId,
      master: master.rows[0],
      chunks: chunks.rows,
    });
  } catch (error) {
    console.error("Transcript fetch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /thoughts/:id - Soft delete a thought (cascades to chunks for masters)
app.delete("/thoughts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id))
      return res.status(400).json({ error: "Invalid thought ID" });

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
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH /thoughts/:id - Update metadata (merge with existing)
app.patch("/thoughts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id))
      return res.status(400).json({ error: "Invalid thought ID" });

    const { metadata } = req.body;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return res.status(400).json({ error: "metadata object required" });
    }

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
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /thoughts/:id/restore - Undo a soft delete (cascades to chunks for masters)
app.post("/thoughts/:id/restore", async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id))
      return res.status(400).json({ error: "Invalid thought ID" });

    const thought = await pool.query(
      `UPDATE thoughts SET deleted_at = NULL
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING id, group_id, thought_type`,
      [id],
    );

    if (thought.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Thought not found or not deleted" });
    }

    let chunksRestored = 0;
    const row = thought.rows[0];

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
  } catch (error) {
    console.error("Restore error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /dispatch-log - Recent task dispatch activity
app.get("/dispatch-log", async (req, res) => {
  try {
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const result = await pool.query(
      `SELECT id, thought_id, action_item_text, dudedash_task_id,
              status, retry_count, last_error, created_at, dispatched_at
       FROM task_dispatch_log
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [status, limit],
    );

    res.json({
      count: result.rows.length,
      entries: result.rows,
    });
  } catch (error) {
    console.error("Dispatch log error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /stats
app.get("/stats", async (_req, res) => {
  try {
    const [result, typeBreakdown] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_thoughts,
          COUNT(DISTINCT metadata->>'type') as unique_types,
          COUNT(DISTINCT metadata->>'source') as unique_sources,
          MIN(created_at) as oldest,
          MAX(created_at) as newest
        FROM thoughts
        WHERE deleted_at IS NULL
      `),
      pool.query(`
        SELECT thought_type, COUNT(*)::int as count
        FROM thoughts
        WHERE deleted_at IS NULL
        GROUP BY thought_type
        ORDER BY count DESC
      `),
    ]);

    const typeCounts = {};
    for (const row of typeBreakdown.rows) {
      typeCounts[row.thought_type] = row.count;
    }

    res.json({ ...result.rows[0], type_counts: typeCounts });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /health
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS count FROM capture_queue WHERE status = 'pending'`,
    );
    res.json({
      status: "ok",
      service: "engram",
      version: "2.1.0",
      database: "connected",
      queue_pending: pending.rows[0].count,
      embed_model: EMBED_MODEL,
      worker: worker && !worker.threadId ? "stopped" : "running",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      service: "engram",
      version: "2.1.0",
      database: "disconnected",
      error: error.message,
    });
  }
});

// ============================================================
// Server Start + Graceful Shutdown
// ============================================================

const PORT = parseInt(process.env.PORT || "3700", 10);
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Engram API listening on port ${PORT}`);
  console.log(
    `Database: ${process.env.DB_HOST || "localhost"}/${process.env.DB_NAME || "engram"}`,
  );
  console.log(
    `Ollama: ${OLLAMA_URL} (embed: ${EMBED_MODEL}, chat: ${CHAT_MODEL})`,
  );
  console.log("[Main] Processing offloaded to worker thread");
});

process.on("SIGTERM", async () => {
  console.log("[Main] SIGTERM received, shutting down...");
  shuttingDown = true;
  server.close();

  if (worker) {
    worker.postMessage({ type: "shutdown" });
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[Main] Worker shutdown timeout, terminating");
        worker.terminate();
        resolve();
      }, 30_000);
      worker.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  await pool.end();
  console.log("[Main] Shutdown complete");
  process.exit(0);
});
