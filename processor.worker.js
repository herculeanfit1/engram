// Engram Processing Worker Thread
// Runs the full pipeline (LLM summary, chunking, embedding, metadata, dispatch)
// off the main Express thread so /health and /search stay responsive.

import crypto from "node:crypto";
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";

// --- Catch silent failures in the worker thread ---
process.on("unhandledRejection", (reason, _promise) => {
  const msg = `[Worker] UNHANDLED REJECTION: ${reason?.stack || reason}`;
  console.error(msg);
  parentPort?.postMessage({ type: "log", level: "error", message: msg });
});

process.on("uncaughtException", (err) => {
  const msg = `[Worker] UNCAUGHT EXCEPTION: ${err.stack}`;
  console.error(msg);
  parentPort?.postMessage({ type: "log", level: "error", message: msg });
});

// --- Own DB pool (DO NOT share with main thread) ---
const pool = new pg.Pool({
  host: workerData.dbHost,
  port: workerData.dbPort,
  database: workerData.dbName,
  user: workerData.dbUser,
  password: workerData.dbPassword,
  max: 5,
});

// --- Config from workerData ---
const OLLAMA_URL = workerData.ollamaUrl;
const OLLAMA_AUTH = workerData.ollamaAuth;
const EMBED_MODEL = workerData.ollamaEmbedModel;
const CHAT_MODEL = workerData.ollamaChatModel;
const DUDEDASH_URL = workerData.dudedashUrl;
const DUDEDASH_API_KEY = workerData.dudedashApiKey;
const DISPATCH_ENABLED = workerData.dispatchEnabled;
const OPENBRAIN_MCP_URL = workerData.openbrainMcpUrl;
const WHISPER_URL = workerData.whisperUrl;

// --- Chunking config ---
const LONG_CONTENT_THRESHOLD = 6000;
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const SUMMARY_TIMEOUT_MS = 300_000;
const EMBED_TIMEOUT_MS = 60_000;
const METADATA_TIMEOUT_MS = 60_000;
const QUEUE_MAX_RETRIES = 5;
const QUEUE_BASE_DELAY_MS = 5000;
const DISPATCH_TIMEOUT_MS = 5000;
const DISPATCH_MAX_RETRIES = 5;
const OPENBRAIN_TIMEOUT_MS = 15_000;
const WHISPER_TIMEOUT_MS = 600_000; // 10 min for long audio

let shuttingDown = false;
let queueWorkerRunning = false;

// ============================================================
// Processing functions (moved from index.js)
// ============================================================

function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function transcribeAudio(audioPath) {
  if (!WHISPER_URL) throw new Error("WHISPER_URL not configured");
  if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);

  const fileBuffer = fs.readFileSync(audioPath);
  const filename = audioPath.split("/").pop();
  const ext = filename.split(".").pop() || "m4a";
  const mimeTypes = {
    m4a: "audio/x-m4a",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    webm: "audio/webm",
  };

  const formData = new FormData();
  formData.append(
    "file",
    new File([fileBuffer], filename, { type: mimeTypes[ext] || "audio/mpeg" }),
  );
  formData.append("model", "Systran/faster-whisper-small");
  formData.append("response_format", "json");
  formData.append("temperature", "0.0");

  const resp = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`Whisper returned ${resp.status}: ${errBody.substring(0, 300)}`);
  }

  const data = await resp.json();
  const transcript = (data.text || "").trim();
  if (!transcript) throw new Error("Transcription produced empty text");

  return transcript;
}

function ollamaHeaders() {
  const h = { "Content-Type": "application/json" };
  if (OLLAMA_AUTH) h.Authorization = `Basic ${OLLAMA_AUTH}`;
  return h;
}

async function generateEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: ollamaHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embeddings API returned ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.embedding;
}

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
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`LLM API returned ${response.status}, using fallback metadata`);
      return { type: "unknown", topics: [], people: [], action_items: [] };
    }

    const data = await response.json();
    let jsonText = data.response.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    return JSON.parse(jsonText);
  } catch (error) {
    console.warn("Metadata extraction failed, using fallback:", error.message);
    return { type: "unknown", topics: [], people: [], action_items: [] };
  }
}

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const searchStart = Math.max(end - 100, start);
      const searchEnd = Math.min(end + 100, text.length);
      const window = text.slice(searchStart, searchEnd);

      let bestBreak = -1;
      const targetOffset = end - searchStart;
      for (const pattern of [". ", ".\n", "? ", "!\n", "! ", "?\n", "\n"]) {
        let idx = window.lastIndexOf(pattern, targetOffset + 100);
        while (idx >= 0) {
          const absPos = searchStart + idx + pattern.length;
          if (absPos > start && absPos <= searchEnd) {
            if (bestBreak === -1 || Math.abs(absPos - end) < Math.abs(bestBreak - end)) {
              bestBreak = absPos;
            }
          }
          if (idx <= 0) break;
          idx = window.lastIndexOf(pattern, idx - 1);
        }
      }

      if (bestBreak > start) {
        end = bestBreak;
      } else {
        const wsIdx = text.lastIndexOf(" ", end);
        if (wsIdx > start) end = wsIdx + 1;
      }
    }

    chunks.push({
      text: text.slice(start, end),
      charStart: start,
      charEnd: end,
    });

    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

async function generateSummary(text) {
  const prompt = `You are a meeting transcript summarizer. Produce a concise summary (300-500 words) of the following transcript. Capture: key decisions made, action items with owners, major discussion topics, and any unresolved questions. Format as structured prose, not bullet lists.

Transcript:
${text}

Summary:`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

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
      console.warn(`[Chunk] Summary LLM returned ${response.status}, skipping summary`);
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

// --- DudeDash Task Dispatch ---

function actionItemHash(text) {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function dispatchActionItems(thoughtId, metadata, contentPreview) {
  if (!DISPATCH_ENABLED || !DUDEDASH_URL || !DUDEDASH_API_KEY) return;
  const items = metadata?.action_items;
  if (!Array.isArray(items) || items.length === 0) return;

  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    const hash = actionItemHash(item);

    try {
      const ins = await pool.query(
        `INSERT INTO task_dispatch_log (thought_id, action_item_hash, action_item_text)
         VALUES ($1, $2, $3)
         ON CONFLICT (action_item_hash) DO NOTHING
         RETURNING id`,
        [thoughtId, hash, item],
      );
      if (ins.rows.length === 0) {
        console.log(`[Dispatch] Duplicate skipped: ${item.substring(0, 60)}`);
        continue;
      }
      const logId = ins.rows[0].id;

      const preview = (contentPreview || "").substring(0, 500);
      const payload = {
        title: item,
        description: `[Engram thought ${thoughtId}]\n\n${preview}`,
        column: "backlog",
        tags: Array.isArray(metadata.topics) ? metadata.topics : [],
        assignee: ["tk"],
        category: "personal",
        priority: "medium",
        source: "a2a",
      };

      const resp = await fetch(`${DUDEDASH_URL}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": DUDEDASH_API_KEY,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });

      if (resp.ok) {
        const task = await resp.json();
        await pool.query(
          `UPDATE task_dispatch_log
           SET status = 'dispatched', dudedash_task_id = $1, dispatched_at = NOW()
           WHERE id = $2`,
          [task.id, logId],
        );
        console.log(`[Dispatch] Task created: "${item.substring(0, 60)}" -> ${task.id}`);
      } else {
        const errBody = await resp.text().catch(() => "");
        await pool.query(
          `UPDATE task_dispatch_log SET status = 'failed', last_error = $1 WHERE id = $2`,
          [`HTTP ${resp.status}: ${errBody.substring(0, 200)}`, logId],
        );
        console.warn(`[Dispatch] Failed (${resp.status}): ${item.substring(0, 60)}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      await pool
        .query(
          `UPDATE task_dispatch_log
           SET status = 'failed', last_error = $1
           WHERE action_item_hash = $2 AND status = 'pending'`,
          [errMsg.substring(0, 500), hash],
        )
        .catch(() => {});
      console.warn(`[Dispatch] Error: ${errMsg} — ${item.substring(0, 60)}`);
    }
  }
}

// --- Forward to Open Brain (Supabase) for cross-AI access ---

async function forwardToOpenBrain(content, _metadata) {
  if (!OPENBRAIN_MCP_URL) return;

  try {
    const response = await fetch(OPENBRAIN_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "capture_thought",
          arguments: {
            content: content,
            source: "engram",
          },
        },
      }),
      signal: AbortSignal.timeout(OPENBRAIN_TIMEOUT_MS),
    });

    if (response.ok) {
      console.log(`[OpenBrain] Forwarded: ${content.substring(0, 60)}...`);
    } else {
      console.warn(`[OpenBrain] Forward failed: ${response.status}`);
    }
  } catch (err) {
    console.warn(`[OpenBrain] Forward error: ${err.message}`);
  }
}

// --- Dispatch retry sweep (every 60s) ---
const dispatchRetryInterval = setInterval(async () => {
  if (shuttingDown || !DISPATCH_ENABLED || !DUDEDASH_URL || !DUDEDASH_API_KEY) return;
  try {
    const failed = await pool.query(
      `SELECT id, action_item_text, thought_id, retry_count
       FROM task_dispatch_log
       WHERE status = 'failed' AND retry_count < $1
         AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at LIMIT 10`,
      [DISPATCH_MAX_RETRIES],
    );
    for (const row of failed.rows) {
      try {
        const thought = await pool.query(`SELECT content FROM thoughts WHERE id = $1`, [
          row.thought_id,
        ]);
        const preview = thought.rows[0]?.content?.substring(0, 500) || "";

        const resp = await fetch(`${DUDEDASH_URL}/api/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": DUDEDASH_API_KEY,
          },
          body: JSON.stringify({
            title: row.action_item_text,
            description: `[Engram thought ${row.thought_id}]\n\n${preview}`,
            column: "backlog",
            tags: [],
            assignee: ["tk"],
            category: "personal",
            priority: "medium",
            source: "a2a",
          }),
          signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
        });

        if (resp.ok) {
          const task = await resp.json();
          await pool.query(
            `UPDATE task_dispatch_log
             SET status = 'dispatched', dudedash_task_id = $1, dispatched_at = NOW(), retry_count = $2
             WHERE id = $3`,
            [task.id, row.retry_count + 1, row.id],
          );
          console.log(
            `[Dispatch] Retry succeeded: "${row.action_item_text.substring(0, 60)}" -> ${task.id}`,
          );
        } else {
          const errBody = await resp.text().catch(() => "");
          await pool.query(
            `UPDATE task_dispatch_log SET last_error = $1, retry_count = $2 WHERE id = $3`,
            [`HTTP ${resp.status}: ${errBody.substring(0, 200)}`, row.retry_count + 1, row.id],
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        await pool.query(
          `UPDATE task_dispatch_log SET last_error = $1, retry_count = $2 WHERE id = $3`,
          [errMsg.substring(0, 500), row.retry_count + 1, row.id],
        );
      }
    }
  } catch (err) {
    console.error("[Dispatch] Retry sweep error:", err.message);
  }
}, 60_000);

// ============================================================
// Process Long Content (Hybrid Chunk + Summary)
// ============================================================

async function processLongContent(item, mergedMetadata, hash) {
  const t0 = Date.now();
  const groupId = crypto.randomUUID();
  const content = item.content;
  const charCount = content.length;

  console.log(`[Chunk] Processing long content: ${charCount} chars, group ${groupId}`);

  // Step A: Generate summary
  const summaryT0 = Date.now();
  let summary;
  try {
    summary = await generateSummary(content);
    parentPort.postMessage({
      type: "log",
      level: "info",
      message: `generateSummary RESOLVED, length: ${summary?.length}`,
    });
  } catch (err) {
    parentPort.postMessage({
      type: "log",
      level: "error",
      message: `generateSummary REJECTED: ${err?.stack || err}`,
    });
    throw err;
  }
  if (shuttingDown) throw new Error("Shutdown requested");
  const summaryMs = Date.now() - summaryT0;
  parentPort.postMessage({
    type: "log",
    level: "info",
    message: `Summary: ${summary ? `${summary.length} chars` : "skipped"} (${summaryMs}ms)`,
  });

  // Step B: Chunk the full text
  parentPort.postMessage({
    type: "log",
    level: "info",
    message: `[B1] Before chunkText (${charCount} chars)`,
  });
  const chunkT0 = Date.now();
  const chunks = chunkText(content);
  const totalChunks = chunks.length;
  const chunkMs = Date.now() - chunkT0;
  parentPort.postMessage({
    type: "log",
    level: "info",
    message: `[B2] After chunkText: ${totalChunks} chunks (${chunkMs}ms)`,
  });

  // Step C: Generate embeddings
  const embedT0 = Date.now();

  const masterEmbedText = summary || chunks[0].text;
  parentPort.postMessage({
    type: "log",
    level: "info",
    message: `[C1] Before master embedding (${masterEmbedText.length} chars)`,
  });
  let masterEmbedding;
  try {
    masterEmbedding = await generateEmbedding(masterEmbedText);
    parentPort.postMessage({
      type: "log",
      level: "info",
      message: `Master embedding done: ${masterEmbedding?.length} dims (${Date.now() - embedT0}ms)`,
    });
  } catch (err) {
    parentPort.postMessage({
      type: "log",
      level: "error",
      message: `Master embedding FAILED: ${err.message} (${Date.now() - embedT0}ms)`,
    });
    throw err;
  }
  if (shuttingDown) throw new Error("Shutdown requested");

  const chunkEmbeddings = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkEmbedT0 = Date.now();
    try {
      if (i % 5 === 0)
        parentPort.postMessage({
          type: "log",
          level: "info",
          message: `Embedding chunk ${i + 1}/${totalChunks}...`,
        });
      const emb = await generateEmbedding(chunks[i].text);
      chunkEmbeddings.push(emb);
    } catch (err) {
      parentPort.postMessage({
        type: "log",
        level: "error",
        message: `Embedding failed chunk ${i + 1}/${totalChunks}: ${err.message} (${Date.now() - chunkEmbedT0}ms)`,
      });
      chunkEmbeddings.push(null);
    }
    if (shuttingDown) throw new Error("Shutdown requested");
  }

  const embedMs = Date.now() - embedT0;
  const embedFailed = chunkEmbeddings.filter((e) => e === null).length;
  console.log(
    `[Chunk] Embeddings: ${totalChunks - embedFailed}/${totalChunks} succeeded (${embedMs}ms)`,
  );

  // Step D: Extract metadata
  const metadataText = summary || content.substring(0, 6000);
  const extractedMeta = await extractMetadata(metadataText);
  if (shuttingDown) throw new Error("Shutdown requested");
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

  const masterInsert = await pool.query(
    `INSERT INTO thoughts
       (content, embedding, metadata, group_id, thought_type, total_chunks, summary, content_hash)
     VALUES ($1, $2::vector, $3, $4, 'transcript_master', $5, $6, $7) RETURNING id`,
    [content, `[${masterEmbedding.join(",")}]`, masterMeta, groupId, totalChunks, summary, hash],
  );
  const masterId = masterInsert.rows[0].id;

  // Dispatch action items to DudeDash
  await dispatchActionItems(masterId, masterMeta, content.substring(0, 500));

  // Forward full content to Open Brain (it handles its own chunking)
  await forwardToOpenBrain(content, masterMeta);

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
        [chunk.text, `[${emb.join(",")}]`, chunkMeta, groupId, i + 1, totalChunks],
      );
    } else {
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

// ============================================================
// Queue Processing
// ============================================================

async function processQueueItem(item) {
  await pool.query(`UPDATE capture_queue SET status = 'processing' WHERE id = $1`, [item.id]);

  // Audio items: transcribe first, then process the transcript
  const audioPath = item.metadata?.audio_path;
  if (audioPath) {
    console.log(
      `[Audio] Transcribing: ${item.metadata.audio_filename || audioPath} (${((item.metadata.audio_size_bytes || 0) / (1024 * 1024)).toFixed(1)}MB)`,
    );
    const t0 = Date.now();
    const transcript = await transcribeAudio(audioPath);
    const transcribeMs = Date.now() - t0;
    console.log(
      `[Audio] Transcribed: ${transcript.length} chars in ${(transcribeMs / 1000).toFixed(1)}s`,
    );

    // Replace placeholder content with actual transcript
    item.content = transcript;

    // Update queue row with transcript content and hash for dedup
    const hash = contentHash(transcript);
    await pool.query(`UPDATE capture_queue SET content = $1, content_hash = $2 WHERE id = $3`, [
      transcript,
      hash,
      item.id,
    ]);
    item.content_hash = hash;

    // Clean up temp audio file
    try {
      fs.unlinkSync(audioPath);
    } catch {
      /* already gone */
    }

    // Add transcription stats to metadata
    item.metadata.transcribe_ms = transcribeMs;
    item.metadata.transcript_chars = transcript.length;
    delete item.metadata.audio_path; // no longer needed
  }

  const isLong = item.content.length > LONG_CONTENT_THRESHOLD;
  const hash = item.content_hash || contentHash(item.content);

  if (isLong) {
    const mergedMetadata = { ...(item.metadata || {}) };
    if (item.source) mergedMetadata.source = item.source;
    await processLongContent(item, mergedMetadata, hash);
  } else {
    const [embedding, metadata] = await Promise.all([
      generateEmbedding(item.content),
      extractMetadata(item.content),
    ]);
    if (shuttingDown) throw new Error("Shutdown requested");

    const mergedMetadata = { ...metadata, ...(item.metadata || {}) };
    if (item.source) mergedMetadata.source = item.source;

    const insertResult = await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata, content_hash)
       VALUES ($1, $2::vector, $3, $4) RETURNING id`,
      [item.content, `[${embedding.join(",")}]`, mergedMetadata, hash],
    );
    const thoughtId = insertResult.rows[0].id;

    await dispatchActionItems(thoughtId, mergedMetadata, item.content);
    await forwardToOpenBrain(item.content, mergedMetadata);
  }

  await pool.query(
    `UPDATE capture_queue SET status = 'complete', processed_at = NOW() WHERE id = $1`,
    [item.id],
  );

  const preview = item.content.substring(0, 60);
  console.log(
    `[Queue] Processed: ${item.id} (${item.content.length} chars${isLong ? ", chunked" : ""}) ${preview}...`,
  );

  return {
    thoughtId: item.id,
    chars: item.content.length,
    chunks: isLong ? undefined : 0,
  };
}

async function processQueue() {
  if (queueWorkerRunning || shuttingDown) return;
  queueWorkerRunning = true;

  try {
    while (!shuttingDown) {
      const pending = await pool.query(
        `SELECT * FROM capture_queue
         WHERE status = 'pending'
         ORDER BY created_at LIMIT 1`,
      );

      if (pending.rows.length === 0) break;

      const item = pending.rows[0];
      const t0 = Date.now();

      try {
        const result = await processQueueItem(item);
        const ms = Date.now() - t0;
        parentPort.postMessage({
          type: "complete",
          thoughtId: result.thoughtId,
          chars: result.chars,
          chunks: result.chunks,
          ms,
        });
      } catch (err) {
        if (err.message === "Shutdown requested") {
          // Leave item as 'processing' — will be picked up on restart
          console.log(`[Queue] Shutdown during processing of ${item.id}, leaving as 'processing'`);
          break;
        }

        const retryCount = item.retry_count + 1;
        const errorMsg = err instanceof Error ? err.message : "Unknown error";

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
          parentPort.postMessage({
            type: "error",
            thoughtId: item.id,
            error: errorMsg,
          });
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

// ============================================================
// Message handling from main thread
// ============================================================

parentPort.on("message", (msg) => {
  switch (msg.type) {
    case "wake":
      processQueue().catch((err) => console.error("[Worker] Queue error:", err.message));
      break;
    case "shutdown":
      console.log("[Worker] Shutdown signal received");
      shuttingDown = true;
      // Clear intervals so the process can exit once current work finishes
      clearInterval(pollInterval);
      clearInterval(dispatchRetryInterval);
      // If not currently processing, close pool and exit
      if (!queueWorkerRunning) {
        pool.end().then(() => process.exit(0));
      }
      break;
  }
});

// --- Poll loop (same 10s interval as before) ---
const pollInterval = setInterval(() => {
  if (!shuttingDown) {
    processQueue().catch((err) => console.error("[Worker] Queue error:", err.message));
  }
}, 10_000);

// --- Recovery: reset stale 'processing' items on worker start ---
pool
  .query(
    `UPDATE capture_queue SET status = 'pending'
     WHERE status = 'processing'
     RETURNING id`,
  )
  .then((result) => {
    if (result.rows.length > 0) {
      console.log(`[Worker] Reset ${result.rows.length} stale 'processing' items to 'pending'`);
    }
  })
  .catch((err) => console.error("[Worker] Failed to reset stale items:", err.message));

// --- Notify main thread ---
parentPort.postMessage({ type: "ready" });
console.log("[Worker] Processing worker started");
console.log(`[Worker] Task dispatch: ${DISPATCH_ENABLED ? "enabled" : "DISABLED"}`);
console.log(
  `[Worker] Open Brain forward: ${OPENBRAIN_MCP_URL ? "enabled" : "DISABLED (no OPENBRAIN_MCP_URL)"}`,
);

// --- Clean exit ---
process.on("beforeExit", async () => {
  await pool.end();
});
