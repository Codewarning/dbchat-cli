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

The interactive setup now lets you choose an LLM provider preset:

- OpenAI GPT
- Claude / Anthropic
- DeepSeek
- Custom

For each preset, the CLI pre-fills the default `base URL` and `model`, and you can override both manually.
The interactive setup now uses arrow-key menus for provider/dialect/yes-no prompts and for common values such as ports, schemas, row limits, base URLs, and models. You can still choose a custom value when needed.
Database host and database entries are stored without any persisted SQL access preset.
The active runtime access level is selected when you switch databases inside `chat`, and startup defaults to `Read only`.

The database setup now stores:

- one active host config
- one active database under that host
- any number of additional host configs and database names managed later through `config db` commands

Configuration is stored in:

```text
~/.db-chat-cli/config.json
```

When an embedding-backed workflow first needs it, the CLI ensures a local GGUF embedding model exists under:

```text
~/.db-chat-cli/models/
```

It downloads the model automatically when missing and shows a progress bar in the terminal.
If a download fails, the CLI deletes the temporary file and retries from zero on the next attempt.
Inside the Ink chat UI, the same download now appears in the `Active tasks` panel with live byte progress instead of writing directly to stdout.
The download uses `EMBEDDING_MODEL_URL` when it is set.
Otherwise the CLI tries this primary source first:

```text
https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf
```

If the primary source fails, the CLI retries with:

```text
https://hf-mirror.com/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-q8_0.gguf
```

When the local schema catalog is refreshed, the CLI uses the configured LLM together with that local embedding model to enrich every table with:

- an English description
- search tags
- a persisted embedding vector

Unchanged tables reuse the existing semantic index, and the index powers fast table retrieval in `dbchat catalog search`, `ask`, and `chat`.

`dbchat catalog sync` therefore now depends on a working LLM configuration, the local embedding model, and database connectivity.
The catalog is stored locally under `~/.db-chat-cli/schema-catalog/` in nested directories grouped by dialect, host-port, and database, with one JSON file per schema target.
The on-disk directory name remains `~/.db-chat-cli/` for compatibility with existing local installs.
`ask` and `chat` no longer force a schema-catalog refresh before the session starts.
The catalog is checked lazily when a schema-catalog tool is actually used, and only then rebuilt if it is missing, stale, or incompatible with the current embedding model.

## Environment Variables

You can also override settings via environment variables:

- `DBCHAT_LLM_PROVIDER`
- `DBCHAT_LLM_API_FORMAT`
- `DBCHAT_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `DBCHAT_LLM_BASE_URL`
- `DBCHAT_LLM_MODEL`
- `EMBEDDING_MODEL_URL`
- `DBCHAT_RESULT_ROW_LIMIT`
- `DBCHAT_PREVIEW_ROW_LIMIT`
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

The interactive chat session stays open after each LLM reply. It only exits when you enter `/exit` or terminate the process yourself.
When `chat` runs in a TTY terminal, it now uses a React Ink interface with:

- an initial Codex-style welcome splash at the top of the transcript, with later chat appended below it
- a bordered runtime info panel showing the current model and active database target
- a plain `>` composer with an inline tip instead of a boxed input field
- slash-command autocomplete with a dropdown picker while typing `/...` in the Ink chat UI
- live database switching with a dropdown picker while typing `@...` in the Ink chat UI
- a scrolling activity timeline for user input, tool/log output, and final answers
- inline loading panels for long-running tasks
- modal-style confirmation, input, and selection prompts for SQL approval and `/host` or `/database` config flows

If the local Ink runtime cannot initialize in the current environment, `chat` automatically falls back to the plain readline REPL so the command remains usable.

Inside the REPL, you can also manage stored hosts and databases with `/host ...` and `/database ...`.
When you switch databases through `/database use`, `/host use`, or the `@` picker, the CLI prompts for the database operation access level to apply for the current runtime only. That access selection is not persisted, and the default is always `Read only`.
After a successful database switch on a stored host, the selected database becomes the default active database for the next `chat` session on that host.
When the selected database already exists in stored config, the `@` picker now reuses its saved schema instead of falling back to the current database schema heuristically.
If the active database target changes inside the REPL, the CLI reconnects, clears the current conversation, and clears the terminal output so old context is not mixed into the new database session.
If the switch keeps the same active database target and only reloads connection details or access policy, the current conversation is preserved.
The `/clear` slash command now clears both the in-memory conversation state and the current terminal chat screen.
Completed, skipped, or cancelled execution plans are cleared from active session context at the end of a turn, so old resolved plans are not repeated at the top of the next request.

### One-Shot Natural-Language Requests

```bash
node dist/index.js ask "Show the order volume trend for the last 7 days"
node dist/index.js ask "Analyze this SQL for performance and suggest improvements"
```

### Execute SQL Directly

```bash
node dist/index.js sql "select * from users limit 10"
```

Read-only SQL executes immediately.
DML, DDL, and unclassified SQL that are allowed by the active database access level require approval with three choices: `Approve Once`, `Approve All For Turn`, or `Reject`.
If the current database access level does not allow the statement, the CLI rejects it before opening the approval prompt.
If a successful statement changes tracked table structure, such as `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, or `RENAME TABLE`, the CLI now refreshes the local schema catalog automatically after execution.

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
When you inspect a specific table, the CLI now prefers a `CREATE TABLE ...` style DDL preview instead of a prose column list.
For MySQL, this prefers the database's native `SHOW CREATE TABLE` output.
For PostgreSQL, the CLI currently shows a reconstructed DDL assembled from system catalogs, because PostgreSQL does not store the original `CREATE TABLE` text verbatim.

### Build Or Refresh The Local Schema Catalog

```bash
node dist/index.js catalog sync
node dist/index.js catalog search "order items"
```

### Show Current Configuration

```bash
node dist/index.js config show
```

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

For `update/remove/use` commands, the name argument is optional. If omitted, the CLI opens an arrow-key selection menu.
For `config db use-database`, the selection menu queries the target host for live database names and saves the selected database locally when it was not already stored.
Stored database entries now keep only connection identity such as host, database name, and optional schema.
Runtime SQL access is selected at switch time inside `chat` and is not persisted to the config file.
If `--host` is omitted for database commands, the CLI also lets you select a host interactively when needed.
The same host/database management operations are also available inside `chat` mode through slash commands.
When `chat` is running in a TTY terminal, these slash-command selections also use the same arrow-key menus.

## Testing

When using the development script, pass the CLI command after `--`.

```bash
pnpm run dev -- init
pnpm run dev -- config show
pnpm run dev -- sql "select 1"
pnpm run dev -- schema
pnpm run dev -- catalog sync
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

6. Test the LLM tool loop

```bash
pnpm run dev -- ask "show me the top 10 rows from users"
```

7. Test the interactive chat session

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

### Debugger Message Note

If your terminal shows messages such as `Debugger attached.` or `Waiting for the debugger to disconnect...`, that usually comes from your terminal or editor environment rather than from the CLI itself. In that case, continue testing with explicit subcommands as shown above.

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

In the Ink chat UI, typing `/` opens slash-command suggestions. Use Up/Down to choose a command and `Tab` or `Enter` to autocomplete it.
Typing `@` opens the live database picker for the current host. Use Up/Down to choose a database and `Tab` or `Enter` to switch to it.
`/schema` lists table names only by default; use `/schema --count` when you explicitly want live row counts.

## Current Implementation Notes

- SQL execution is split into `read-only`, `DML`, `DDL`, and `unclassified` runtime paths.
- The active runtime access preset is always one of `read-only`, `select+insert+update`, `select+insert+update+delete`, or `select+insert+update+delete+ddl`, but it is not stored in the config file.
- Statements outside the active database access level are blocked before the approval gate.
- Allowed DML, DDL, and unclassified SQL go through an explicit approval gate with `Approve Once`, `Approve All For Turn`, and `Reject`.
- Only a single SQL statement can be executed at a time.
- The CLI now loads or rebuilds the local schema catalog lazily when a schema-catalog tool needs it, instead of forcing that work before every `ask` or `chat` session.
- The model can search the local schema catalog before loading a specific table definition.
- For destructive schema operations that depend on the current table set, the model can verify live table names directly from the active database connection instead of relying only on the local schema catalog.
- Query results can be exported to `JSON` or `CSV`.
- `app.resultRowLimit` limits how many rows stay cached in memory after a query, and exports of the last result operate on that cached slice.
- Database drivers are loaded lazily so that non-database commands can start without unnecessary driver initialization.
- The CLI supports both OpenAI-compatible tool calling and Anthropic tool calling.
- Database config supports multiple host configs and multiple database names under each host, with active host/database switching through CLI commands and live database discovery during `use-database`.
- Non-interactive terminal commands keep progress output compact by default, while `chat` keeps richer interactive feedback.
- Chat sessions compress older turns into structured summaries and retain only a small recent raw window, so token usage stays bounded during longer conversations.
- Tool results sent back to the model are compact payloads rather than full raw JSON results.

## Next Steps

- SQLite / SQL Server
- session history and resume
- stronger SQL linting and heuristics
- finer-grained approval policies
