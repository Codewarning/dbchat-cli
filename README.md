# dbchat-cli

English | [简体中文](./README.zh-CN.md)

`dbchat-cli` is a database-focused command-line assistant built with `Node.js + TypeScript + pnpm`.

It supports natural-language workflows for:

- querying data
- generating SQL
- analyzing query results
- exporting query results
- analyzing SQL execution plans
- executing allowed mutating SQL after explicit approval, subject to the active database access level

Complex tasks are expected to create a plan first and execute step by step.

## Design

- Detailed design document: [docs/design.md](./docs/design.md)
- Architecture diagrams: [docs/architecture-diagrams.md](./docs/architecture-diagrams.md)
- npm publishing workflow: [docs/npm-publish.md](./docs/npm-publish.md)

## Stack

- Node.js 20+
- TypeScript
- pnpm
- React Ink terminal UI for interactive chat mode
- OpenAI-compatible chat completions
- Anthropic messages API
- PostgreSQL / MySQL

## Install

```bash
pnpm install
pnpm build
```

## Global Install

Build the project first:

```bash
pnpm build
```

Then install the CLI globally from the current project:

```bash
pnpm link --global
```

After that, you can run:

```bash
dbchat --help
```

If you change the source code later, rebuild and relink:

```bash
pnpm build
pnpm link --global
```

To uninstall the global link:

```bash
pnpm unlink --global dbchat-cli
```

An alternative is:

```bash
pnpm add -g .
```

For local iterative development, `pnpm link --global` is usually the better option.

## Initialize Configuration

```bash
node dist/index.js init
```

The interactive setup lets you choose an LLM provider preset:

- OpenAI GPT
- Claude / Anthropic
- DeepSeek
- Custom

For each preset, the CLI pre-fills the default `base URL` and `model`, and you can override both manually.
The setup also uses arrow-key menus for provider, dialect, yes/no prompts, and common values such as ports, schemas, row limits, base URLs, and models.
Database host prompts also use dialect-specific defaults. For example, PostgreSQL defaults to port `5432` and username `postgres`, while MySQL defaults to port `3306` and username `root`.

Database host and database entries are stored without any persisted SQL access preset.
The active runtime access level is selected when you switch databases inside `chat`, and startup defaults to `Read only`.

Configuration is stored in:

```text
~/.db-chat-cli/config.json
```

Project-level defaults can also live in:

```text
./.env
```

The repository now includes a root `.env` file with every supported config-related environment variable.
It is treated as a workspace default layer, not as a hard override.
Priority order is:

- shell environment variables
- `~/.db-chat-cli/config.json`
- `./.env`
- built-in code defaults

Use `dbchat config show` to inspect both the stored file values and the final resolved runtime config after shell env and `.env` defaults are applied.
It is also the quickest way to diagnose why a database-backed command such as `schema`, `sql`, `explain`, `ask`, `chat`, or `catalog search` cannot start.

Advanced session context controls live under `app.contextCompression` in that config file.
They are optional and default to conservative values, so existing installs keep working without migration.
Table preview controls live under `app.tableRendering`:

- `inlineRowLimit`
- `inlineColumnLimit`
- `previewRowLimit`

Temp artifact cleanup also uses `app.tempArtifactRetentionDays`.
The default is 3 days and it can be overridden from `.env` with `DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS`.

Generated HTML result views and agent exports are stored under the config directory:

```text
~/.db-chat-cli/tmp/
```

On each CLI startup, files older than the configured retention window are deleted automatically.
The default retention is 3 days.

## Scoped Instructions

Optional scoped instruction files live under:

```text
~/.db-chat-cli/agents/
  AGENTS.md
  <host-port>/AGENTS.md
  <host-port>/<database>/AGENTS.md
  <host-port>/<database>/tables/<table>.md
```

When multiple layers exist for the active target, precedence is:

- `database > host > global`

If a file contains no reserved sections, the whole file applies to both runtime prompts and catalog sync.
If it uses reserved headings, `dbchat` reads:

- `## Shared` + `## Runtime` for `ask` and `chat`
- `## Shared` + `## Catalog` for `catalog sync`

Path fragments are normalized into readable filesystem-safe lowercase segments.
When a database target is selected or switched successfully, `dbchat` initializes this directory tree automatically: missing `AGENTS.md` files and missing `tables/*.md` files are created as blank files, while existing files are left untouched.

## Schema Catalog

The local schema catalog is stored under:

```text
PostgreSQL: ~/.db-chat-cli/schema-catalog/postgres/<host-port>/<database>/<schema>/
MySQL:      ~/.db-chat-cli/schema-catalog/mysql/<host-port>/<database>/public/
```

Each database target now uses readable path segments instead of hashed directory names.
A catalog scope contains:

- `catalog.json`
  the local schema catalog snapshot and its search documents

`dbchat catalog sync` reads live table schemas from the active database and rebuilds the local catalog snapshot.
It also loads the matching scoped instruction files for the active target and stores an instruction fingerprint in the catalog snapshot.
It always builds local table-level, column-level, and relation-level search documents for BM25-style retrieval, and table documents now carry a clipped instruction-context summary so local search and optional embeddings can reuse the same business hints.

If an embedding API key is configured, sync also stores optional per-table embedding vectors as an additional recall signal that can be reused on later syncs.
Embeddings are an enhancement, not a requirement for local schema search.

`dbchat catalog search`, `ask`, and `chat` search this local catalog first.
Search queries stay local in the default workflow and do not call the embedding API.
Scoped instruction files are loaded locally and do not trigger remote API calls by themselves.
When embeddings are enabled, catalog rebuilds send merged schema metadata to the configured embedding API during `catalog sync` and first-entry catalog initialization.

When `ask`, `chat`, or a live database switch enters a database target, the CLI reuses the existing local schema catalog when it is already present.
If the catalog is missing, the CLI can initialize it at database-entry time.
After database entry, schema-catalog tools reuse the existing local catalog and do not refresh it automatically on later tool calls.
`dbchat catalog search` uses the stored local snapshot and does not require a live database connection after the catalog has already been built.
It still needs a resolved active database target so the CLI knows which local snapshot directory to open.

## Environment Variables

You can also configure settings via environment variables.
When you run the CLI from this repository, the root `.env` file is loaded automatically as a default-value source.
Edit that file if you want to tune the repo's local defaults, including terminal preview size.
Shell-exported environment variables still win over both `.env` and `~/.db-chat-cli/config.json`.
`dbchat config show` prints the same resolution order and the resolved runtime config, which makes it the easiest way to verify whether a `.env` value is active.

- `DBCHAT_LLM_PROVIDER`
- `DBCHAT_LLM_API_FORMAT`
- `DBCHAT_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `DBCHAT_LLM_BASE_URL`
- `DBCHAT_LLM_MODEL`
- `DBCHAT_EMBEDDING_PROVIDER`
- `DBCHAT_EMBEDDING_API_KEY`
- `DBCHAT_EMBEDDING_BASE_URL`
- `DBCHAT_EMBEDDING_MODEL`
- `DASHSCOPE_API_KEY`
- `DBCHAT_RESULT_ROW_LIMIT`
- `DBCHAT_PREVIEW_ROW_LIMIT`
- `DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS`
- `DBCHAT_INLINE_TABLE_ROW_LIMIT`
- `DBCHAT_INLINE_TABLE_COLUMN_LIMIT`
- `DBCHAT_PREVIEW_TABLE_ROW_LIMIT`
- `DBCHAT_FORCE_HYPERLINK`
- `DBCHAT_CONTEXT_RECENT_RAW_TURNS`
- `DBCHAT_CONTEXT_RAW_HISTORY_CHARS`
- `DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS`
- `DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS`
- `DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN`
- `DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS`
- `DBCHAT_DB_DIALECT`
- `DBCHAT_DB_HOST`
- `DBCHAT_DB_PORT`
- `DBCHAT_DB_NAME`
- `DBCHAT_DB_USER`
- `DBCHAT_DB_PASSWORD`
- `DBCHAT_DB_SCHEMA`
- `DBCHAT_DB_SSL`

## Usage

### Interactive Mode

```bash
node dist/index.js chat
```

The interactive chat session stays open after each LLM reply.
It only exits when you enter `/exit` or terminate the process yourself.

When `chat` runs in a TTY terminal, it uses a React Ink interface with:

- an initial Codex-style welcome splash at the top of the transcript
- a bordered runtime info panel showing the current model and active database target
- a plain `>` composer with an inline tip
- slash-command autocomplete while typing `/...`
- live database switching while typing `@...`
- a scrolling activity timeline for user input, tool output, and final answers
- inline loading panels for long-running tasks
- modal-style confirmation, input, and selection prompts for SQL approval and `/host` or `/database` flows

If the Ink runtime cannot initialize in the current environment, `chat` falls back to the plain readline REPL.

Inside the REPL, you can also manage stored hosts and databases with `/host ...` and `/database ...`.
When you switch databases through `/database use`, `/host use`, or the `@` picker, the CLI prompts for the database operation access level to apply for the current runtime only.
That access selection is not persisted, and the default is always `Read only`.
Each agent turn also reloads the runtime-scoped instruction layers for the active database target before the next LLM request is built.

### One-Shot Natural-Language Requests

```bash
node dist/index.js ask "Show the order volume trend for the last 7 days"
node dist/index.js ask "Analyze this SQL for performance and suggest improvements"
```

For `ask` and `chat`, when the model generates a read-only `SELECT` that should show rows but omits an explicit row bound, the CLI now adds a default `LIMIT` based on `app.previewRowLimit`.
This keeps terminal previews compact and avoids large accidental result pages unless the user clearly asks for all rows, a full export, or another exact row count.
When a cached result fits within `app.tableRendering.inlineRowLimit` and `app.tableRendering.inlineColumnLimit`, the CLI renders it directly in the terminal.
Larger cached results now show only the first `app.tableRendering.previewRowLimit` rows in the terminal and include a generated HTML file URL for full browser viewing.
That HTML generation also writes a matching CSV file for the same cached rows, and the terminal preview prints that CSV file URL below the HTML URL.

### Execute SQL Directly

```bash
node dist/index.js sql "select * from users limit 10"
```

Read-only SQL executes immediately.
DML, DDL, and unclassified SQL that are allowed by the active database access level require approval with three choices: `Approve Once`, `Approve All For Turn`, or `Reject`.
If the current database access level does not allow the statement, the CLI rejects it before opening the approval prompt.
Read-only result previews follow the same table policy as `ask` and `chat`: small tables render inline, while larger tables include HTML and matching CSV file URLs under `~/.db-chat-cli/tmp/`.
Inline terminal previews size each column from the visible header and row content, while still truncating overlong values instead of wrapping them across multiple terminal lines.
Even when the executed SQL or an internal cached-result render request used a larger `LIMIT`, terminal previews stay bounded unless the user explicitly asked to see all returned rows or another exact visible row count.
If a successful statement changes tracked table structure, such as `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, or `RENAME TABLE`, the CLI keeps the SQL success result and tells you to run `dbchat catalog sync` manually before relying on updated schema-catalog search results.

### Show an Execution Plan

```bash
node dist/index.js explain "select * from orders where created_at >= now() - interval '7 day'"
```

### Inspect Schema

```bash
node dist/index.js schema
node dist/index.js schema --count
node dist/index.js schema --table orders
```

By default, schema summary output lists only table names.
If you want live row counts, pass `--count`; that triggers a real-time `COUNT(*)` query against each table before rendering the summary.

When you inspect a specific table, the CLI prefers a `CREATE TABLE ...` style DDL preview instead of a prose column list.
For MySQL, this prefers the database's native `SHOW CREATE TABLE` output.
For PostgreSQL, the CLI currently shows a reconstructed DDL assembled from system catalogs, because PostgreSQL does not store the original `CREATE TABLE` text verbatim.

### Build Or Refresh The Local Schema Catalog

```bash
node dist/index.js catalog sync
node dist/index.js catalog search "user table"
```

`catalog sync` is the manual way to rebuild the local schema catalog after schema-changing SQL.
It rebuilds the local snapshot directly from live database schema metadata and the active target's scoped `global/host/database` instruction layers.
During that rebuild, any missing `tables/<table>.md` files for currently visible tables are also created as blank files, while existing table markdown files are left untouched.

`catalog search` runs against the merged local catalog with BM25-style retrieval and does not call the embedding API.
If multiple candidate tables are close in score, the agent asks the user to clarify which table they mean before relying on one exact table for SQL generation or execution.
If embeddings are configured, catalog rebuilds send merged schema metadata to the external embedding API without a separate confirmation prompt.

### Show Current Configuration

```bash
node dist/index.js config show
node dist/index.js config embedding update
```

`config show` prints two masked sections:

- the stored config file contents
- the resolved runtime config after shell env and project `.env` defaults are applied

If the runtime config is incomplete, the stored section still prints and the resolved section explains why it could not be built.
Database-backed commands surface the same condition as a concise actionable error instead of dumping raw schema-validation output.

### Manage Stored Database Hosts And Databases

```bash
node dist/index.js config db list
node dist/index.js config db add-host local-pg
node dist/index.js config db update-host
node dist/index.js config db remove-host
node dist/index.js config db use-host

node dist/index.js config db add-database app_db --host local-pg
node dist/index.js config db update-database --host local-pg
node dist/index.js config db remove-database --host local-pg
node dist/index.js config db use-database --host local-pg
```

For `update`, `remove`, and `use` commands, the name argument is optional.
If omitted, the CLI opens an arrow-key selection menu.
For `config db use-database`, an explicit database name that is already stored under the selected host switches locally without requiring a live connection.
When the database name is omitted, or when you target a database that is not already stored locally, the CLI queries the target host for live database names and saves the selected database locally when it was not already stored.
If you reuse the same host-config name for the same server on a different port, `dbchat` automatically adjusts the stored name to keep it unique, typically by appending `-<port>`.

## Testing

When using the development script, pass the CLI command after `--`.

```bash
pnpm run dev -- init
pnpm run dev -- config show
pnpm run dev -- sql "select 1"
pnpm run dev -- schema
pnpm run dev -- catalog sync
pnpm run dev -- catalog search "user table"
pnpm run dev -- ask "show the tables in this database"
pnpm run dev -- chat
```

If you run only `pnpm run dev` without an extra command, the CLI will print help and exit.

You can also run the lightweight regression checks with:

```bash
pnpm test
```

### Recommended Smoke Test Order

1. Initialize configuration

```bash
pnpm run dev -- init
```

2. Verify the saved configuration

```bash
pnpm run dev -- config show
```

3. Test direct database connectivity

```bash
pnpm run dev -- sql "select 1"
```

4. Test schema inspection

```bash
pnpm run dev -- schema
```

5. Build the local schema catalog

```bash
pnpm run dev -- catalog sync
```

6. Validate local schema search

```bash
pnpm run dev -- catalog search "user table"
```

7. Test the LLM tool loop

```bash
pnpm run dev -- ask "show me the top 10 rows from users"
```

8. Test the interactive chat session

```bash
pnpm run dev -- chat
```

### Test a Mutating Statement

The following command should trigger a confirmation prompt before execution:

```bash
pnpm run dev -- sql "create table test_cli(id int)"
```

### Test the Built Output

You can also validate the compiled CLI directly:

```bash
pnpm build
node dist/index.js init
node dist/index.js config show
node dist/index.js sql "select 1"
```

## REPL Slash Commands

- `/help`
- `/schema [table] [--count]`
- `/plan`
- `/clear` clears the current session and screen
- `/host [list]`
- `/host add [name]`
- `/host update [name]`
- `/host remove [name]`
- `/host use [name]`
- `/database [list]`
- `/database add [name] [--host <hostName>]`
- `/database update [name] [--host <hostName>]`
- `/database remove [name] [--host <hostName>]`
- `/database use [name] [--host <hostName>]`
- `/exit`

In the Ink chat UI, typing `/` opens slash-command suggestions.
Use Up/Down to choose a command and `Tab` or `Enter` to autocomplete it.
Typing `@` opens the live database picker for the current host.
Use Up/Down to choose a database and `Tab` or `Enter` to switch to it.
`/schema` lists table names only by default; use `/schema --count` when you explicitly want live row counts.

## Current Implementation Notes

- SQL execution is split into `read-only`, `DML`, `DDL`, and `unclassified` runtime paths.
- The active runtime access preset is always one of `read-only`, `select+insert+update`, `select+insert+update+delete`, or `select+insert+update+delete+ddl`, but it is not stored in the config file.
- Statements outside the active database access level are blocked before the approval gate.
- Allowed DML, DDL, and unclassified SQL go through an explicit approval gate with `Approve Once`, `Approve All For Turn`, and `Reject`.
- Only a single SQL statement can be executed at a time.
- The CLI initializes the local schema catalog only when a database target is entered, reuses the stored snapshot afterward, and leaves later refreshes to the explicit `catalog sync` command.
- The schema catalog stores one readable `catalog.json` snapshot per target and rebuilds it directly from live schema metadata.
- `catalog search` runs against the stored local snapshot and does not require a live database connection after the snapshot exists.
- Local schema search is BM25-style lexical retrieval over those merged documents; optional embeddings are an enhancement produced during sync, not a requirement for search.
- `catalog search` stays local by default and does not send the search query to a remote API.
- The model can search the local schema catalog before loading a specific table definition.
- For destructive schema operations that depend on the current table set, the model can verify live table names directly from the active database connection instead of relying only on the local schema catalog.
- Query results automatically generate an HTML view and a matching CSV file for the same cached rows when a browser-view artifact is created.
- `app.resultRowLimit` limits how many rows stay cached in memory after a query, and exports of the last result operate on that cached slice.
- In `ask` and `chat`, tool-driven read-only `SELECT` queries that omit an explicit row bound are auto-capped with a default `LIMIT` derived from `app.previewRowLimit`, unless the request clearly implies a full result or export.
- `app.tableRendering.inlineRowLimit` and `app.tableRendering.inlineColumnLimit` decide when a cached result can render fully in the terminal.
- Larger cached results show the first `app.tableRendering.previewRowLimit` rows in the terminal and also generate an HTML view plus a matching CSV file under `~/.db-chat-cli/tmp/`.
- Internal `render_last_result` calls keep the compact preview by default even when a larger cached row count is available; expanded terminal pages are reserved for explicit user row-count requests.
- Terminal artifact lines use ANSI-friendly text styling, and supported terminals receive OSC 8 clickable links for HTML/CSV result artifacts without changing the model-visible plain-text content.
- In chat mode, the final assistant reply no longer includes artifact file paths. When cached HTML/CSV artifacts exist, the CLI shows them as a separate UI block so Ink can highlight them without teaching the model to echo local paths.
- The explicit agent export tool now writes `JSON` only; CSV is produced automatically together with the HTML result artifact.
- The temp directory is cleaned on CLI startup by deleting generated artifacts older than `app.tempArtifactRetentionDays`, which defaults to 3 days and can be overridden through `.env`.
- `app.contextCompression.recentRawTurns` controls how many full recent turns stay in raw prompt history before older turns are archived into summaries.
- `app.contextCompression.rawHistoryChars` caps the raw-history character budget that can be packed into one LLM request.
- Tool results that exceed `app.contextCompression.largeToolOutputChars` are no longer inlined into model-visible history. The session stores the full payload out of band, leaves behind a compact marker with `persistedOutputId`, and the model can fetch the omitted content later through `inspect_history_entry`.
- `render_last_result` and `inspect_last_result` stay inline even when their payloads are large, so the model can finish result-oriented turns without rereading the same cached slice from persisted history markers.
- `app.contextCompression.maxToolCallsPerTurn` caps how many tool calls one user turn may execute before the model is forced to conclude with the information already gathered.
- `app.contextCompression.maxAgentIterations` caps how many LLM response rounds one user turn may take before the agent aborts the loop.
- If cached SQL rows were rendered through `render_last_result`, the CLI keeps those program-rendered table pages available in the terminal output instead of dropping back to prose-only summaries.
- In `ask` and `chat`, the assistant now defaults to the user's language unless the user explicitly asks for another one.
- When a separate `Result Preview` block is already shown, the final assistant reply strips assistant-authored Markdown or plain-text result tables instead of duplicating rows in prose output.
- Database drivers are loaded lazily so that non-database commands can start without unnecessary driver initialization.
- The CLI supports both OpenAI-compatible tool calling and Anthropic tool calling.
- Database config supports multiple host configs and multiple database names under each host, with active host/database switching through CLI commands and live database discovery during `use-database`.
- Non-interactive terminal commands keep progress output compact by default, while `chat` keeps richer interactive feedback.
- Chat sessions compress older turns into structured summaries, keep only a small recent raw window, and pack prior context into each LLM request only when the current prompt appears to need it.

## Next Steps

- SQLite / SQL Server
- session history and resume
- stronger SQL linting and heuristics
- finer-grained approval policies
