# Workflows For Agents

## Workflow 1: Direct SQL Command

Entry:

- `dbchat sql "<sql>"`

Path:

1. load config
2. create db adapter
3. test connection
4. run SQL safety checks and classify the statement as read-only, DML, DDL, or unclassified
5. if the statement is DML, DDL, or unclassified, ask for approval with `Approve Once`, `Approve All For Turn`, or `Reject`
6. execute SQL through the matching runtime path
7. if the executed SQL changed tracked table structure, ask for explicit approval before sending schema metadata to remote APIs for a catalog refresh, then refresh or skip the refresh accordingly
8. print preview

Key files:

- `src/commands/register.ts`
- `src/db/safety.ts`
- `src/commands/shared.ts`

## Workflow 2: Natural-Language Ask

Entry:

- `dbchat ask "<prompt>"`

Path:

1. load config and db runtime
2. ask for explicit approval before sending prompts or database-derived context to remote APIs
3. create `AgentSession`
4. start a new turn and preserve only a small recent raw-turn window
5. classify the request into a rough context shape such as fresh query, fresh schema, fresh explain, or follow-up/export work
6. build request-aware prompt context from only the relevant compressed memory blocks and a bounded raw-turn window
7. call LLM
8. if tools are requested, execute them through the shared tool spec registry
9. lazily load or refresh the schema catalog only when a schema-catalog tool is actually used
10. search the semantic schema catalog before describing individual tables when possible
11. before destructive schema operations that depend on current tables, verify the live table list from the active database connection instead of relying only on the local schema catalog
12. append compact tool results and let the model inspect cached result or explain artifacts through `inspect_last_result` and `inspect_last_explain` when it needs more detail without rerunning work
13. continue until the LLM returns a final answer, then archive older completed turns into compressed memory as needed
14. clear the active plan when every plan step reaches a terminal status such as `completed`, `skipped`, or `cancelled`, so resolved plans do not bleed into the next turn

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
2. ask for explicit approval before sending prompts or database-derived context to remote APIs
3. keep a single `AgentSession`
4. allow slash commands such as `/help`, `/schema`, `/plan`, `/clear`, `/host ...`, `/database ...`
5. in the Ink REPL, show slash-command autocomplete suggestions while the user types `/...`
6. in the Ink REPL, show an `@` live database picker for the current host while the user types `@...`
7. when `/clear` runs, clear both the in-memory conversation state and the visible REPL screen
8. route normal text into the same agent loop used by `ask`, with older turns compressed as the chat grows
9. when the active database target changes inside the REPL, prompt for the runtime SQL access preset, reload the runtime adapter, preserve any saved schema for the selected database when known, persist that database as the next default selection for the stored host when possible, and clear the conversation state with a user-facing notice
10. lazily load or refresh the schema catalog only when a schema-catalog tool is actually used
11. clear the active plan when every plan step reaches a terminal status such as `completed`, `skipped`, or `cancelled`, so old resolved plans are not shown again on the next turn
12. keep the session open until the user enters `/exit` or interrupts the process

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
- on-demand compatibility and freshness checks when a schema-catalog tool is actually used by `dbchat ask` or `dbchat chat`

Path:

1. load config and db runtime
2. ask for explicit approval before sending schema metadata to remote APIs
3. fetch all table schemas from the active database
4. compute deterministic table hashes and searchable summaries
5. reuse unchanged table index entries when the schema hash matches
6. batch new or changed tables into a small number of LLM requests for descriptions and tags
7. embed the enriched table documents with the configured remote embedding API
8. write the refreshed catalog under `~/.db-chat-cli/schema-catalog/` in nested directories grouped by dialect, host-port, and database

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
2. resolve the active stored host/database selection
3. merge environment variable overrides
4. resolve the LLM provider preset, API format, default base URL, model, and API key
5. resolve the embedding provider preset, default base URL, model, and API key
6. resolve the final runtime database target

Key file:

- `src/config/store.ts`

## Workflow 6: Result Export

Export is not a standalone command yet. It is exposed through the agent tool surface.

Path:

1. latest query result is stored in memory
2. the LLM can call `inspect_last_result` first to read a bounded cached result slice without rerunning SQL
3. the LLM can call `inspect_last_explain` to read a focused cached EXPLAIN preview without rerunning EXPLAIN
4. the LLM calls `export_last_result` when the user wants a file
5. export module writes JSON or CSV
6. final answer returns export path

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
3. for `use-database`, query the target host for live database names before selecting one
4. add, update, remove, or switch the active selection
5. save the normalized config back to disk

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
