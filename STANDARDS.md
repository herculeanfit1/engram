# Herculean Ecosystem Standards

Version 1.2 — Last updated 2026-04-01

This document defines the engineering standards enforced across all Herculean agent repositories. It covers both **Python** and **Node.js** codebases. Compliance is verified by HerculeanOlympus via `checks/standards-compliance.js`.

For repos with no runtime code (infrastructure, config, knowledge bases), see `STANDARDS-NONCODE.md`.

---

## 1. Runtime Conventions

### Python

- **Python >= 3.11** required
- **Virtual environments** — all repos use `.venv/` (gitignored)
- **Dependency management** — use `pip` with `requirements.txt` or `uv` with `pyproject.toml`
- **No global installs** — never `pip install` outside a virtualenv for project use

### Node.js

- **Node.js >= 18** required (`"engines": { "node": ">=18.0.0" }` in `package.json`)
- **ES modules** — all repos use `"type": "module"` in `package.json`
- **Native fetch** — use Node 18+ built-in `fetch`; do not add `node-fetch` or `axios` unless justified

---

## 2. Secrets Management

Applies to **all** repos regardless of language.

- **1Password** is the single source of truth for secrets
- **`.env.1p.template`** — committed file with `op://` references (safe to track)
- **`.env.example`** — committed file with placeholder values for developers without 1Password access
- **`.env`** — gitignored, never committed; generated at runtime or by `op run`
- **Runtime injection**: `op run --env-file=.env.1p.template -- <command>`
- `OP_SERVICE_ACCOUNT_TOKEN` must be in the shell environment, never in `.env`
- Vault naming convention: `BTAI-CC-{AgentName}` (Title Case)

### Node.js additional

- **`.envrc`** — gitignored `direnv` file containing `dotenv`; auto-loads `.env` when entering the directory
- All `npm run` scripts must use `op run` wrapping — never `node --env-file=.env`

---

## 3. Linting

### Python — Ruff

All Python repos must include linting configuration in `pyproject.toml`:

```toml
[tool.ruff]
target-version = "py311"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "W", "UP"]

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
```

Run via `ruff check .` and `ruff format .`.

### Node.js — Biome

All Node.js repos must include a `biome.json` configuration:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.6/schema.json",
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noConsole": { "level": "off", "options": { "allow": ["log"] } }
      }
    }
  },
  "files": {
    "includes": ["**", "!**/*.json", "!**/state/data"]
  }
}
```

Run via `npx @biomejs/biome@2.4.6` or as a `devDependency`.

**Exception:** Next.js projects may use **ESLint** with `eslint-config-next` instead of Biome, since Next.js provides deep built-in ESLint integration. These projects must still have a pre-commit hook running their linter.

---

## 4. Pre-Commit Hooks

All repos must include a `.pre-commit-config.yaml`. Install hooks via `pre-commit install` after cloning.

### Python

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.15.1
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format

  - repo: local
    hooks:
      - id: no-dot-env
        name: Block .env commits
        entry: >
          bash -c 'for f in "$@"; do case "$f" in .env|.env.local|.env.bak|.env.backup) echo "BLOCKED: $f"; exit 1;; esac; done' --
        language: system
        files: '\.env'
```

### Node.js (Biome)

```yaml
repos:
  - repo: https://github.com/biomejs/pre-commit
    rev: "v2.4.6"
    hooks:
      - id: biome-check
        additional_dependencies: ["@biomejs/biome@2.4.6"]

  - repo: local
    hooks:
      - id: no-dot-env
        name: Block .env commits
        entry: >
          bash -c 'for f in "$@"; do case "$f" in .env|.env.local|.env.bak|.env.backup) echo "BLOCKED: $f"; exit 1;; esac; done' --
        language: system
        files: '\.env'
```

### Node.js (ESLint — Next.js projects)

```yaml
repos:
  - repo: local
    hooks:
      - id: eslint
        name: ESLint
        entry: npx next lint --max-warnings 0
        language: system
        types: [file]
        files: '\.(js|jsx|ts|tsx)$'

      - id: no-dot-env
        name: Block .env commits
        entry: >
          bash -c 'for f in "$@"; do case "$f" in .env|.env.local|.env.bak|.env.backup) echo "BLOCKED: $f"; exit 1;; esac; done' --
        language: system
        files: '\.env'
```

---

## 5. Repo Structure Requirements

Every agent repo must contain at minimum:

| File | Python | Node.js | Purpose |
|---|---|---|---|
| `CLAUDE.md` | required | required | Agent identity, commands, architecture |
| `STANDARDS.md` | required | required | This file (exact copy from canonical source) |
| `pyproject.toml` | required | — | With `[tool.ruff]` config |
| `package.json` | — | required | With `"type": "module"` and `"engines"` |
| `biome.json` | — | required* | Linter/formatter config |
| `.gitignore` | required | required | See section 7 |
| `.env.1p.template` | required | required | 1Password secret references |
| `.env.example` | required | required | Placeholder values |

*Next.js projects using ESLint may omit `biome.json` if they have an ESLint config.

---

## 6. CLAUDE.md Requirements

Every `CLAUDE.md` must:

- Define the agent's identity and purpose
- List all available commands
- Document architecture and project structure
- Reference `STANDARDS.md` (required for drift detection)

---

## 7. .gitignore Minimums

### Shared (all repos)

```
.env
.env.local
.env.bak
.env.backup
.mcp.json
.DS_Store
*.log
```

### Python additional

```
.venv/
__pycache__/
*.pyc
```

### Node.js additional

```
node_modules/
.envrc
```

---

## 8. Dependency Policy

### Python

- Minimize dependencies — prefer Python standard library
- Pin exact versions in `requirements.txt` for reproducible installs
- Use `pyproject.toml` for project metadata and tool config
- Audit dependencies periodically
- Never install packages globally for project use

### Node.js

- Minimize dependencies — prefer Node.js built-ins
- Pin major versions in `package.json` (use `^` for minor/patch)
- No `package-lock.json` in gitignore — it must be committed for reproducible builds
- Audit dependencies periodically: `npm audit`
- Never install packages globally for project use

---

## 9. Git Conventions

Applies to **all** repos regardless of language.

- Default branch: `main`
- Commit messages: imperative mood, concise subject line
- No force-pushing to `main`
- Pre-commit hooks must be installed and active

---

## 10. Compliance Verification

HerculeanOlympus checks the following automatically:

### All repos

| Check | Severity |
|---|---|
| `STANDARDS.md` missing | warning |
| `STANDARDS.md` hash drift from canonical | warning |
| `CLAUDE.md` missing `STANDARDS.md` reference | warning |
| Linter config missing | warning |
| Pre-commit config missing | warning |
| `.env` committed to git | critical |
| Hardcoded secrets in docker-compose | critical |
| `.env.1p.template` missing | warning |
| `.env.1p.template` has no `op://` references | warning |
| Raw secrets in `.env` files | critical |
| `.gitignore` incomplete | warning |

### Python-specific

| Check | Severity |
|---|---|
| `pyproject.toml` missing `[tool.ruff]` | warning |

### Node.js-specific

| Check | Severity |
|---|---|
| Build enforcement disabled (TypeScript) | critical |
| Scripts missing `op run` wrapping | warning |
| `package.json` missing `type: module` | warning |
| `package.json` missing `engines.node` | warning |
| Lockfile not committed | warning |
