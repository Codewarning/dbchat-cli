# dbchat-cli

`dbchat-cli` is a terminal assistant for PostgreSQL and MySQL that combines natural-language requests, direct SQL execution, schema inspection, query-plan analysis, and result export in one CLI.

It is designed to feel like a database-focused coding assistant while keeping SQL execution constrained and explicit.

## Install

```bash
npm install -g dbchat-cli
dbchat --help
```

Requirements:

- Node.js 20+
- Access to a PostgreSQL or MySQL database
- An API key for an OpenAI-compatible or Anthropic-compatible LLM provider

## Quick Start

1. Initialize the CLI:

```bash
dbchat init
```

2. Inspect the active database:

```bash
dbchat schema
```

3. Run a natural-language request:

```bash
dbchat ask "Show the top 10 rows from users"
```

4. Start the interactive session:

```bash
dbchat chat
```

## What It Can Do

- Translate natural-language prompts into database workflows
- Execute one SQL statement at a time
- Show schema summaries and table definitions
- Run `EXPLAIN` workflows for query analysis
- Export cached query results to `JSON` or `CSV`
- Maintain a local semantic schema catalog for table discovery

## Supported Backends

- PostgreSQL
- MySQL
- OpenAI-compatible `/chat/completions` providers
- Anthropic-compatible `/messages` providers

Built-in provider presets include:

- OpenAI
- Anthropic / Claude
- DeepSeek
- Custom compatible endpoint

## Safety Defaults

- Only one SQL statement may run at a time.
- Mutating SQL requires explicit confirmation before execution.
- Runtime database access defaults to `read-only`.
- Schema inspection is preferred over guessing table or column names.

## Runtime Notes

- Local config is stored in `~/.db-chat-cli/config.json`.
- Schema catalog data is stored in `~/.db-chat-cli/schema-catalog/`.
- Generated HTML result views, matching CSV files, and JSON exports are stored in `~/.db-chat-cli/tmp/`.
- `dbchat config show` prints both the masked stored config and the masked resolved runtime config.
- The on-disk directory name remains `~/.db-chat-cli/` for compatibility with existing local installs.
- Schema catalog sync can optionally call a remote embedding API when an embedding key is configured, but local BM25 catalog search still works without embeddings.

## Common Commands

```bash
dbchat init
dbchat config show
dbchat schema --table orders
dbchat sql "select * from users limit 10"
dbchat explain "select * from orders where created_at >= now() - interval '7 day'"
dbchat catalog sync
dbchat catalog search "order items"
dbchat chat
```

## Environment Variables

Common overrides:

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
- `DBCHAT_DB_DIALECT`
- `DBCHAT_DB_HOST`
- `DBCHAT_DB_PORT`
- `DBCHAT_DB_NAME`
- `DBCHAT_DB_USER`
- `DBCHAT_DB_PASSWORD`
- `DBCHAT_DB_SCHEMA`
- `DBCHAT_DB_SSL`
- `DBCHAT_FORCE_HYPERLINK`

A project-local `.env` file in the current working directory is loaded as a default-value layer below shell env and below `~/.db-chat-cli/config.json`.

The source repository contains the full development README, architecture notes, and agent-oriented docs.
