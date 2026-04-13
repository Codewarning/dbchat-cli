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
  Show masked config.
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
  Interactive REPL with the same tool-backed agent loop.

## Product Expectations

- Behave like an operator-friendly CLI.
- Be explicit about risks.
- Do not silently run destructive SQL.
- Prefer inspect -> reason -> execute over guessing.
- Keep prompts and tool descriptions clear and operational.
- Keep one-shot terminal output compact; richer execution traces belong in chat mode.

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
  - does not store runtime SQL access presets
- Local schema catalog directory: `~/.db-chat-cli/schema-catalog/`
  - stores one schema snapshot per physical database target in nested directories grouped by dialect, host-port, and database
  - stores table-level hashes, LLM-generated descriptions/tags, and embedding vectors used before live introspection
- In-memory state only for:
  - current plan
  - latest query result
  - compressed conversation memory
  - a small recent raw-turn window

There is no persistent conversation history yet.
