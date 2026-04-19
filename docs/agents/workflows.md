# Workflows For Agents

## Workflow 1: Direct SQL Command

Entry:

- `dbchat sql "<sql>"`

Path:

1. load config
   if the runtime database config is incomplete, stop with a concise user-facing error that points to `dbchat init`, `dbchat config db ...`, or `dbchat config show` instead of surfacing raw schema-validation details
2. create db adapter
3. test connection
4. run SQL safety checks and classify the statement as read-only, DML, DDL, or unclassified
5. if the statement is DML, DDL, or unclassified, ask for approval with `Approve Once`, `Approve All For Turn`, or `Reject`
6. execute SQL through the matching runtime path
7. if the SQL result has rows or fields, generate an HTML table artifact under `~/.db-chat-cli/tmp/` and also write a matching CSV file for the same cached rows
8. if the executed SQL changed tracked table structure, keep the SQL success result and tell the user to run `dbchat catalog sync` manually before relying on updated schema-catalog search results
9. print either the full inline preview or a bounded terminal preview plus the HTML and CSV file URLs, depending on `app.tableRendering`

Key files:

- `src/commands/register.ts`
- `src/db/safety.ts`
- `src/commands/shared.ts`

## Workflow 2: Natural-Language Ask

Entry:

- `dbchat ask "<prompt>"`

Path:

1. load config and db runtime
2. create `AgentSession`
3. start a new turn and preserve only a small recent raw-turn window
4. load the active target's layered instruction files from `~/.db-chat-cli/agents/` and build the runtime view with precedence `database > host > global`
5. classify the request into a rough context shape such as fresh query, fresh schema, fresh explain, or follow-up/export work
6. build request-aware prompt context from only the relevant compressed memory blocks and a bounded raw-turn window
7. call LLM
8. if tools are requested, execute them through the shared tool spec registry
9. initialize the local schema catalog when the database runtime is entered if it is missing; when embeddings are enabled, that rebuild also sends merged schema metadata to the configured embedding API
10. reuse the stored local schema catalog on later schema-tool calls instead of refreshing it automatically
11. search the local schema catalog snapshot before describing individual tables when possible
12. before destructive schema operations that depend on current tables, verify the live table list from the active database connection instead of relying only on the local schema catalog
13. when the model emits a read-only `SELECT` for visible rows without an explicit row bound, the `run_sql` tool can append a default `LIMIT` derived from `app.previewRowLimit`, unless the request clearly asks for all rows, a full export, or another exact row count
14. when a cached result is small enough under `app.tableRendering`, `render_last_result` can produce inline plain-text table output; larger cached results still mention the generated HTML and CSV artifacts for the full cached table slice, and default terminal previews stay bounded even when the executed SQL used a larger `LIMIT` or the tool was asked for a larger cached slice
15. append compact tool results and, when one payload is still too large for normal history, replace it with a persisted-output marker instead of inlining the full content
16. let the model inspect cached result, explain, archived turn, or persisted-output artifacts through `inspect_last_result`, `inspect_last_explain`, and `inspect_history_entry` when it needs more detail without rerunning work; keep `inspect_last_result` inline so exact row values remain available in the active turn
17. if cached SQL rows were rendered through `render_last_result` but the model returns only prose in the final answer, append those rendered table pages before finishing the turn
18. when a separate rendered result preview is already available, strip assistant-authored Markdown or plain-text result tables from the final reply so the terminal does not show duplicated row tables
19. match the user's language in the final assistant reply unless the user explicitly asks for another language
20. continue until the LLM returns a final answer, then archive older completed turns into compressed memory according to the configured recent-raw-turn limit
21. stop tool execution early when the configured per-turn tool-call cap is reached and force the model to conclude from the information already gathered
22. clear the active plan when every plan step reaches a terminal status such as `completed`, `skipped`, or `cancelled`, so resolved plans do not bleed into the next turn

Key files:

- `src/agent/session.ts`
- `src/agent/prompts.ts`
- `src/tools/definitions.ts`
- `src/tools/registry.ts`
- `src/tools/specs.ts`

## Workflow 3: Interactive Chat

Entry:

- `dbchat chat`

Path:

1. start REPL
2. keep a single `AgentSession`
3. allow slash commands such as `/help`, `/schema`, `/plan`, `/clear`, `/host ...`, `/database ...`
4. in the Ink REPL, show slash-command autocomplete suggestions while the user types `/...`
5. in the Ink REPL, show an `@` live database picker for the current host while the user types `@...`
6. when `/clear` runs, clear both the in-memory conversation state and the visible REPL screen
7. route normal text into the same agent loop used by `ask`, with older turns compressed as the chat grows
8. before each new agent turn, reload the active target's runtime instruction layers so prompt changes on disk are picked up without restarting the REPL
9. when a database target is entered successfully, create any missing scoped `AGENTS.md` files and missing `tables/*.md` files as blank files without overwriting existing content
10. when the active database target changes inside the REPL, prompt for the runtime SQL access preset, reload the runtime adapter, preserve any saved schema for the selected database when known, persist that database as the next default selection for the stored host when possible, and clear the conversation state with a user-facing notice
11. initialize the local schema catalog when the current database target is entered if it is missing; when embeddings are enabled, that rebuild also sends merged schema metadata to the configured embedding API
12. reuse the stored local schema catalog on later schema-tool calls instead of refreshing it automatically
13. tool-driven read-only `SELECT` previews can receive a default `LIMIT` when the model omits one and the request does not clearly ask for a full result or export
14. cached result tables follow the shared `app.tableRendering` rules, rendering inline only when small enough and otherwise showing a bounded terminal preview plus HTML and CSV file URLs, with terminal previews staying compact by default unless the user explicitly asks to see all returned rows or another exact visible row count
15. keep oversized tool payloads out of normal chat history by persisting them behind markers and retrieving them on demand through `inspect_history_entry`
16. if cached SQL rows were rendered through `render_last_result`, keep those plain-text table pages in the final assistant answer instead of letting the reply collapse into prose only
17. clear the active plan when every plan step reaches a terminal status such as `completed`, `skipped`, or `cancelled`, so old resolved plans are not shown again on the next turn
18. keep the session open until the user enters `/exit` or interrupts the process

Key files:

- `src/repl/chat-ink.ts`
- `src/repl/chat-readline.ts`
- `src/repl/chat-app.tsx`
- `src/repl/slash-commands.ts`
- `src/repl/runtime.ts`
- `src/agent/session.ts`

## Workflow 4: Schema Catalog Sync

Entry:

- `dbchat catalog sync`
- database-entry-time initialization when `dbchat ask` or `dbchat chat` enters a target that has no compatible local catalog yet

Path:

1. load config and db runtime
2. if embeddings are enabled for this run, the rebuild sends merged schema metadata to the configured remote embedding API
3. load the active target's layered instruction files from `~/.db-chat-cli/agents/` and build the catalog view with precedence `database > host > global`
4. fetch all table schemas from the active database
5. compute deterministic table hashes and searchable summaries
6. create any missing scoped `tables/<table>.md` files for the currently visible live tables without overwriting existing table markdown files
7. attach a clipped instruction-context summary plus an instruction fingerprint to the rebuilt snapshot
8. build table-level, column-level, and relation-level local search documents from the merged schema facts and instruction context
9. reuse unchanged embedding vectors when both the schema hash and embedding text still match
10. optionally embed the enriched table documents with the configured remote embedding API
11. write the refreshed catalog under `~/.db-chat-cli/schema-catalog/` in nested directories grouped by dialect, host-port, database, and a final schema scope segment (`<schema>` for PostgreSQL, `public` for MySQL)

Key files:

- `src/schema/catalog.ts`
- `src/schema/catalog-sync.ts`
- `src/schema/catalog-search.ts`
- `src/schema/catalog-storage.ts`
- `src/schema/catalog-enrichment.ts`
- `src/embedding/client.ts`
- `src/db/adapter.ts`
- `src/db/postgres.ts`
- `src/db/mysql.ts`

## Workflow 5: Provider Resolution

Provider resolution is config-driven:

1. load stored config
2. load project `.env` defaults from the current working directory when present
3. resolve the active stored host/database selection
4. apply runtime environment variable overrides
5. resolve the LLM provider preset, API format, default base URL, model, and API key
6. resolve the embedding provider preset, default base URL, model, and API key
7. resolve the final runtime database target

Priority order is: shell env > stored config > project `.env` > built-in defaults.

Key file:

- `src/config/store.ts`

## Workflow 6: Result Export

Export is not a standalone command yet. It is exposed through the agent tool surface.

Path:

1. latest query result is stored in memory
2. the LLM can call `inspect_last_result` first to read a bounded cached result slice without rerunning SQL
3. the LLM can call `inspect_last_explain` to read a focused cached EXPLAIN preview without rerunning EXPLAIN
4. the LLM reuses the HTML/CSV artifact URLs from the latest result summary when the user wants the cached rows as browser-view HTML or CSV
5. if the user explicitly wants a JSON file, the LLM can call `export_last_result`
6. explicit export writes JSON into `~/.db-chat-cli/tmp/`
7. final answer returns the generated artifact path or file URL

Key files:

- `src/tools/registry.ts`
- `src/tools/specs.ts`
- `src/export/csv.ts`

## Workflow 7: Database Config Management

Entry:

- `dbchat config db <subcommand>`

Path:

1. load normalized stored config
2. resolve a target host config or database entry
3. for `use-database`, switch directly when the requested database name is already stored under the selected host; otherwise query the target host for live database names before selecting or validating one
4. for successful `use-host` or `use-database` selection changes, create any missing scoped `AGENTS.md` files and missing `tables/*.md` files as blank files without overwriting existing content
5. when a new host config reuses an existing host label for a different port, adjust the stored host name to keep it unique, typically by appending the port
6. add, update, remove, or switch the active selection
7. save the normalized config back to disk

Key files:

- `src/commands/register.ts`
- `src/config/database-hosts.ts`
- `src/config/store.ts`

## Workflow 8: Embedding Config Management

Entry:

- `dbchat config embedding update`

Path:

1. load normalized stored config
2. reopen the interactive embedding provider prompt flow
3. save provider, base URL, API key, and model back to the stored config

Key files:

- `src/commands/register.ts`
- `src/commands/embedding-config.ts`
- `src/commands/embedding-config-helpers.ts`
- `src/config/store.ts`
