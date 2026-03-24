import crypto from "node:crypto";
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

// Ollama config
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "bge-m3";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "qwen2.5:32b";
const OLLAMA_AUTH = process.env.OLLAMA_AUTH || "";

// Chunking config
const LONG_CONTENT_THRESHOLD = 6000;
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const SUMMARY_TIMEOUT_MS = 300_000;

function ollamaHeaders() {
  const h = { "Content-Type": "application/json" };
  if (OLLAMA_AUTH) h.Authorization = `Basic ${OLLAMA_AUTH}`;
  return h;
}

// Test DB connection on startup
pool
  .connect()
  .then((client) => {
    client.release();
    console.log("PostgreSQL connected");
  })
  .catch((err) =>
    console.error("PostgreSQL connection failed:", err.message),
  );

// Generate embedding via Ollama
async function generateEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
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

// Extract metadata via LLM
async function extractMetadata(text) {
  const prompt = `Extract from this text:
- people: [names mentioned]
- topics: [3-5 main topics]
- type: [conversation|decision|insight|meeting|idea|question|note]
- action_items: [things to do]

Text: ${text}

JSON only, no explanation:`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: ollamaHeaders(),
      body: JSON.stringify({
        model: CHAT_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 300 },
      }),
    });

    if (!response.ok) {
      console.warn(
        `LLM API returned ${response.status}, using fallback metadata`,
      );
      return { type: "unknown", topics: [], people: [], action_items: [] };
    }

    const data = await response.json();
    let jsonText = data.response.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```(?:json)?\s*/, "")
        .replace(/```\s*$/, "");
    }
    return JSON.parse(jsonText);
  } catch (error) {
    console.warn(
      "Metadata extraction failed, using fallback:",
      error.message,
    );
    return { type: "unknown", topics: [], people: [], action_items: [] };
  }
}

// --- Chunking Utilities ---

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // If not the last chunk, find a sentence or whitespace boundary
    if (end < text.length) {
      // Look for sentence boundary (". " or "\n") within ±100 chars of target
      const searchStart = Math.max(end - 100, start);
      const searchEnd = Math.min(end + 100, text.length);
      const window = text.slice(searchStart, searchEnd);

      // Prefer sentence-ending boundary closest to target end
      let bestBreak = -1;
      const targetOffset = end - searchStart;
      for (const pattern of [". ", ".\n", "? ", "!\n", "! ", "?\n", "\n"]) {
        let idx = window.lastIndexOf(pattern, targetOffset + 100);
        while (idx >= 0) {
          const absPos = searchStart + idx + pattern.length;
          if (absPos > start && absPos <= searchEnd) {
            if (
              bestBreak === -1 ||
              Math.abs(absPos - end) < Math.abs(bestBreak - end)
            ) {
              bestBreak = absPos;
            }
          }
          idx = window.lastIndexOf(pattern, idx - 1);
          if (idx < 0) break;
        }
      }

      if (bestBreak > start) {
        end = bestBreak;
      } else {
        // Fall back to nearest whitespace
        const wsIdx = text.lastIndexOf(" ", end);
        if (wsIdx > start) end = wsIdx + 1;
      }
    }

    chunks.push({
      text: text.slice(start, end),
      charStart: start,
      charEnd: end,
    });

    // Advance by (end - overlap), but ensure forward progress
    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

// Generate summary via LLM with timeout
async function generateSummary(text) {
  const prompt = `You are a meeting transcript summarizer. Produce a concise summary (300-500 words) of the following transcript. Capture: key decisions made, action items with owners, major discussion topics, and any unresolved questions. Format as structured prose, not bullet lists.

Transcript:
${text}

Summary:`;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SUMMARY_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: ollamaHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model: CHAT_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 1000 },
      }),
    });

    if (!response.ok) {
      console.warn(
        `[Chunk] Summary LLM returned ${response.status}, skipping summary`,
      );
      return null;
    }

    const data = await response.json();
    return data.response.trim();
  } catch (error) {
    console.warn("[Chunk] Summary generation failed:", error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Process Long Content (Hybrid Chunk + Summary) ---

async function processLongContent(item, mergedMetadata) {
  const t0 = Date.now();
  const groupId = crypto.randomUUID();
  const content = item.content;
  const charCount = content.length;

  console.log(
    `[Chunk] Processing long content: ${charCount} chars, group ${groupId}`,
  );

  // Step A: Generate summary (non-blocking on failure)
  const summaryT0 = Date.now();
  const summary = await generateSummary(content);
  const summaryMs = Date.now() - summaryT0;
  console.log(
    `[Chunk] Summary: ${summary ? `${summary.length} chars` : "skipped"} (${summaryMs}ms)`,
  );

  // Step B: Chunk the full text
  const chunkT0 = Date.now();
  const chunks = chunkText(content);
  const totalChunks = chunks.length;
  const chunkMs = Date.now() - chunkT0;
  console.log(`[Chunk] Split into ${totalChunks} chunks (${chunkMs}ms)`);

  // Step C: Generate embeddings
  const embedT0 = Date.now();

  // Master embedding: use summary if available, else first chunk
  const masterEmbedText = summary || chunks[0].text;
  const masterEmbedding = await generateEmbedding(masterEmbedText);

  // Chunk embeddings (sequential to avoid overwhelming Ollama)
  const chunkEmbeddings = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const emb = await generateEmbedding(chunks[i].text);
      chunkEmbeddings.push(emb);
    } catch (err) {
      console.warn(
        `[Chunk] Embedding failed for chunk ${i + 1}/${totalChunks}: ${err.message}`,
      );
      chunkEmbeddings.push(null);
    }
  }

  const embedMs = Date.now() - embedT0;
  const embedFailed = chunkEmbeddings.filter((e) => e === null).length;
  console.log(
    `[Chunk] Embeddings: ${totalChunks - embedFailed}/${totalChunks} succeeded (${embedMs}ms)`,
  );

  // Step D: Extract metadata from summary or full text
  const metadataText = summary || content.substring(0, 6000);
  const extractedMeta = await extractMetadata(metadataText);
  const masterMeta = {
    ...extractedMeta,
    ...mergedMetadata,
    char_count: charCount,
    chunk_size: CHUNK_SIZE,
    overlap: CHUNK_OVERLAP,
    model_embedding: EMBED_MODEL,
    model_summary: CHAT_MODEL,
  };

  // Step E: Store in database
  const dbT0 = Date.now();

  // Master thought — stores full transcript + summary
  await pool.query(
    `INSERT INTO thoughts
       (content, embedding, metadata, group_id, thought_type, total_chunks, summary)
     VALUES ($1, $2::vector, $3, $4, 'transcript_master', $5, $6)`,
    [
      content,
      `[${masterEmbedding.join(",")}]`,
      masterMeta,
      groupId,
      totalChunks,
      summary,
    ],
  );

  // Chunk thoughts
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const emb = chunkEmbeddings[i];
    const chunkMeta = {
      ...mergedMetadata,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      parent_group_id: groupId,
    };

    if (emb) {
      await pool.query(
        `INSERT INTO thoughts
           (content, embedding, metadata, group_id, thought_type, chunk_index, total_chunks)
         VALUES ($1, $2::vector, $3, $4, 'transcript_chunk', $5, $6)`,
        [
          chunk.text,
          `[${emb.join(",")}]`,
          chunkMeta,
          groupId,
          i + 1,
          totalChunks,
        ],
      );
    } else {
      // Store without embedding — still searchable by metadata
      await pool.query(
        `INSERT INTO thoughts
           (content, metadata, group_id, thought_type, chunk_index, total_chunks)
         VALUES ($1, $2, $3, 'transcript_chunk', $4, $5)`,
        [chunk.text, chunkMeta, groupId, i + 1, totalChunks],
      );
    }
  }

  const dbMs = Date.now() - dbT0;
  const totalMs = Date.now() - t0;

  console.log(
    `[Chunk] Stored: 1 master + ${totalChunks} chunks, group ${groupId} (db: ${dbMs}ms, total: ${totalMs}ms)`,
  );

  return { groupId, totalChunks, summaryGenerated: !!summary };
}

// --- Capture Queue: Background Worker ---
const QUEUE_MAX_RETRIES = 5;
const QUEUE_BASE_DELAY_MS = 5000;
let queueWorkerRunning = false;

async function processQueueItem(item) {
  // Mark as processing
  await pool.query(
    `UPDATE capture_queue SET status = 'processing' WHERE id = $1`,
    [item.id],
  );

  const isLong = item.content.length > LONG_CONTENT_THRESHOLD;

  if (isLong) {
    // Hybrid chunk + summary pipeline
    const mergedMetadata = { ...(item.metadata || {}) };
    if (item.source) mergedMetadata.source = item.source;
    await processLongContent(item, mergedMetadata);
  } else {
    // Short content — single thought, single embedding
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(item.content),
      extractMetadata(item.content),
    ]);

    const mergedMetadata = { ...metadata, ...(item.metadata || {}) };
    if (item.source) mergedMetadata.source = item.source;

    await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata)
       VALUES ($1, $2::vector, $3)`,
      [item.content, `[${embedding.join(",")}]`, mergedMetadata],
    );
  }

  // Mark as complete
  await pool.query(
    `UPDATE capture_queue SET status = 'complete', processed_at = NOW() WHERE id = $1`,
    [item.id],
  );

  const preview = item.content.substring(0, 60);
  console.log(
    `[Queue] Processed: ${item.id} (${item.content.length} chars${isLong ? ", chunked" : ""}) ${preview}...`,
  );
}

async function processQueue() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;

  try {
    while (true) {
      const pending = await pool.query(
        `SELECT * FROM capture_queue
         WHERE status = 'pending'
         ORDER BY created_at LIMIT 1`,
      );

      if (pending.rows.length === 0) break;

      const item = pending.rows[0];

      try {
        await processQueueItem(item);
      } catch (err) {
        const retryCount = item.retry_count + 1;
        const errorMsg =
          err instanceof Error ? err.message : "Unknown error";

        if (retryCount >= QUEUE_MAX_RETRIES) {
          await pool.query(
            `UPDATE capture_queue
             SET status = 'failed', last_error = $1, retry_count = $2
             WHERE id = $3`,
            [errorMsg, retryCount, item.id],
          );
          console.error(
            `[Queue] Failed permanently after ${retryCount} retries: ${item.id} — ${errorMsg}`,
          );
        } else {
          await pool.query(
            `UPDATE capture_queue
             SET status = 'pending', last_error = $1, retry_count = $2
             WHERE id = $3`,
            [errorMsg, retryCount, item.id],
          );
          console.warn(
            `[Queue] Retry ${retryCount}/${QUEUE_MAX_RETRIES} for ${item.id} — ${errorMsg}`,
          );
          const delay = QUEUE_BASE_DELAY_MS * 2 ** (retryCount - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  } finally {
    queueWorkerRunning = false;
  }
}

// Poll for pending items every 10 seconds
setInterval(() => {
  processQueue().catch((err) =>
    console.error("[Queue] Worker error:", err.message),
  );
}, 10_000);

// POST /capture - Queue a thought for async processing
app.post("/capture", async (req, res) => {
  try {
    const { content, metadata: extraMetadata, source } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Content required" });
    }

    const result = await pool.query(
      `INSERT INTO capture_queue (content, source, metadata)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [content, source || null, extraMetadata || null],
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

    processQueue().catch((err) =>
      console.error("[Queue] Processing error:", err.message),
    );
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
    const { q, limit = 10, threshold = 0.7 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" required' });
    }

    const embedding = await generateEmbedding(q);

    const result = await pool.query(
      `SELECT * FROM match_thoughts($1::vector, $2, $3)`,
      [
        `[${embedding.join(",")}]`,
        parseFloat(threshold),
        parseInt(limit, 10),
      ],
    );

    // Collect group_ids from chunk results to fetch parent transcripts
    const groupIds = [
      ...new Set(
        result.rows
          .filter(
            (r) =>
              r.thought_type === "transcript_chunk" && r.group_id,
          )
          .map((r) => r.group_id),
      ),
    ];

    let parentTranscripts = {};
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
    const enrichedResults = result.rows.map((r) => {
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

    res.json({
      query: q,
      count: enrichedResults.length,
      results: enrichedResults,
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
       WHERE group_id = $1 AND thought_type = 'transcript_master'`,
      [groupId],
    );

    if (master.rows.length === 0) {
      return res.status(404).json({ error: "Transcript not found" });
    }

    const chunks = await pool.query(
      `SELECT id, content, chunk_index, metadata, created_at
       FROM thoughts
       WHERE group_id = $1 AND thought_type = 'transcript_chunk'
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

// GET /stats
app.get("/stats", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_thoughts,
        COUNT(DISTINCT metadata->>'type') as unique_types,
        COUNT(DISTINCT metadata->>'source') as unique_sources,
        MIN(created_at) as oldest,
        MAX(created_at) as newest
      FROM thoughts
    `);
    res.json(result.rows[0]);
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
      version: "2.0.0",
      database: "connected",
      queue_pending: pending.rows[0].count,
      embed_model: EMBED_MODEL,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      service: "engram",
      version: "2.0.0",
      database: "disconnected",
      error: error.message,
    });
  }
});

const PORT = parseInt(process.env.PORT || "3700", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Engram API listening on port ${PORT}`);
  console.log(
    `Database: ${process.env.DB_HOST || "localhost"}/${process.env.DB_NAME || "engram"}`,
  );
  console.log(
    `Ollama: ${OLLAMA_URL} (embed: ${EMBED_MODEL}, chat: ${CHAT_MODEL})`,
  );
  console.log(
    `Chunking: threshold=${LONG_CONTENT_THRESHOLD}, size=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP}`,
  );
});
