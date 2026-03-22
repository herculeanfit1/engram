# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Identity

Engram is an agent-readable semantic memory system for the Herculean ecosystem. It stores thoughts with vector embeddings (via Ollama mxbai-embed-large) in PostgreSQL with pgvector, enabling semantic search across stored memories.

## Scope

Single-file Express.js API (`index.js`) with PostgreSQL/pgvector backend. Designed to replace mem0 with a self-hosted, MCP-compatible memory system.

Key endpoints:
- `POST /thoughts` — store a thought with auto-generated embedding
- `GET /thoughts/search` — semantic similarity search
- `GET /health` — health check

## Commands

```bash
# Install dependencies
npm install

# Run locally
DB_PASSWORD=xxx node index.js

# Run with 1Password
op run --env-file=.env.1p.template -- node index.js

# Run database migrations
node migrations/001_init.js
```

Port: **3700** (configurable via `PORT` env var)

## Standards

This repo follows the Herculean Ecosystem Standards v1.1. See `STANDARDS.md`.

- **Pre-commit**: Biome check + no-dot-env hook
- **Secrets**: 1Password via `.env.1p.template` with `op://` references
- **Linting**: Biome
