# Project Overview For Agents

## Purpose

This repository implements a database-oriented CLI assistant that combines:

- CLI command dispatch
- provider-aware LLM calls
- tool-based agent execution
- database introspection and SQL execution
- explicit write confirmation

The repo is intentionally small and layered. Avoid turning it into a framework-heavy design unless the user asks for that.

## Core User Modes

- `init`
  Configure LLM provider, embedding provider, base URL, model, and database connection.
- `config show`
  Show masked stored config and, when it can be resolved, the masked runtime config after shell env and project `.env` defaults are applied. This is also the primary diagnostic command when a database-backed command cannot start because the active database target is incomplete.
- `config embedding update`
  Reopen only the embedding API configuration flow.
- `schema`
  Inspect tables or a single table definition.
- `catalog`
  Refresh or search the local schema catalog used by the agent.
- `sql`
  Execute one SQL statement directly.
- `explain`
  Get an execution plan for SQL.
- `ask`
  One-shot natural-language request.
- `chat`
  Interactive REPL with the same tool-backed agent loop and per-target scoped instruction loading.

## Product Expectations

- Behave like an operator-friendly CLI.
- Be explicit about risks.
- Do not silently run destructive SQL.
- Prefer inspect -> reason -> execute over guessing.
- Keep prompts and tool descriptions clear and operational.
- Keep one-shot terminal output compact; richer execution traces belong in chat mode.
- Terminal result tables stay compact by using fixed-width cells with truncation instead of multiline wrapping.

## Constraints

- Node.js 20+
- TypeScript strict mode
- `pnpm`
- No browser UI
- No multi-statement execution
- No background job system

## Important Persistence Points

- Local config file: `~/.db-chat-cli/config.json`
  - stores LLM settings
  - stores embedding API settings
  - stores multiple database host configs
  - stores multiple database names under each host
  - stores the active host/database selection
  - allows switching directly to an already-stored database entry even when the server is temporarily unreachable
  - does not store runtime SQL access presets
- Project default env file: `./.env`
  - provides repo-local default values for supported runtime env settings, including `DBCHAT_*` variables and provider-specific API-key aliases such as `OPENAI_API_KEY`
  - sits below shell env and stored config in precedence
- Local schema catalog directory: `~/.db-chat-cli/schema-catalog/`
  - stores one `catalog.json` snapshot per physical database target in nested directories grouped by dialect, host-port, and database
  - stores table-level hashes, an instruction fingerprint, local search documents, and optional embedding vectors built during explicit catalog sync
- Scoped instruction directory: `~/.db-chat-cli/agents/`
  - supports root-level `AGENTS.md`, host-level `AGENTS.md`, database-level `AGENTS.md`, and per-table `tables/<table>.md`
  - uses `database > host > global` precedence for both runtime prompts and catalog rebuilds
  - auto-creates missing files as blank files when a database target is selected or switched successfully, while leaving existing files untouched
  - supports optional `Shared`, `Runtime`, and `Catalog` sections so prompt-time and catalog-time views can differ without duplicating whole files
- In-memory state only for:
  - current plan
  - latest query result cache used for follow-up inspection and export
  - latest explain cache used for focused follow-up inspection
  - compressed conversation memory
  - a small recent raw-turn window

There is no persistent conversation history yet.
