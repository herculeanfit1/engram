import express from "express";
import pg from "pg";

const app = express();
app.use(express.json({ limit: "1mb" }));

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
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large";
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || "qwen2.5:32b";
const OLLAMA_AUTH = process.env.OLLAMA_AUTH || ""; // Base64 Basic auth for Twingate proxy

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
  .catch((err) => console.error("PostgreSQL connection failed:", err.message));

// Generate embedding via Ollama
async function generateEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embeddings API returned ${response.status}`);
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
    // Strip markdown code fences if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```(?:json)?\s*/, "")
        .replace(/```\s*$/, "");
    }
    return JSON.parse(jsonText);
  } catch (error) {
    console.warn("Metadata extraction failed, using fallback:", error.message);
    return { type: "unknown", topics: [], people: [], action_items: [] };
  }
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

  // Generate embedding + extract metadata (can fail if Ollama is down)
  const [embedding, metadata] = await Promise.all([
    generateEmbedding(item.content),
    extractMetadata(item.content),
  ]);

  // Merge extracted metadata with any stored metadata
  const mergedMetadata = { ...metadata, ...(item.metadata || {}) };
  if (item.source) mergedMetadata.source = item.source;

  // Insert into thoughts table
  await pool.query(
    `INSERT INTO thoughts (content, embedding, metadata)
     VALUES ($1, $2::vector, $3)`,
    [item.content, `[${embedding.join(",")}]`, mergedMetadata],
  );

  // Mark as complete
  await pool.query(
    `UPDATE capture_queue SET status = 'complete', processed_at = NOW() WHERE id = $1`,
    [item.id],
  );

  console.log(
    `[Queue] Processed: ${item.id} (${item.content.substring(0, 60)}...)`,
  );
}

async function processQueue() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;

  try {
    while (true) {
      const pending = await pool.query(
        `SELECT * FROM capture_queue WHERE status = 'pending' ORDER BY created_at LIMIT 1`,
      );

      if (pending.rows.length === 0) break;

      const item = pending.rows[0];

      try {
        await processQueueItem(item);
      } catch (err) {
        const retryCount = item.retry_count + 1;
        const errorMsg = err instanceof Error ? err.message : "Unknown error";

        if (retryCount >= QUEUE_MAX_RETRIES) {
          await pool.query(
            `UPDATE capture_queue SET status = 'failed', last_error = $1, retry_count = $2 WHERE id = $3`,
            [errorMsg, retryCount, item.id],
          );
          console.error(
            `[Queue] Failed permanently after ${retryCount} retries: ${item.id} — ${errorMsg}`,
          );
        } else {
          await pool.query(
            `UPDATE capture_queue SET status = 'pending', last_error = $1, retry_count = $2 WHERE id = $3`,
            [errorMsg, retryCount, item.id],
          );
          console.warn(
            `[Queue] Retry ${retryCount}/${QUEUE_MAX_RETRIES} for ${item.id} — ${errorMsg}`,
          );
          // Exponential backoff before next attempt
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

    // Persist to queue immediately — data is safe even if Ollama is down
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

    // Trigger background processing (non-blocking)
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

// GET /search - Semantic search
app.get("/search", async (req, res) => {
  try {
    const { q, limit = 10, threshold = 0.7 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" required' });
    }

    const embedding = await generateEmbedding(q);

    const result = await pool.query(
      `SELECT * FROM match_thoughts($1::vector, $2, $3)`,
      [`[${embedding.join(",")}]`, parseFloat(threshold), parseInt(limit, 10)],
    );

    res.json({ query: q, count: result.rows.length, results: result.rows });
  } catch (error) {
    console.error("Search error:", error);
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
      version: "1.1.0",
      database: "connected",
      queue_pending: pending.rows[0].count,
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      service: "engram",
      version: "1.1.0",
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
});
