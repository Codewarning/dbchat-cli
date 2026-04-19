# dbchat-cli Design

This document describes the current implementation, not an aspirational future design.

## Goals

`dbchat-cli` is a database-focused CLI assistant for PostgreSQL and MySQL. It combines:

- natural-language database workflows
- direct single-statement SQL execution
- schema inspection
- EXPLAIN and optimization workflows
- local schema-catalog retrieval
- bounded result export

The product goal is to feel like a database-oriented coding assistant while keeping SQL execution explicit, inspectable, and safe by default.

## Top-Level Commands

Current CLI entrypoints:

```bash
dbchat init
dbchat chat
dbchat ask "<prompt>"
dbchat sql "<sql>"
dbchat explain "<sql>"
dbchat schema
dbchat schema --count
dbchat schema --table orders
dbchat catalog sync
dbchat catalog search "<query>"
dbchat config show
dbchat config embedding update
dbchat config db <subcommand>
```

The interactive REPL also supports local slash commands:

- `/help`
- `/schema [table] [--count]`
- `/plan`
- `/clear`
- `/host ...`
- `/database ...`
- `/exit`

## Configuration Model

Persistent config is stored at:

```text
~/.db-chat-cli/config.json
```

Project-local defaults can also come from:

```text
./.env
```

Config precedence is:

1. shell environment variables
2. stored config in `~/.db-chat-cli/config.json`
3. project `.env` defaults from the current working directory
4. built-in code defaults

Important details:

- `.env` is parsed by `src/config/env-file.ts`; the project does not depend on `dotenv`
- provider-specific key aliases are supported, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and `DASHSCOPE_API_KEY`
- `config show` prints both the masked stored config and the masked resolved runtime config when the latter can be built
- runtime SQL access level is not persisted in config; it is chosen during database-switch flows and defaults to `read-only`

## Scoped Instruction Model

Optional scoped instruction files live under:

```text
~/.db-chat-cli/agents/
  AGENTS.md
  <host-port>/AGENTS.md
  <host-port>/<database>/AGENTS.md
  <host-port>/<database>/tables/<table>.md
```

Behavior:

- precedence is `database > host > global`
- if a file has no reserved sections, the whole file applies to both runtime prompts and catalog rebuilds
- if reserved sections are present, the runtime uses `Shared + Runtime` while catalog rebuilds use `Shared + Catalog`
- path segments are normalized into readable filesystem-safe lowercase fragments
- when a database target is selected or switched successfully, missing `AGENTS.md` and `tables/*.md` files are created as blank files and existing files are left untouched
- runtime instructions are reloaded before each `ask` or `chat` turn so edits on disk take effect without restarting the CLI

## Layering

The codebase is intentionally layered and relatively small.

### CLI layer

Files:

- `src/index.ts`
- `src/commands/*`
- `src/repl/*`

Responsibilities:

- register Commander commands
- run interactive setup and config management flows
- create runtime dependencies
- render terminal output
- prompt for confirmations and selection menus

### Service layer

Files:

- `src/services/sql.ts`
- `src/services/schema-catalog.ts`

Responsibilities:

- keep handlers and tool executors thin
- centralize SQL execution, artifact generation, and schema-catalog staleness notices
- centralize schema-catalog initialization, refresh, and search orchestration

### Agent layer

Files:

- `src/agent/session.ts`
- `src/agent/session-policy.ts`
- `src/agent/message-builder.ts`
- `src/agent/tool-execution.ts`
- `src/agent/memory.ts`
- `src/agent/prompts.ts`
- `src/agent/plan.ts`

Responsibilities:

- maintain the minimal agent loop
- keep compressed conversation memory
- maintain the active plan
- track cached result and explain artifacts
- load and inject the active target's scoped runtime instructions as a separate system message
- limit tool-call fan-out per turn

### Tool layer

Files:

- `src/tools/builtins/*`
- `src/tools/definitions.ts`
- `src/tools/specs.ts`
- `src/tools/registry.ts`

Current model-visible tool surface includes:

- `update_plan`
- `inspect_history_entry`
- `get_schema_summary`
- `list_live_tables`
- `search_schema_catalog`
- `describe_table`
- `run_sql`
- `inspect_last_result`
- `search_last_result`
- `render_last_result`
- `explain_sql`
- `inspect_last_explain`
- `export_last_result`

### Database layer

Files:

- `src/db/adapter.ts`
- `src/db/factory.ts`
- `src/db/postgres.ts`
- `src/db/mysql.ts`
- `src/db/safety.ts`
- `src/db/operation-access.ts`

Responsibilities:

- lazy-load the correct database driver
- connect and introspect the schema
- execute single statements
- run EXPLAIN
- classify risky SQL

### Schema catalog layer

Files:

- `src/schema/catalog-sync.ts`
- `src/schema/catalog-search.ts`
- `src/schema/catalog-storage.ts`
- `src/schema/catalog-documents.ts`
- `src/schema/catalog-bm25.ts`
- `src/schema/catalog-merge.ts`

Responsibilities:

- persist a local schema snapshot per database target
- load and fingerprint the active target's scoped catalog instructions during rebuilds
- build BM25-friendly table, column, and relation documents
- carry a clipped instruction-context summary into table documents and optional embedding text
- optionally store per-table embedding vectors when an embedding API is configured

## Schema Catalog Design

Catalog data is stored under:

```text
PostgreSQL: ~/.db-chat-cli/schema-catalog/postgres/<host-port>/<database>/<schema>/
MySQL:      ~/.db-chat-cli/schema-catalog/mysql/<host-port>/<database>/public/
```

Each scope contains:

- `catalog.json`

Behavior:

- `catalog sync` is the explicit refresh path
- `ask`, `chat`, and live database switches reuse an existing compatible catalog when present
- if the catalog is missing or incompatible on database entry, the CLI can initialize it then
- `catalog sync` also reads the matching `global/host/database` scoped instruction layers and stores an instruction fingerprint in `catalog.json`
- local table documents carry a clipped instruction-context summary so search and optional embeddings can reuse the same business hints
- `catalog sync` also backfills missing `tables/<table>.md` files for currently visible tables without overwriting existing files
- `catalog search` is local BM25 retrieval and does not send the search text to a remote API
- embeddings are optional and only affect sync-time enrichment and ranking signals
- scoped instruction files are always processed locally
- when embeddings are enabled, catalog rebuilds send merged schema metadata to the configured remote embedding API without a separate confirmation prompt

## SQL Safety Model

These rules are core product invariants:

- only one SQL statement may execute at a time
- mutating SQL requires explicit approval
- statements outside the active runtime access policy are blocked before approval
- `UPDATE` and `DELETE` without `WHERE` warn
- schema-changing SQL does not auto-refresh the catalog; the CLI tells the user to run `dbchat catalog sync`

Runtime access presets are:

- `read-only`
- `select+insert+update`
- `select+insert+update+delete`
- `select+insert+update+delete+ddl`

## Result Rendering And Export

Read-only query behavior is intentionally bounded:

- `app.resultRowLimit` caps the cached row slice kept in memory
- `app.previewRowLimit` is the default LIMIT that can be auto-applied to unbounded read-only queries in agent-driven workflows
- `app.tempArtifactRetentionDays` controls how many days generated files under `~/.db-chat-cli/tmp/` are kept before startup cleanup removes them; the default is 3 and `.env` can override it through `DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS`
- `app.tableRendering.inlineRowLimit` and `inlineColumnLimit` decide whether a table can render inline in the terminal
- larger cached results render a bounded terminal preview and generate HTML plus matching CSV artifacts

Artifact outputs live under:

```text
~/.db-chat-cli/tmp/
```

The explicit export tool now writes JSON only. CSV is produced automatically together with HTML result artifacts.

## Chat Runtime

`chat` prefers the Ink UI in TTY environments and falls back to a readline REPL elsewhere.

The chat runtime:

- keeps a single `AgentSession`
- supports slash-command autocomplete
- supports `@`-driven live database switching
- reloads the active database target's scoped runtime instructions before each new turn
- clears the active conversation when the logical database target changes
- preserves cached result, explain, and history inspection workflows across follow-up turns where appropriate

## Non-Goals

Unless explicitly requested, the project does not aim to provide:

- multi-statement execution
- persistent chat history
- GUI or web UI
- framework-heavy abstractions
- automatic destructive SQL execution
- background migration or job orchestration
