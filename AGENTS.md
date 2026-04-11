# AGENTS.md

This file is the primary machine-oriented guide for coding agents working in this repository.

## Mission

`dbchat-cli` is a Node.js + TypeScript CLI that lets a user interact with PostgreSQL or MySQL through:

- natural-language requests
- direct SQL execution
- schema inspection
- SQL explain / optimization workflows
- result export

The product goal is to feel like a database-focused `codex cli` / `claude code` style assistant, but with strong execution controls for SQL.

## Source Of Truth

- Edit source files under `src/`.
- Treat `dist/` as generated output.
- Do not hand-edit `dist/` unless the user explicitly asks for generated-file changes.
- Main docs for humans live in `README.md` and `docs/`.

## Required Invariants

- User-visible CLI text must be in English.
- All mutating SQL must require explicit user confirmation before execution.
- Only a single SQL statement may be executed at a time.
- Prefer schema inspection over guessing table or column names.
- Complex tasks should create or update a plan before executing multiple steps.
- Database drivers are intentionally lazy-loaded so non-database commands can start without loading both drivers.

## Key Commands

- Install: `pnpm install`
- Build: `pnpm build`
- Typecheck: `pnpm typecheck`
- Dev entry: `pnpm run dev -- <command>`
- Built CLI entry: `node dist/index.js <command>`

## Repo Map

- `src/index.ts`
  CLI entrypoint.
- `src/commands/register.ts`
  Commander command registration only.
- `src/commands/handlers.ts`
  Top-level CLI command handlers for ask/sql/schema/chat/catalog/config commands.
- `src/commands/init.ts`
  Interactive initialization workflow for LLM and database setup.
- `src/commands/database-config.ts`
  Stored host/database config mutations and switch flows.
- `src/commands/database-config-helpers.ts`
  Shared config validation, prompting, and selection helpers reused by `init` and config commands.
- `src/commands/shared.ts`
  Shared runtime bootstrapping, config loading, db adapter creation, and printing helpers.
- `src/services/sql.ts`
  Shared SQL and EXPLAIN orchestration used by CLI handlers and LLM tools.
- `src/services/schema-catalog.ts`
  Shared schema-catalog refresh, ensure-ready, and search orchestration used by CLI handlers and LLM tools.
- `src/repl/chat-ink.ts`
  Ink render bootstrap for the rich interactive chat mode.
- `src/repl/chat-readline.ts`
  Readline fallback REPL used when the Ink runtime cannot initialize in the current environment.
- `src/repl/chat-app.tsx`
  React Ink chat layout shell that renders the REPL using the extracted chat controller state.
- `src/repl/chat-controller.ts`
  Chat REPL controller hook that owns prompt bridging, session actions, slash-command dispatch, and database-switch flows.
- `src/repl/slash-commands.ts`
  Slash-command parsing plus local `/schema`, `/host`, and `/database` handlers.
- `src/repl/runtime.ts`
  Live REPL runtime switching and adapter/session reload logic after config changes.
- `src/agent/session.ts`
  Minimal agent loop coordinator that owns session state and drives the LLM/tool round-trips.
- `src/agent/session-policy.ts`
  Request-intent classification, response redirection heuristics, and final assistant-output normalization.
- `src/agent/message-builder.ts`
  Agent message assembly from system policy, compressed memory, and bounded raw history.
- `src/agent/tool-execution.ts`
  Shared tool-call execution and session-memory write-back helpers used by `AgentSession`.
- `src/agent/prompts.ts`
  System and context prompt construction.
- `src/tools/definitions.ts`
  Tool schemas exposed to the LLM, re-exported from the shared tool spec registry.
- `src/tools/specs.ts`
  Single source of truth for tool schemas, validators, and executors.
- `src/tools/registry.ts`
  Tool execution lookup layer, including SQL confirmation logic through the shared spec registry.
- `src/schema/catalog.ts`
  Stable catalog entrypoint that re-exports sync, search, and storage helpers.
- `src/schema/catalog-sync.ts`
  Schema catalog rebuild pipeline, index reuse, and sync result calculation.
- `src/schema/catalog-search.ts`
  Semantic and keyword catalog search plus summary/table lookup helpers.
- `src/schema/catalog-storage.ts`
  Catalog path resolution and on-disk load/save helpers.
- `src/llm/client.ts`
  Provider-aware LLM client for OpenAI-compatible and Anthropic-compatible APIs.
- `src/config/*`
  Config defaults, schema validation, local config resolution.
- `src/db/*`
  DB adapter abstraction, PostgreSQL/MySQL implementations, SQL safety checks.
- `src/export/csv.ts`
  JSON / CSV export helpers.
- `src/ui/prompts.ts`
  Terminal prompts built on Node readline.
- `src/ui/text-table.ts`
  Plain-text monospace table rendering for Ink-friendly terminal output.
- `src/ui/text-formatters.ts`
  Shared plain-text renderers for schema and stored database config output.

## LLM Provider Model

Supported provider presets:

- `openai`
- `anthropic`
- `deepseek`
- `custom`

Supported API formats:

- `openai`
- `anthropic`

Important:

- OpenAI-compatible providers use `/chat/completions`.
- Anthropic-compatible providers use `/messages`.
- The project uses raw `fetch`, not the official vendor SDKs.
- Provider config is resolved in `src/config/store.ts`.

## Database Safety Model

Safe-by-default behavior is central to this repository.

- Read-only operations: `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`
- Mutating operations: `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`
- Multi-statement SQL is rejected.
- `UPDATE` and `DELETE` without `WHERE` produce warnings.
- Export paths must remain within the current working directory.

If you change SQL execution behavior, review `src/db/safety.ts` and `src/tools/registry.ts` together.

## Working Rules For Agents

- Prefer making focused changes in `src/` and only rebuild afterward.
- Preserve the current layering:
  - CLI / command layer
  - agent loop
  - tool registry
  - db adapter
  - export / config / prompt helpers
- If adding a new capability, first decide whether it belongs in:
  - a new CLI command
  - a new LLM tool
  - a new db adapter method
  - a helper module
- Do not bypass the confirmation gate for mutating SQL.
- Do not add multi-statement execution unless the user explicitly requests a redesign.

## What To Read Next

- `README.md`
- `docs/agents/project-overview.md`
- `docs/agents/architecture.md`
- `docs/agents/workflows.md`
- `docs/agents/safety-and-testing.md`
- `docs/architecture-diagrams.md`

## When Making Changes

Update docs if the change affects any of:

- command names or CLI behavior
- provider support
- config shape
- SQL safety behavior
- agent loop behavior
- architecture diagrams

If source code changes, run at least:

- `pnpm build`

If behavior changes materially, also update:

- `README.md`
- one or more files in `docs/agents/`
