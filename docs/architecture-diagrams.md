# dbchat-cli Architecture Diagrams

This document mirrors the current implementation.

## 1. Overall Flow

```mermaid
flowchart TD
    A[User Input] --> B[CLI Entry: src/index.ts]
    B --> C[Commander Registration]
    C --> D{Command Type}

    D -->|init| E[Interactive Config Setup]
    E --> F[Write Stored Config]

    D -->|config show| G[Load Masked Stored Config]
    G --> H[Try To Build Masked Resolved Runtime Config]

    D -->|schema / sql / explain / catalog| I[Resolve Runtime Config]
    D -->|ask / chat| I

    I --> J[Create Database Adapter]
    J --> K[Test Database Connection]
    I --> IA[Resolve Scoped Instructions]
    K --> L{Execution Mode}

    L -->|schema| M[Inspect Schema]
    M --> N[Print Summary Or Table DDL]

    L -->|sql| O[Assess SQL Safety]
    O --> P{Mutation Or Unknown?}
    P -->|no| Q[Execute SQL]
    P -->|yes| R[Ask For Approval]
    R --> S{Approved?}
    S -->|no| T[Cancel]
    S -->|yes| Q
    Q --> U[Attach HTML And CSV Artifacts When Needed]
    U --> V[Print Inline Or Bounded Preview]

    L -->|explain| W[Run EXPLAIN]
    W --> X[Print Plan JSON]

    L -->|catalog sync| Y[Refresh Local Schema Catalog]
    Y --> Z[Write catalog.json]

    L -->|ask / chat| AA[Ensure Compatible Local Schema Catalog]
    AA --> AB[Create Or Reuse Agent Session]
    AB --> AC[Build Prompt Context]
    IA --> AC
    AC --> AD[Call LLM]
    AD --> AE{Tool Calls?}
    AE -->|no| AF[Print Final Answer]
    AE -->|yes| AG[Execute Tool Registry]
    AG --> AH{Tool Type}
    AH -->|schema tools| AI[Search Catalog Or Describe Table]
    AH -->|run_sql| O
    AH -->|explain_sql| W
    AH -->|result inspection| AJ[Inspect/Search/Render Cached Result]
    AH -->|history inspection| AK[Inspect Archived Turn Or Persisted Output]
    AH -->|export_last_result| AL[Export JSON]
    AH -->|update_plan| AM[Update In-Memory Plan]
    AI --> AN[Return Compact Tool Result]
    AJ --> AN
    AK --> AN
    AL --> AN
    AM --> AN
    N --> AN
    T --> AN
    V --> AN
    X --> AN
    AN --> AD
```

## 2. Runtime Layers

```mermaid
flowchart LR
    U[User] --> CLI[CLI Commands / REPL]
    CLI --> CFG[Config Store]
    CLI --> INS[Scoped Instructions]
    CLI --> DB[Database Adapter]
    CLI --> CAT[Schema Catalog]
    CLI --> AGENT[Agent Session]

    AGENT --> PROMPT[Prompt Builder]
    PROMPT --> INS
    AGENT --> LLM[LlmClient]
    LLM --> TOOLS[Tool Registry]

    TOOLS --> PLAN[Plan State]
    TOOLS --> DB
    TOOLS --> CAT
    TOOLS --> EXPORT[Result Export]
    TOOLS --> CONFIRM[Approval Gate]

    DB --> PG[Postgres Adapter]
    DB --> MY[MySQL Adapter]
```

## 3. Read Query Sequence

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / Command
    participant DB as DatabaseAdapter
    participant Catalog as Schema Catalog
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as Tool Registry

    User->>CLI: dbchat ask "show top 10 rows from users"
    CLI->>DB: testConnection()
    CLI->>Catalog: ensure compatible local catalog
    CLI->>CLI: load runtime scoped instructions
    CLI->>Agent: run(prompt)
    Agent->>LLM: messages + tools
    LLM-->>Agent: tool call search_schema_catalog / describe_table
    Agent->>Tools: executeTool(...)
    Tools->>Catalog: search / load table snapshot
    Catalog-->>Tools: ranked matches / schema details
    Tools-->>Agent: compact tool result
    Agent->>LLM: tool result
    LLM-->>Agent: tool call run_sql(SELECT ...)
    Agent->>Tools: executeTool(run_sql)
    Tools->>DB: execute(SELECT ...)
    DB-->>Tools: rows + fields + rowCount
    Tools-->>Agent: compact SQL result
    Agent->>LLM: tool result
    LLM-->>Agent: final answer
    Agent-->>CLI: final answer + display blocks
    CLI-->>User: final answer + inline preview or HTML/CSV artifacts
```

## 4. Mutation Sequence

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / Command
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as Tool Registry
    participant Confirm as Approval Prompt
    participant DB as DatabaseAdapter

    User->>CLI: dbchat ask "mark overdue orders as expired"
    CLI->>Agent: run(prompt)
    Agent->>LLM: messages + tools
    LLM-->>Agent: tool call run_sql(UPDATE ...)
    Agent->>Tools: executeTool(run_sql)
    Tools->>Tools: assessSqlSafety()
    Tools->>Confirm: ask for approval
    Confirm-->>User: Approve Once / Approve All For Turn / Reject
    User-->>Confirm: Approve Once
    Confirm-->>Tools: approved
    Tools->>DB: execute(UPDATE ...)
    DB-->>Tools: affected rows
    Tools-->>Agent: execution result
    Agent->>LLM: tool result
    LLM-->>Agent: final answer
    Agent-->>CLI: final answer
    CLI-->>User: summary + follow-up note about manual catalog sync when needed
```

## 5. Catalog Sync Sequence

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / Command
    participant DB as DatabaseAdapter
    participant Catalog as Catalog Sync
    participant Embed as Embedding API

    User->>CLI: dbchat catalog sync
    CLI->>DB: testConnection()
    CLI->>Catalog: load catalog scoped instructions
    CLI->>Catalog: fetch live table schemas
    alt embeddings enabled
        Catalog->>Embed: embed merged table documents
        Embed-->>Catalog: vectors
    end
    Catalog-->>CLI: refreshed catalog + docs
    CLI-->>User: sync summary
```

## 6. Result Artifact Reuse

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / REPL
    participant Agent as AgentSession
    participant LLM as LlmClient

    User->>CLI: ask "export the last result to csv"
    CLI->>Agent: run(prompt)
    Agent->>LLM: prompt + latest result summary
    Note over Agent: latest result summary already includes HTML and CSV artifact URLs when available
    LLM-->>Agent: final answer reusing cached CSV artifact path
    Agent-->>CLI: final answer
    CLI-->>User: final answer + artifact block
```
