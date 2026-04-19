# Architecture For Agents

## High-Level Layers

### 1. CLI Layer

Files:

- `src/index.ts`
- `src/commands/register.ts`
- `src/commands/handlers.ts`
- `src/commands/init.ts`
- `src/commands/database-config.ts`
- `src/commands/database-config-helpers.ts`
- `src/commands/shared.ts`
- `src/repl/chat-ink.ts`
- `src/repl/chat-readline.ts`
- `src/repl/chat-app.tsx`
- `src/repl/chat-controller.ts`
- `src/repl/slash-commands.ts`
- `src/repl/runtime.ts`

Responsibilities:

- parse commands
- load config
- create runtime
- print results
- provide user confirmation prompts
- prompt for runtime SQL operation access during database switching flows, without persisting that access level in stored config
- persist the selected active database target for future sessions when a REPL database switch succeeds on a stored host
- render the Ink chat landing view with an initial Codex-style splash that stays at the top of the transcript, a bordered runtime info panel for model and active database, a focused plain `>` composer, slash-command autocomplete suggestions, and `@` live database-switch suggestions for the current host
- keep the chat controller logic separate from the Ink view so prompt bridging, slash-command routing, and runtime switching can evolve without bloating the render component
- when a database switch changes the active database target, clear both in-memory conversation state and the visible REPL transcript before showing the new target notice
- prefer the React Ink chat UI when available and fall back to the readline REPL when Ink cannot initialize

### 2. Service Layer

Files:

- `src/services/sql.ts`
- `src/services/schema-catalog.ts`

Responsibilities:

- keep command handlers and LLM tools thin by centralizing repeated orchestration
- share one SQL execution path for direct CLI SQL, tool-driven SQL, approval gating, and post-execution schema-catalog staleness notices
- share one schema-catalog path for initialization, manual refresh, and local snapshot search flows

### 3. Agent Layer

Files:

- `src/agent/session.ts`
- `src/agent/session-policy.ts`
- `src/agent/message-builder.ts`
- `src/agent/tool-execution.ts`
- `src/agent/memory.ts`
- `src/agent/prompts.ts`
- `src/agent/plan.ts`

Responsibilities:

- maintain compressed conversation memory plus a recent raw-turn window
- keep older turns searchable by stable turn IDs even after they leave the raw prompt window
- keep oversized tool payloads out of model-visible history by replacing them with persisted-output markers that can be inspected later on demand
- maintain in-memory plan
- maintain latest query result
- load the active target's layered `global > host > database` instruction files before each turn and inject the runtime view into the LLM request as a separate system message
- keep request-intent heuristics, finer-grained request context classification, request-aware context packing, message assembly, and tool execution helpers separated so the session coordinator can stay focused on control flow
- execute the minimal loop:
  - send messages to LLM
  - process tool calls
  - feed compact tool results back
  - compact long assistant replies before they enter future prompt history
  - archive older turns as high-value summaries that prefer request, outcome, and conclusion lines over raw tool traces
  - stop on final answer

### 4. LLM Layer

Files:

- `src/llm/client.ts`
- `src/llm/types.ts`

Responsibilities:

- normalize provider behavior
- speak either:
  - OpenAI-compatible `/chat/completions`
  - Anthropic-compatible `/messages`
- translate tool definitions and tool results between internal and provider-specific formats

### 5. Tool Layer

Files:

- `src/tools/definitions.ts`
- `src/tools/registry.ts`
- `src/tools/specs.ts`
- `src/tools/model-payload.ts`

Responsibilities:

- define the tool surface available to the model
- validate and execute tool calls from a shared spec registry
- summarize tool results before they are sent back into model-visible history
- expose history inspection for archived turns and persisted oversized tool payloads
- expose cached-result and cached-explain inspection so the model can fetch more detail on demand instead of carrying large previews forward
- keep default SQL and EXPLAIN payloads tight enough that wide result sets and large plans do not dominate later turns
- enforce confirmation gates
- hold the boundary between model intent and side effects

### 6. Schema Catalog Layer

Files:

- `src/schema/catalog.ts`
- `src/schema/catalog-sync.ts`
- `src/schema/catalog-search.ts`
- `src/schema/catalog-storage.ts`
- `src/schema/catalog-enrichment.ts`
- `src/embedding/client.ts`

Responsibilities:

- persist one local schema snapshot per database target
- compute table-level hashes for refresh diffing
- load the same layered `global > host > database` instruction files during catalog rebuilds, using the catalog view of those files
- persist an instruction fingerprint in each catalog snapshot so regenerated catalogs can track instruction-layer changes separately from schema changes
- carry a clipped instruction-context summary into table documents and optional embedding text so local retrieval can reuse business hints
- persist one embedding vector per table for semantic search
- use a configured OpenAI-compatible embedding API for indexing and query embeddings
- provide searchable table summaries before live introspection
- reduce prompt pressure by letting the model search candidate tables first

### 7. Database Layer

Files:

- `src/db/adapter.ts`
- `src/db/factory.ts`
- `src/db/postgres.ts`
- `src/db/mysql.ts`
- `src/db/safety.ts`

Responsibilities:

- create the correct adapter lazily
- introspect schema
- execute SQL
- explain SQL
- classify and warn about risky SQL

### 8. Support Layer

Files:

- `src/config/*`
- `src/instructions/scoped.ts`
- `src/config/database-hosts.ts`
- `src/export/csv.ts`
- `src/ui/prompts.ts`
- `src/ui/text-table.ts`
- `src/ui/text-formatters.ts`
- `src/types/index.ts`

Responsibilities:

- config defaults and validation
- layered instruction path resolution plus `Shared` / `Runtime` / `Catalog` section selection
- runtime context-compression defaults and validation
- stored multi-host database config normalization, runtime access defaults, and active target selection
- export helpers
- terminal prompt helpers
- shared types

## Extension Guidance

If adding a feature:

- add a command when the capability should be directly user-invoked
- add a tool when the LLM should decide when to use it
- add a db adapter method when the capability depends on database-specific execution
- add config schema changes only when the setting is truly persistent and user-facing
