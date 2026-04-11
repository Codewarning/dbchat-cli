# db-chat-cli 架构图

本文使用流程图和时序图描述 `db-chat-cli` 的整体工作方式，覆盖：

- CLI 启动与命令分发
- 自然语言请求进入 agent loop
- LLM 与 tools 的交互
- 数据库查询 / 写操作确认 / explain / 导出

## 1. Overall Flowchart

```mermaid
flowchart TD
    A[User Input] --> B[CLI Entry<br/>index.ts]
    B --> C[Commander Registration]
    C --> D{Command Type}

    D -->|init| E[Interactive Config Setup]
    E --> F[Save Config File]

    D -->|config show| G[Load and Print Masked Config]

    D -->|schema / sql / explain| H[Load Runtime Config]
    D -->|ask / chat| H

    H --> I[Create Database Adapter]
    I --> J[Test Database Connection]

    J --> K{Execution Mode}

    K -->|schema| L[Schema Introspection]
    L --> M[Print Tables or Table Definition]

    K -->|sql| N[SQL Safety Check]
    N --> O{Mutation SQL?}
    O -->|no| P[Execute SQL]
    O -->|yes| Q[Ask User for Confirmation]
    Q --> R{Approved?}
    R -->|no| S[Cancel Execution]
    R -->|yes| P
    P --> T[Print Result Preview]

    K -->|explain| U[Run EXPLAIN]
    U --> V[Print Plan JSON and Warnings]

    K -->|ask / chat| W[Refresh Local Schema Catalog + Semantic Index]
    W --> X[Create Agent Session]
    X --> Y[Build System Prompt + Compressed Context]
    Y --> Z[Send Messages to LLM]
    Z --> AA{Tool Calls Returned?}
    AA -->|no| AB[Print Final Answer]
    AA -->|yes| AC[Execute Tool Registry]
    AC --> AD{Tool Type}
    AD -->|search_schema_catalog| AE[Search Local Schema Catalog]
    AD -->|schema| L
    AD -->|run_sql| N
    AD -->|explain_sql| U
    AD -->|export_last_result| AF[Export JSON / CSV]
    AD -->|update_plan| AG[Update In-Memory Plan]
    AE --> AH[Return Tool Result]
    AF --> AH
    AG --> AH
    L --> AH
    M --> AH
    S --> AH
    T --> AH
    V --> AH
    AH --> Z
```

## 2. Runtime Layer View

```mermaid
flowchart LR
    U[User] --> CLI[CLI Commands / REPL]
    CLI --> CFG[Config Store]
    CLI --> CATALOG[Schema Catalog]
    CLI --> AGENT[Agent Session]
    CLI --> DB[Database Adapter]

    AGENT --> PROMPT[System Prompt + Context Prompt]
    AGENT --> LLM[LlmClient]
    LLM --> TOOLS[Tool Registry]

    TOOLS --> PLAN[Plan State]
    TOOLS --> CATALOG
    TOOLS --> DB
    TOOLS --> EXPORT[Export Module]
    TOOLS --> CONFIRM[Confirmation Gate]

    DB --> PG[Postgres Adapter]
    DB --> MY[MySQL Adapter]
```

## 3. Sequence: Natural-Language Read Query

场景示例：

> show me the top 10 rows from users

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / Command
    participant Catalog as Schema Catalog
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as ToolRegistry
    participant DB as DatabaseAdapter

    User->>CLI: dbchat ask "show me the top 10 rows from users"
    CLI->>DB: testConnection()
    CLI->>Catalog: sync schema snapshot
    CLI->>Agent: run(prompt)
    Agent->>LLM: messages + tools
    LLM-->>Agent: tool call search_schema_catalog / describe_table
    Agent->>Tools: executeTool(...)
    Tools->>Catalog: search / load table snapshot
    Catalog-->>Tools: ranked tables / table schema
    Tools-->>Agent: tool result
    Agent->>LLM: tool result + updated context
    LLM-->>Agent: tool call run_sql(SELECT ...)
    Agent->>Tools: executeTool(run_sql)
    Tools->>DB: execute(SELECT ...)
    DB-->>Tools: rows + fields + rowCount
    Tools-->>Agent: query result preview
    Agent->>LLM: tool result
    LLM-->>Agent: final answer
    Agent-->>CLI: final answer + SQL summary
    CLI-->>User: print result
```

## 4. Sequence: Natural-Language Mutation With Confirmation

场景示例：

> mark overdue pending orders as expired

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / Command
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as ToolRegistry
    participant Confirm as Confirmation Gate
    participant DB as DatabaseAdapter

    User->>CLI: dbchat ask "mark overdue pending orders as expired"
    CLI->>DB: testConnection()
    CLI->>Agent: run(prompt)
    Agent->>LLM: messages + tools
    LLM-->>Agent: tool call run_sql(UPDATE ...)
    Agent->>Tools: executeTool(run_sql)
    Tools->>Tools: assessSqlSafety()
    Tools->>Confirm: ask user to approve mutation
    Confirm-->>User: prompt yes/no
    User-->>Confirm: yes
    Confirm-->>Tools: approved
    Tools->>DB: execute(UPDATE ...)
    DB-->>Tools: affected rows
    Tools-->>Agent: execution result
    Agent->>LLM: tool result
    LLM-->>Agent: final answer with SQL + outcome
    Agent-->>CLI: final answer
    CLI-->>User: print affected rows and summary
```

如果用户拒绝确认，则流程在 `Confirmation Gate` 后直接返回 `cancelled`，不会执行数据库写操作。

## 5. Sequence: SQL Explain and Optimization

场景示例：

> analyze this SQL for performance and suggest improvements

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / Command
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as ToolRegistry
    participant DB as DatabaseAdapter

    User->>CLI: ask/explain with SQL
    CLI->>DB: testConnection()
    CLI->>Agent: run(prompt)
    Agent->>LLM: messages + tools
    LLM-->>Agent: tool call explain_sql(SQL)
    Agent->>Tools: executeTool(explain_sql)
    Tools->>DB: explain(SQL)
    DB-->>Tools: JSON plan + warnings
    Tools-->>Agent: explain result
    Agent->>LLM: tool result
    LLM-->>Agent: optimization advice + rewritten SQL
    Agent-->>CLI: final answer
    CLI-->>User: print plan summary and suggestions
```

## 6. Sequence: Export Last Query Result

场景示例：

> export the last result to csv

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / REPL
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as ToolRegistry
    participant Export as Export Module

    User->>CLI: ask "export the last result to csv"
    CLI->>Agent: run(prompt)
    Agent->>LLM: compressed memory + recent raw turns + lastResult context
    LLM-->>Agent: tool call export_last_result(csv, path)
    Agent->>Tools: executeTool(export_last_result)
    Tools->>Export: exportQueryResult(...)
    Export-->>Tools: file path + row count
    Tools-->>Agent: export result
    Agent->>LLM: tool result
    LLM-->>Agent: final answer
    Agent-->>CLI: final answer
    CLI-->>User: print export path
```

## 7. Complex Task With Plan

复杂任务会优先建立 plan，而不是直接执行所有动作。

```mermaid
sequenceDiagram
    participant User
    participant Agent as AgentSession
    participant LLM as LlmClient
    participant Tools as ToolRegistry

    User->>Agent: multi-step task
    Agent->>LLM: messages + tools
    LLM-->>Agent: tool call update_plan(...)
    Agent->>Tools: executeTool(update_plan)
    Tools-->>Agent: plan stored in memory
    Agent->>LLM: updated plan context
    LLM-->>Agent: next tool call
    Agent->>Tools: execute next step
    Tools-->>Agent: step result
    Agent->>LLM: step result + updated context
    LLM-->>Agent: update_plan(next status)
```

## 8. How To Read These Diagrams

- `CLI / Command` 负责命令分发、结果打印、确认交互。
- `AgentSession` 负责维护 compressed memory、recent raw turns、plan、lastResult，并驱动最小 agent loop。
- `LlmClient` 负责对接 OpenAI-compatible 或 Anthropic-compatible API。
- `ToolRegistry` 是模型与外部能力之间的受控边界。
- `DatabaseAdapter` 屏蔽 PostgreSQL / MySQL 差异。
- `Confirmation Gate` 确保所有写操作都必须经过人工批准。

整体上，这个项目不是把数据库能力写死在流程图里，而是通过：

- 最小 agent loop
- tool-based execution
- explicit confirmation
- plan state
- adapter abstraction

来形成一个可控的数据库智能 CLI。
