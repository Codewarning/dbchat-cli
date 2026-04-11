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
7. if the executed SQL changed tracked table structure, refresh the local schema catalog before continuing
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
2. create `AgentSession`
3. start a new turn and preserve only a small recent raw-turn window
4. build prompt context from plan, latest result, compressed memory, and recent raw turns
5. call LLM
6. if tools are requested, execute them through the shared tool spec registry
7. lazily load or refresh the schema catalog only when a schema-catalog tool is actually used
8. search the semantic schema catalog before describing individual tables when possible
9. before destructive schema operations that depend on current tables, verify the live table list from the active database connection instead of relying only on the local schema catalog
10. append compact tool results
11. continue until the LLM returns a final answer, then archive older completed turns into compressed memory as needed
12. clear the active plan when every plan step reaches a terminal status such as `completed`, `skipped`, or `cancelled`, so resolved plans do not bleed into the next turn

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
8. when the active database target changes inside the REPL, prompt for the runtime SQL access preset, reload the runtime adapter, preserve any saved schema for the selected database when known, persist that database as the next default selection for the stored host when possible, and clear the conversation state with a user-facing notice
9. lazily load or refresh the schema catalog only when a schema-catalog tool is actually used
10. clear the active plan when every plan step reaches a terminal status such as `completed`, `skipped`, or `cancelled`, so old resolved plans are not shown again on the next turn
11. keep the session open until the user enters `/exit` or interrupts the process

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
- automatic compatibility and freshness check before `dbchat ask` and `dbchat chat`

Path:

1. load config and db runtime
2. fetch all table schemas from the active database
3. compute deterministic table hashes and searchable summaries
4. reuse unchanged table index entries when the schema hash matches
5. batch new or changed tables into a small number of LLM requests for descriptions and tags
6. embed the enriched table documents with the local GGUF embedding model
7. write the refreshed catalog under `~/.db-chat-cli/schema-catalog/` in nested directories grouped by dialect, host-port, and database

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
4. resolve provider preset
5. resolve API format
6. resolve default base URL and model
7. resolve the provider-specific API key source
8. resolve the final runtime database target

Key file:

- `src/config/store.ts`

## Workflow 6: Result Export

Export is not a standalone command yet. It is exposed through the agent tool surface.

Path:

1. latest query result is stored in memory
2. LLM calls `export_last_result`
3. tool specs validate the export request
4. export module writes JSON or CSV
5. final answer returns export path

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
