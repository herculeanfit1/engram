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

// POST /capture - Capture a thought
app.post("/capture", async (req, res) => {
  try {
    const { content, metadata: extraMetadata, source } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Content required" });
    }

    console.log(`Capturing thought (${content.length} chars)...`);

    const startTime = Date.now();
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(content),
      extractMetadata(content),
    ]);
    const processingTime = Date.now() - startTime;

    // Merge extracted metadata with any extra metadata provided
    const mergedMetadata = { ...metadata, ...extraMetadata };
    if (source) mergedMetadata.source = source;

    const result = await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata)
       VALUES ($1, $2::vector, $3)
       RETURNING id, created_at`,
      [content, `[${embedding.join(",")}]`, mergedMetadata],
    );

    console.log(`Captured in ${processingTime}ms: ${result.rows[0].id}`);

    res.json({
      status: "captured",
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      metadata: mergedMetadata,
      processing_time_ms: processingTime,
    });
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
    res.json({
      status: "ok",
      service: "engram",
      version: "1.0.0",
      database: "connected",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      service: "engram",
      version: "1.0.0",
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
