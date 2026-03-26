# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Identity

Engram is an agent-readable semantic memory system for the Herculean ecosystem. It stores thoughts with vector embeddings (via Ollama bge-m3, 1024-dim) in PostgreSQL with pgvector, enabling semantic search across stored memories. Designed to replace mem0 with a self-hosted, MCP-compatible memory system.

## Scope

Engram provides semantic memory capture and retrieval for all agents in the Herculean ecosystem. It is consumed by other agents via its REST API (port 3700) or MCP protocol (port 3800). It depends on PostgreSQL with pgvector for storage and Ollama for embeddings and LLM features (summarization, metadata extraction).

## Architecture

Two services, one database:

- **Main API** (`index.js`, port 3700) — Single-file Express.js REST API. All routes, the queue worker, chunking logic, and Ollama integration live in this one file. Handles capture, search, chunking, summary generation, and an async queue worker that polls every 10s.
- **MCP Server** (`mcp-server/`, port 3800) — TypeScript server exposing 4 tools (`engram_search`, `engram_capture`, `engram_stats`, `engram_health`) via Model Context Protocol. Supports stdio (default) and HTTP transports. The MCP server is a thin proxy — it calls the main API over HTTP, so the main API must be running.
- **Database** — PostgreSQL with pgvector. Two tables: `thoughts` (stored memories with embeddings) and `capture_queue` (async processing queue). A `match_thoughts` SQL function handles vector similarity search with threshold and JSONB metadata filtering.

### Data flow for long content (>6000 chars)

Content enters via `/capture` -> stored in `capture_queue` -> background worker generates LLM summary + splits into sentence-boundary-aware chunks (1500 chars, 200 overlap) -> embeddings for master + each chunk -> all stored with shared `group_id`. Summary/metadata failures don't block processing.

### Duplicate detection

`/capture` computes a SHA-256 hash of content and checks both `thoughts` (transcript_master rows) and `capture_queue` (pending/processing) before accepting. Duplicates return HTTP 409.

## Commands

```bash
# Main API
npm install
op run --env-file=.env.1p.template -- node index.js    # production (1Password)
DB_PASSWORD=xxx node index.js                           # local dev

# MCP Server
cd mcp-server && npm install && npm run build           # compile TS -> dist/
cd mcp-server && npm start                              # run (stdio mode)
cd mcp-server && npm run dev                            # tsc --watch

# Lint (whole repo — also runs as pre-commit hook)
npx @biomejs/biome check .

# Lint with auto-fix (what the pre-commit hook runs)
npx @biomejs/biome check --write .

# Apply database migrations (run in order against PostgreSQL)
psql -U engram -d engram -f migrations/001_create_schema.sql
# ... through 004_add_content_hash.sql

# Migration tool (mem0 -> engram)
node scripts/migrate-mem0.js [--dry-run]
```

There is no test suite. Validation is done via linting (Biome) and CI standards checks.

## Key endpoints (main API)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/capture` | Queue a thought for async processing |
| POST | `/capture/batch` | Batch import (direct insert, skips queue) |
| GET | `/search?q=...` | Semantic similarity search |
| GET | `/transcript/:groupId` | Full transcript + chunks |
| GET | `/queue` | Capture queue status |
| GET | `/stats` | Thought counts, types, sources |
| GET | `/health` | Health check + queue depth |

## Environment variables

Main API uses: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `OLLAMA_URL`, `OLLAMA_EMBED_MODEL` (default: bge-m3), `OLLAMA_CHAT_MODEL` (default: qwen2.5:32b), `OLLAMA_AUTH`, `PORT`.

MCP Server uses: `ENGRAM_URL`, `MCP_API_KEYS` (format: `label1:key1,label2:key2`), `TRANSPORT` (stdio|http), `PORT`, `AUDIT_LOG_LEVEL`.

## Standards

This repo follows the Herculean Ecosystem Standards v1.1. See `STANDARDS.md`.

- **Pre-commit**: Biome check (with `--write` auto-fix) + no-dot-env hook
- **Secrets**: 1Password via `.env.1p.template` with `op://` references
- **Linting**: Biome (spaces, 2-width indent). Config in `biome.json`.
- **CI**: `.github/workflows/standards-check.yml` validates required files (STANDARDS.md, CLAUDE.md, .gitignore), linting, and Node.js conventions on PR/push to main. CI checks that CLAUDE.md contains Identity, Scope, Commands, and Standards sections.
- **Node.js**: ES modules (`"type": "module"`), Node 22+, Express 5
