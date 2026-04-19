# Safety And Testing For Agents

## SQL Safety Rules

These rules are core product behavior, not optional implementation details.

- only one SQL statement may run at a time
- mutating SQL must require explicit approval
- the active database access preset must allow the SQL operation before approval is requested
- DML, DDL, and unclassified SQL must offer `Approve Once`, `Approve All For Turn`, and `Reject`
- the current built-in access presets are `read-only`, `select+insert+update`, `select+insert+update+delete`, and `select+insert+update+delete+ddl`
- `UPDATE` or `DELETE` without `WHERE` should warn
- generated exports and HTML result views must stay under `~/.db-chat-cli/tmp/`
- PostgreSQL SSL must verify the server certificate when SSL is enabled
- schema-catalog search stays local by default; only catalog rebuilds may send merged schema metadata to a remote embedding API when embeddings are enabled
- the model should inspect schema before making assumptions
- agent-driven read-only preview queries should stay bounded unless the user clearly asks for all rows, a full export, or another exact row count

Key enforcement points:

- `src/db/safety.ts`
- `src/tools/registry.ts`
- `src/tools/specs.ts`

## Testing Commands

Primary validation command:

- `pnpm build`
- `pnpm test`

Development usage:

- `pnpm run dev -- init`
- `pnpm run dev -- config show`
- `pnpm run dev -- sql "select 1"`
- `pnpm run dev -- schema`
- `pnpm run dev -- catalog sync`
- `pnpm run dev -- ask "show the tables in this database"`
- `pnpm run dev -- chat`

Built CLI usage:

- `node dist/index.js init`
- `node dist/index.js config show`
- `node dist/index.js sql "select 1"`

## What To Check After Changing Code

### If you changed CLI or commands

- help output still works
- command descriptions are still English
- `pnpm run dev -- <command>` still behaves correctly
- database-backed commands still turn incomplete runtime database config into concise actionable errors instead of raw validation dumps

### If you changed config

- `init` still prompts for provider and database values
- `init` still prompts for embedding provider, base URL, model, and API key values
- database switching still prompts for the runtime operation-access preset, defaulting to `read-only`
- stored database configs still omit any persisted operation-access field
- `config db use-database <stored-name>` still works without live discovery when that database is already saved locally under the selected host
- scoped instruction path resolution still maps to `~/.db-chat-cli/agents/<host-port>/...` with filesystem-safe lowercase fragments
- password prompts still mask typed secrets in interactive terminals
- `config show` still masks secrets in both the stored-config view and the resolved-runtime view
- `config show` remains the primary diagnostic command for incomplete runtime config, and its masked stored section still prints even when the resolved runtime section is unavailable
- shell env overrides still resolve correctly and take precedence over stored config
- project `.env` defaults load from the current working directory without overriding stored config
- `.env` support for `DBCHAT_FORCE_HYPERLINK` still affects terminal link rendering even though that flag is not stored in `AppConfig`

### If you changed agent or tools

- tool schemas match the shared tool spec handlers
- plan state still updates correctly
- resolved plans do not remain active in the next turn after every step reaches a terminal status such as `completed`, `skipped`, or `cancelled`
- latest query result still flows into export
- cached query rows still respect `app.resultRowLimit`
- temp artifacts still stay under `~/.db-chat-cli/tmp/` and startup cleanup still removes artifacts older than `app.tempArtifactRetentionDays`, which now defaults to 3 days
- final answers still include plain-text table output when cached rows were already rendered through `render_last_result`
- wide or tall result tables still stay readable by using dynamically sized terminal columns with truncation for overlong values, plus HTML and CSV artifact URLs when the preview must stay bounded
- assistant-authored result tables should be removed when a separate program-rendered preview block is already being shown, so the terminal keeps one authoritative row rendering
- `chat` and `ask` still keep program-rendered `render_last_result` table pages available in terminal output, and the Ink chat UI renders those table blocks through the UI layer
- artifact links in terminal output still stay readable as plain text and become OSC 8 clickable links only when the active terminal supports them
- schema-catalog search still returns useful table candidates before `describe_table`
- destructive schema operations can verify live table names from the active database connection when the current table set matters
- runtime-scoped instruction files still reload before each `ask` or `chat` turn and are injected as a separate system message instead of being mixed into the built-in safety prompt
- catalog rebuilds still send schema metadata to remote embedding APIs only when embeddings are enabled, without a separate confirmation prompt
- `catalog search` still stays local by default and does not send the search text to remote APIs
- local scoped instruction files still stay local-only and do not trigger remote API calls by themselves
- successful schema-changing SQL still leaves a clear manual `catalog sync` follow-up notice instead of auto-refreshing the schema catalog
- the agent loop still respects the configured LLM-round ceiling through `app.contextCompression.maxAgentIterations`

### If you changed DB execution behavior

- read-only SQL still runs without approval
- disallowed SQL is blocked before approval based on the active database access preset
- mutating SQL still asks for approval
- mutating CTE SQL still asks for approval
- choosing `Approve All For Turn` suppresses later SQL prompts only for the current request
- successful `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and similar table-shape changes keep the SQL success result and mark the local schema catalog as manually refreshable through `catalog sync`
- multi-statement SQL is still rejected

### If you changed schema introspection or catalog behavior

- `catalog sync` still writes a refreshed snapshot for the active database
- `catalog sync` still records the active scoped-instruction fingerprint in the refreshed snapshot
- table-level catalog documents still carry the clipped instruction-context summary used for local retrieval and optional embeddings
- `catalog sync` still creates missing `tables/<table>.md` files for visible live tables without overwriting existing table markdown files
- `catalog sync` still requires a working embedding API config and rebuilds when the embedding configuration changes
- `ask`, `chat`, and live database switches still initialize a compatible local schema catalog when the database target is entered
- schema-catalog tools still reuse the stored local schema catalog without refreshing it automatically on later tool calls
- `describe_table` still returns accurate column definitions

## Non-Goals To Preserve

Unless explicitly requested by the user, do not introduce:

- automatic execution of destructive SQL
- persistent chat history
- GUI/web UI
- background migrations or async workers
- framework-heavy abstractions for a small CLI
