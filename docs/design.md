# db-chat-cli 设计方案

## 1. 目标

`db-chat-cli` 是一个面向命令行的数据库智能助手，使用 `Node.js + TypeScript + pnpm` 构建，整体交互风格参考 `codex cli / claude code cli`，但聚焦数据库场景。

用户通过命令行提供：

- LLM 配置：`baseURL`、`apiKey`、`model`
- 数据库配置：`dialect`、`host`、`port`、`database`、`username`、`password`

然后通过自然语言完成以下能力：

- 查询数据
- 新增 / 修改 / 删除数据
- 新建表 / 修改表结构 / 删除表
- 根据自然语言生成最终 SQL
- 对 SQL 做性能分析与优化建议
- 对查询结果做摘要分析
- 导出查询结果

其中所有会改变数据库状态的操作都必须经过用户确认后才能执行。

## 2. 设计原则

参考 `learn-claude-code` 的核心思想，本项目不做复杂规则编排，而是保持一个最小可用的 agent loop，并把工程投入放在 harness 上：

- `Loop`：LLM 决定何时调用工具、何时停止
- `Tools`：数据库查询、schema introspection、SQL explain、导出、plan 更新
- `Knowledge`：当前连接信息、schema 摘要、最近查询结果、执行计划
- `Permissions`：写操作必须确认，危险操作默认拒绝
- `Plan`：复杂任务先建立 plan，再逐步执行

结论：项目重点不是“写死流程图”，而是“给模型一套受控、可观测、可确认的数据库操作环境”。

## 3. V1 范围

### 3.1 支持范围

- 运行方式：纯命令行
- 语言：TypeScript
- 包管理：pnpm
- LLM 接口：OpenAI 兼容 Chat Completions 接口
- 数据库：PostgreSQL、MySQL
- 输出格式：终端表格 / JSON / CSV 导出
- 会话模式：单次命令、交互式 REPL

### 3.2 暂不纳入 V1

- 多数据库并行编排
- 长事务工作流编排
- 数据库权限系统代理化管理
- GUI / Web 界面
- 真正意义上的数据库方言自动重写器
- 超大结果集流式分析集群能力

## 4. 核心用户场景

### 4.1 自然语言查数

示例：

> 帮我找出最近 30 天成交额最高的 10 个客户，并按地区汇总。

系统流程：

1. 读取 schema 摘要
2. 需要时查看目标表结构
3. 生成 SQL
4. 执行查询
5. 返回 SQL、结果预览、分析结论

### 4.2 写操作确认执行

示例：

> 把 status = 'pending' 且超过 30 天未更新的订单标记为 expired。

系统流程：

1. 生成 SQL
2. 判定为 `UPDATE`
3. 在终端展示待执行 SQL
4. 用户确认
5. 执行并返回影响行数

### 4.3 复杂任务先 plan

示例：

> 帮我检查订单表、创建按月汇总表、回填数据，并导出一个校验结果。

系统流程：

1. 先调用 `update_plan`
2. 输出步骤列表
3. 按步骤调用 schema / sql / export 工具
4. 每完成一步就更新 plan 状态

### 4.4 SQL 优化

示例：

> 分析这条 SQL 的性能并给出优化建议。

系统流程：

1. 调用 `explain_sql`
2. 获取执行计划
3. 结合方言规则和计划内容输出风险与优化建议

## 5. 命令设计

### 5.1 顶层命令

```bash
dbchat init
dbchat chat
dbchat ask "最近 7 天订单量趋势"
dbchat sql "select * from users limit 10"
dbchat explain "select * from orders where created_at >= now() - interval '7 day'"
dbchat schema
dbchat config show
```

### 5.2 交互式 REPL 中的斜杠命令

```text
/help
/schema
/plan
/config
/clear
/exit
```

自然语言输入默认进入 agent loop。

## 6. 架构设计

### 6.1 模块划分

```text
src/
  index.ts                 # CLI 入口
  commands/                # commander 命令注册
  repl/                    # 交互式会话与终端 UI
  config/                  # 本地配置读写与校验
  agent/                   # agent loop、prompt、message state、plan state
  llm/                     # OpenAI 兼容客户端封装
  tools/                   # tool schema 与 handler
  db/                      # 数据库适配层、schema introspection、sql safety
  export/                  # CSV / JSON 导出
  types/                   # 公共类型
```

### 6.2 分层职责

#### CLI 层

- 解析参数
- 启动 REPL 或单次请求
- 打印结果
- 在写操作前向用户请求确认

#### Agent 层

- 维护 `messages`
- 注册工具定义
- 执行最小 agent loop
- 对复杂任务优先写入 / 更新 plan
- 将工具结果回灌给模型

#### Tool 层

- `update_plan`
- `get_schema_summary`
- `describe_table`
- `run_sql`
- `explain_sql`
- `export_last_result`

#### DB 层

- 数据库连接池
- 方言适配
- schema 查询
- SQL 类型识别
- explain 执行

## 7. 最小 Agent Loop

设计遵循 `learn-claude-code` 的最小循环：

```text
user input
  -> messages[]
  -> LLM
  -> tool calls?
      yes -> 执行工具 -> tool_result -> 继续 loop
      no  -> 输出最终答案
```

关键点：

- loop 本身保持简单
- 新能力通过注册工具增加
- plan、权限、导出都由 harness 负责

## 8. Plan 机制

### 8.1 为什么需要 plan

数据库任务往往不是一条 SQL 能完成：

- 先看 schema，再生成 SQL
- 先分析结果，再决定是否导出
- 先 explain，再优化 SQL
- 先创建表，再迁移数据

如果没有 plan，模型容易跳步或混淆上下文。

### 8.2 V1 实现方式

通过 `update_plan` 工具维护内存态 plan：

```json
[
  { "id": "step-1", "content": "检查 orders 表结构", "status": "in_progress" },
  { "id": "step-2", "content": "生成聚合 SQL", "status": "pending" },
  { "id": "step-3", "content": "导出结果到 CSV", "status": "pending" }
]
```

规则：

- 多步骤任务必须先创建 plan
- 同一时刻最多一个 `in_progress`
- 每次完成关键动作后更新 plan

## 9. 权限与安全设计

### 9.1 SQL 风险分级

#### 只读

- `SELECT`
- `SHOW`
- `DESCRIBE`
- `EXPLAIN`

默认允许执行。

#### 写操作

- `INSERT`
- `UPDATE`
- `DELETE`
- `CREATE`
- `ALTER`
- `DROP`
- `TRUNCATE`
- `RENAME`

必须人工确认。

### 9.2 确认流程

当模型调用 `run_sql` 且识别为写操作时：

1. 终端打印 SQL
2. 展示操作类型与数据库目标
3. 请求用户确认
4. 用户拒绝则返回 `cancelled`
5. 用户确认后才执行

### 9.3 安全边界

- 默认不自动执行破坏性 SQL
- 默认不执行多语句批处理
- explain 与执行分离
- 导出仅允许写入用户指定或当前工作目录下的安全路径

## 10. 数据库适配设计

### 10.1 统一接口

```ts
interface DatabaseAdapter {
  testConnection(): Promise<void>;
  getSchemaSummary(): Promise<SchemaSummary>;
  describeTable(tableName: string): Promise<TableSchema>;
  execute(sql: string): Promise<QueryExecutionResult>;
  explain(sql: string): Promise<QueryPlanResult>;
  close(): Promise<void>;
}
```

### 10.2 PostgreSQL

- 驱动：`pg`
- schema introspection：`information_schema.tables` / `information_schema.columns`
- explain：`EXPLAIN (FORMAT JSON) <sql>`

### 10.3 MySQL

- 驱动：`mysql2/promise`
- schema introspection：`information_schema.tables` / `information_schema.columns`
- explain：`EXPLAIN FORMAT=JSON <sql>`

## 11. 查询结果设计

查询结果统一为：

```ts
interface QueryExecutionResult {
  sql: string;
  operation: string;
  rowCount: number;
  rows: Record<string, unknown>[];
  fields: string[];
  elapsedMs: number;
}
```

约束：

- 终端默认只展示前 N 行预览
- 完整结果保存在 session 内存中
- 导出工具读取最近一次查询结果

## 12. SQL 分析与优化

V1 分两层：

### 12.1 结构性分析

- SQL 类型识别
- 是否存在 `select *`
- 是否缺失 `where`
- 是否可能全表扫描
- 是否存在过宽排序 / 聚合

### 12.2 执行计划分析

- PostgreSQL / MySQL explain 输出
- 由 LLM 基于 explain 内容给出优化建议
- 如果是纯自然语言需求，也可仅生成优化后的 SQL 候选

## 13. 配置设计

本地配置文件：

```text
~/.db-chat-cli/config.json
```

结构示例：

```json
{
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-***",
    "model": "gpt-4.1"
  },
  "database": {
    "dialect": "postgres",
    "host": "127.0.0.1",
    "port": 5432,
    "database": "app_db",
    "username": "postgres",
    "password": "secret"
  },
  "app": {
    "resultRowLimit": 200,
    "previewRowLimit": 20
  }
}
```

V1 默认本地明文存储，后续可升级为系统密钥链方案。

## 14. Prompt 设计

系统提示词应明确：

- 你是数据库 CLI 智能助手
- 优先使用工具获取 schema，不凭空臆造表名和字段
- 写操作必须先展示 SQL 并等待确认
- 复杂任务必须先使用 `update_plan`
- 最终回答中给出：
  - 你做了什么
  - 最终 SQL
  - 是否执行
  - 结果摘要
  - 风险提示

## 15. 典型执行流程

### 15.1 自然语言查询

```text
用户输入问题
-> agent 判断需要查看 schema
-> describe_table / get_schema_summary
-> run_sql(SELECT)
-> LLM 总结结果
-> 终端输出
```

### 15.2 自然语言写操作

```text
用户提出修改需求
-> agent 生成 SQL
-> run_sql(UPDATE)
-> CLI 弹出确认
-> 用户确认
-> 执行
-> 返回影响行数与摘要
```

### 15.3 SQL 优化

```text
用户提供 SQL
-> explain_sql
-> LLM 解读执行计划
-> 输出优化建议与改写 SQL
```

## 16. 目录规划

```text
docs/
  design.md
src/
  index.ts
  commands/
    chat.ts
    ask.ts
    sql.ts
    explain.ts
    schema.ts
    config.ts
  agent/
    session.ts
    loop.ts
    prompts.ts
    plan.ts
  config/
    store.ts
    defaults.ts
    schema.ts
  db/
    adapter.ts
    factory.ts
    postgres.ts
    mysql.ts
    schema.ts
    safety.ts
  llm/
    client.ts
  tools/
    definitions.ts
    registry.ts
  repl/
    chat.ts
  export/
    csv.ts
  types/
    index.ts
```

## 17. 里程碑

### M1

- 初始化 TypeScript CLI 工程
- 完成配置读写
- 完成 Postgres / MySQL 连接测试

### M2

- 完成 agent loop
- 完成 schema / sql / explain / export 工具
- 完成写操作确认机制

### M3

- 完成交互式 REPL
- 完成 plan 输出
- 完成基础导出与结果分析

### M4

- 完成 README
- 完成构建与 typecheck
- 输出后续增强项

## 18. 后续增强

- 支持 SQLite / SQL Server
- 支持结果集流式导出
- 支持会话恢复与历史记录
- 支持更细粒度的 RBAC / SQL 审批策略
- 支持数据库统计信息采样与更强的 SQL lint
- 支持 MCP / 外部插件化工具注册
