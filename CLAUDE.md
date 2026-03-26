# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Identity

Engram is an agent-readable semantic memory system for the Herculean ecosystem. It stores thoughts with vector embeddings (via Ollama bge-m3, 1024-dim) in PostgreSQL with pgvector, enabling semantic search across stored memories. Designed to replace mem0 with a self-hosted, MCP-compatible memory system.

## Architecture

Two services, one database:

- **Main API** (`index.js`, port 3700) — Single-file Express.js REST API. Handles capture, search, chunking, summary generation, and an async queue worker that polls every 10s.
- **MCP Server** (`mcp-server/`, port 3800) — TypeScript server exposing 4 tools (`engram_search`, `engram_capture`, `engram_stats`, `engram_health`) via Model Context Protocol. Supports stdio (default) and HTTP transports. Calls the main API over HTTP.
- **Database** — PostgreSQL with pgvector. Schema managed via SQL migrations in `migrations/`.

### Data flow for long content (>6000 chars)

Content enters via `/capture` -> stored in `capture_queue` -> background worker generates LLM summary + splits into sentence-boundary-aware chunks (1500 chars, 200 overlap) -> embeddings for master + each chunk -> all stored with shared `group_id`. Summary/metadata failures don't block processing.

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

# Lint (whole repo)
npx @biomejs/biome check .

# Migration tool
node scripts/migrate-mem0.js [--dry-run]
```

Database migrations are raw SQL files in `migrations/` — apply them directly against PostgreSQL.

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

- **Pre-commit**: Biome check + no-dot-env hook
- **Secrets**: 1Password via `.env.1p.template` with `op://` references
- **Linting**: Biome (spaces, 2-width indent)
- **CI**: `.github/workflows/standards-check.yml` validates required files, linting, and Node.js conventions on PR/push to main
- **Node.js**: ES modules (`"type": "module"`), Node 22+, Express 5
