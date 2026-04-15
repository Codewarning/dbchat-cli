# Safety And Testing For Agents

## SQL Safety Rules

These rules are core product behavior, not optional implementation details.

- only one SQL statement may run at a time
- mutating SQL must require explicit approval
- the active database access preset must allow the SQL operation before approval is requested
- DML, DDL, and unclassified SQL must offer `Approve Once`, `Approve All For Turn`, and `Reject`
- the current built-in access presets are `read-only`, `select+insert+update`, `select+insert+update+delete`, and `select+insert+update+delete+ddl`
- `UPDATE` or `DELETE` without `WHERE` should warn
- exporting must stay inside the current working directory
- export path checks must reject symlink or junction escapes outside the current working directory
- PostgreSQL SSL must verify the server certificate when SSL is enabled
- schema-catalog workflows that send schema metadata or search text to remote LLM or embedding APIs must require explicit confirmation first
- the model should inspect schema before making assumptions

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

### If you changed config

- `init` still prompts for provider and database values
- `init` still prompts for embedding provider, base URL, model, and API key values
- database switching still prompts for the runtime operation-access preset, defaulting to `read-only`
- stored database configs still omit any persisted operation-access field
- password prompts still mask typed secrets in interactive terminals
- `config show` still masks secrets
- env overrides still resolve correctly and take precedence over stored config

### If you changed agent or tools

- tool schemas match the shared tool spec handlers
- plan state still updates correctly
- resolved plans do not remain active in the next turn after every step reaches a terminal status such as `completed`, `skipped`, or `cancelled`
- latest query result still flows into export
- cached query rows still respect `app.resultRowLimit`
- schema-catalog search still returns useful table candidates before `describe_table`
- destructive schema operations can verify live table names from the active database connection when the current table set matters
- `catalog sync` and `catalog search` still require explicit confirmation before sending schema metadata or search text to remote APIs
- successful schema-changing SQL still leaves a clear manual `catalog sync` follow-up notice instead of auto-refreshing the schema catalog

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
