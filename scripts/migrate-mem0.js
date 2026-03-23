#!/usr/bin/env node
/**
 * Migrate mem0 memories → Engram
 *
 * Uses /capture (not /capture/batch) for full LLM metadata extraction per thought.
 * Expects ~45s per thought through Twingate proxy.
 *
 * Usage:
 *   node scripts/migrate-mem0.js [--dry-run]
 *
 * Environment:
 *   MEM0_URL    - mem0 API (default: http://10.0.0.10:8765)
 *   ENGRAM_URL  - Engram API (default: http://10.0.0.10:3700)
 *   MEM0_USER   - mem0 user_id (default: dude)
 */

const MEM0_URL = process.env.MEM0_URL || "http://10.0.0.10:8765";
const ENGRAM_URL = process.env.ENGRAM_URL || "http://10.0.0.10:3700";
const MEM0_USER = process.env.MEM0_USER || "dude";
const DRY_RUN = process.argv.includes("--dry-run");

async function fetchMem0Memories() {
  const res = await fetch(`${MEM0_URL}/api/v1/memories/?user_id=${MEM0_USER}`);
  if (!res.ok)
    throw new Error(`mem0 API returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.items || [];
}

function transformMemory(mem) {
  return {
    content: mem.content,
    source: "mem0",
    metadata: {
      source: "mem0",
      mem0_id: mem.id,
      mem0_state: mem.state,
      mem0_app: mem.app_name || "openmemory",
      mem0_categories: mem.categories || [],
      mem0_created_at: mem.created_at
        ? new Date(mem.created_at * 1000).toISOString()
        : null,
      ...(mem.metadata_ && Object.keys(mem.metadata_).length > 0
        ? { mem0_metadata: mem.metadata_ }
        : {}),
    },
  };
}

async function captureThought(thought) {
  const res = await fetch(`${ENGRAM_URL}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thought),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Engram /capture returned ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  console.log("=== mem0 → Engram Migration ===");
  console.log(`mem0:   ${MEM0_URL} (user: ${MEM0_USER})`);
  console.log(`Engram: ${ENGRAM_URL}`);
  if (DRY_RUN) console.log("*** DRY RUN — no writes ***");
  console.log();

  // 1. Export mem0 memories
  console.log("Fetching mem0 memories...");
  const memories = await fetchMem0Memories();
  const active = memories.filter((m) => m.state === "active");
  console.log(`Found ${memories.length} total, ${active.length} active\n`);

  if (active.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // 2. Check Engram health
  const healthRes = await fetch(`${ENGRAM_URL}/health`);
  const health = await healthRes.json();
  if (health.status !== "ok") {
    console.error("Engram is not healthy:", health);
    process.exit(1);
  }
  console.log(`Engram health: ${health.status}, DB: ${health.database}\n`);

  // 3. Get pre-migration stats
  const preStats = await (await fetch(`${ENGRAM_URL}/stats`)).json();
  console.log(`Pre-migration: ${preStats.total_thoughts} thoughts in Engram\n`);

  // 4. Migrate each memory serially (rich metadata extraction)
  let succeeded = 0;
  let failed = 0;
  const errors = [];
  const startTime = Date.now();

  for (let i = 0; i < active.length; i++) {
    const mem = active[i];
    const thought = transformMemory(mem);
    const preview = mem.content.substring(0, 80);
    const progress = `[${i + 1}/${active.length}]`;

    if (DRY_RUN) {
      console.log(`${progress} SKIP: ${preview}`);
      succeeded++;
      continue;
    }

    try {
      const t0 = Date.now();
      const _result = await captureThought(thought);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${progress} OK (${elapsed}s): ${preview}`);
      succeeded++;
    } catch (err) {
      console.error(`${progress} FAIL: ${preview}`);
      console.error(`  Error: ${err.message}`);
      failed++;
      errors.push({ index: i, content: preview, error: err.message });
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);

  // 5. Post-migration stats
  console.log();
  if (!DRY_RUN) {
    const postStats = await (await fetch(`${ENGRAM_URL}/stats`)).json();
    console.log(
      `Post-migration: ${postStats.total_thoughts} thoughts in Engram`,
    );
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Time:      ${totalTime}s`);

  if (errors.length > 0) {
    console.log("\nFailed items:");
    for (const e of errors) {
      console.log(`  ${e.index}: ${e.content} — ${e.error}`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
