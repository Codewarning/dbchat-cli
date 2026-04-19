# dbchat-cli

[English](./README.md) | 简体中文

`dbchat-cli` 是一个面向数据库场景的命令行助手，基于 `Node.js + TypeScript + pnpm` 构建。

它支持以下自然语言工作流：

- 查询数据
- 生成 SQL
- 分析查询结果
- 导出查询结果
- 分析 SQL 执行计划
- 在显式批准后执行允许范围内的变更 SQL，并受当前数据库访问级别限制

复杂任务默认先创建计划，再分步执行。

## 设计文档

- 详细设计文档：[docs/design.md](./docs/design.md)
- 架构图：[docs/architecture-diagrams.md](./docs/architecture-diagrams.md)
- npm 发布流程：[docs/npm-publish.md](./docs/npm-publish.md)

## 技术栈

- Node.js 20+
- TypeScript
- pnpm
- React Ink 终端 UI，用于交互式聊天模式
- OpenAI-compatible chat completions
- Anthropic messages API
- PostgreSQL / MySQL

## 安装

```bash
pnpm install
pnpm build
```

## 全局安装

先构建项目：

```bash
pnpm build
```

然后从当前项目全局安装 CLI：

```bash
pnpm link --global
```

之后可以运行：

```bash
dbchat --help
```

如果后续修改了源码，需要重新构建并重新链接：

```bash
pnpm build
pnpm link --global
```

卸载全局链接：

```bash
pnpm unlink --global dbchat-cli
```

也可以使用：

```bash
pnpm add -g .
```

本地迭代开发通常更推荐 `pnpm link --global`。

## 初始化配置

```bash
node dist/index.js init
```

交互式初始化支持选择以下 LLM provider 预设：

- OpenAI GPT
- Claude / Anthropic
- DeepSeek
- Custom

每个预设都会预填默认的 `base URL` 和 `model`，你也可以手动覆盖。
初始化过程会使用方向键菜单选择 provider、dialect、yes/no 选项，以及常见值，例如端口、schema、行数限制、base URL 和 model。
数据库 host 配置提示也会按 dialect 给出不同默认值。例如 PostgreSQL 默认端口是 `5432`、默认用户名是 `postgres`；MySQL 默认端口是 `3306`、默认用户名是 `root`。

数据库 host 和 database 条目不会持久化 SQL 访问级别。
运行时访问级别在 `chat` 中切换数据库时选择，默认始终是 `Read only`。

配置文件保存在：

```text
~/.db-chat-cli/config.json
```

会话上下文压缩相关设置位于 `app.contextCompression`。
它们都是可选项，并带有保守默认值。

表格预览相关设置位于 `app.tableRendering`：

- `inlineRowLimit`
- `inlineColumnLimit`
- `previewRowLimit`

临时产物清理还会使用 `app.tempArtifactRetentionDays`。
默认值是 3 天，也可以通过 `.env` 中的 `DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS` 覆盖。

生成的 HTML 结果页和 agent 导出文件会保存在配置目录下：

```text
~/.db-chat-cli/tmp/
```

每次 CLI 启动时，都会自动清理这个工作目录临时区中超过配置保留窗口的文件。
默认保留 3 天。

## Scoped Instructions

可选的分层说明文件位于：

```text
~/.db-chat-cli/agents/
  AGENTS.md
  <host-port>/AGENTS.md
  <host-port>/<database>/AGENTS.md
  <host-port>/<database>/tables/<table>.md
```

当同一个目标同时命中多层文件时，优先级为：

- `database > host > global`

如果文件没有保留分段标题，则整份文件会同时用于 runtime prompt 和 catalog sync。
如果使用了保留标题，`dbchat` 会按下面的规则读取：

- `## Shared` + `## Runtime` 用于 `ask` 和 `chat`
- `## Shared` + `## Catalog` 用于 `catalog sync`

这些路径片段会被规范化为可读、文件系统安全的小写形式。
当数据库目标被成功选择或切换后，`dbchat` 会自动初始化这套目录：缺失的 `AGENTS.md` 文件和缺失的 `tables/*.md` 文件会被创建为空白文件；已经存在的文件会直接保留，不会覆盖。

## Schema Catalog

本地 schema catalog 保存在：

```text
PostgreSQL: ~/.db-chat-cli/schema-catalog/postgres/<host-port>/<database>/<schema>/
MySQL:      ~/.db-chat-cli/schema-catalog/mysql/<host-port>/<database>/public/
```

现在每个数据库目标都使用可读路径，不再使用 hash 目录名。
一个 catalog scope 包含：

- `catalog.json`
  合并后的本地 schema catalog
- `catalog.json`
  当前数据库目标对应的本地 schema catalog 快照及检索文档

`dbchat catalog sync` 会读取当前活动数据库中的真实表结构，并直接重建该 scope 下的本地 catalog 快照。
它还会加载当前目标命中的 scoped instruction 文件，并把 `instructionFingerprint` 写入 catalog 快照。
同步时一定会构建本地的表级、字段级、关系级检索文档，用于 BM25 风格的本地检索；表级文档还会附带裁剪后的 `instructionContext`，供本地检索和可选 embedding 复用。

如果配置了 embedding API key，同步时还会额外生成每张表的 embedding 向量，作为补充召回信号，并在后续同步时尽量复用。
embedding 是增强能力，不是本地 schema 搜索的前提条件。

`dbchat catalog search`、`ask` 和 `chat` 会优先搜索这份合并后的本地 catalog。
默认检索流程完全在本地执行，不会把查询文本发送到远程服务。
scoped instruction 文件本身只在本地读取，不会单独触发远程 API 调用。
启用 embedding 后，catalog 重建会在 `catalog sync` 和首次进入数据库时初始化 catalog 的过程中，把合并后的 schema 元数据发送到配置好的 embedding API。

当 `ask`、`chat` 或交互式数据库切换进入某个数据库目标时，如果本地 catalog 已存在，就会直接复用。
如果 catalog 缺失，CLI 可以在进入该数据库时初始化。
进入数据库后，schema-catalog 工具会复用已有 catalog，不会在后续调用中自动刷新。

### 外部文档

本地 YAML 文档支持已移除，schema catalog 现在只维护按数据库目标划分的 `catalog.json` 快照。

```bash
```

`dbchat catalog search` 在 catalog 已经构建完成后，只依赖本地快照，不要求实时数据库连接可用。
每个文件把“程序维护的 schema 事实”和“用户维护的语义信息”放在同一个文档里：

- `managed`
  程序自动维护，来自数据库事实，例如表注释、字段、类型、是否可空、默认值、关系
- `user`
  用户维护，补充业务语义，例如业务名、描述、别名、字段说明、逻辑关系、示例查询

程序会在 `catalog sync` 时自动更新 `managed` 区域，同时保留并补齐 `user` 区域：

- 如果新增表，会自动新增对应的 `.yml`
- 如果表新增字段，会自动把缺失字段补进该表的 `user.columns`
- 不会覆盖用户已经填写过的描述、别名和示例
- catalog snapshot 只会由 `catalog sync` 基于数据库真实 schema 重建

示例结构：

```yaml
table_name: "sys_user"
managed:
  generated_at: "2026-04-16T00:00:00.000Z"
  table_comment: "系统用户表"
  columns:
    -
      name: "username"
      data_type: "text"
      is_nullable: false
      default_value: null
      comment: "登录用户名"
  relations: []
user:
  business_name: "系统用户"
  description: "后台系统主用户表"
  aliases:
    - "user"
    - "账号"
    - "admin_user"
  tags:
    - "user"
    - "account"
  columns:
    username:
      description: "登录用户名"
      aliases:
        - "login_name"
  relations: []
  examples:
    - "查询租户下启用状态的后台用户"
```

## 环境变量

你也可以通过环境变量覆盖配置：

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
- `DBCHAT_RESULT_ROW_LIMIT`
- `DBCHAT_PREVIEW_ROW_LIMIT`
- `DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS`
- `DBCHAT_INLINE_TABLE_ROW_LIMIT`
- `DBCHAT_INLINE_TABLE_COLUMN_LIMIT`
- `DBCHAT_PREVIEW_TABLE_ROW_LIMIT`
- `DBCHAT_FORCE_HYPERLINK`
- `DBCHAT_CONTEXT_RECENT_RAW_TURNS`
- `DBCHAT_CONTEXT_RAW_HISTORY_CHARS`
- `DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS`
- `DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS`
- `DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN`
- `DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS`
- `DBCHAT_DB_DIALECT`
- `DBCHAT_DB_HOST`
- `DBCHAT_DB_PORT`
- `DBCHAT_DB_NAME`
- `DBCHAT_DB_USER`
- `DBCHAT_DB_PASSWORD`
- `DBCHAT_DB_SCHEMA`
- `DBCHAT_DB_SSL`

## 使用方式

### 交互模式

```bash
node dist/index.js chat
```

交互式聊天会在每次 LLM 回复后保持打开，只有在输入 `/exit` 或手动终止进程时才退出。

当 `chat` 运行在 TTY 终端中时，会使用 React Ink 界面，并提供：

- 顶部的 Codex 风格欢迎区
- 显示当前模型和活动数据库目标的运行时信息面板
- 简洁的 `>` 输入区
- 输入 `/...` 时的 slash-command 自动补全
- 输入 `@...` 时的实时数据库切换选择器
- 用户输入、工具输出和最终回答组成的滚动时间线
- 长任务的内联 loading 面板
- 用于 SQL 批准和 `/host`、`/database` 流程的模态确认、输入和选择框

如果当前环境无法初始化 Ink 运行时，`chat` 会自动回退到普通 readline REPL。

在 REPL 中，你也可以用 `/host ...` 和 `/database ...` 管理已保存的 host 和 database。
当你通过 `/database use`、`/host use` 或 `@` 选择器切换数据库时，CLI 会提示你为当前运行时选择数据库操作访问级别。
该选择不会持久化，默认始终是 `Read only`。
每个 agent turn 开始前，还会重新加载当前数据库目标命中的 runtime instruction 分层内容，再构建下一次 LLM 请求。

### 一次性自然语言请求

```bash
node dist/index.js ask "Show the order volume trend for the last 7 days"
node dist/index.js ask "Analyze this SQL for performance and suggest improvements"
```

对于 `ask` 和 `chat`，如果模型生成的是需要展示结果的只读 `SELECT`，但没有显式行数限制，CLI 会根据 `app.previewRowLimit` 自动补一个默认 `LIMIT`。
这样可以避免终端里意外出现过大的结果集，除非用户明确要求全部结果、完整导出或其他精确行数。

当缓存结果同时满足 `app.tableRendering.inlineRowLimit` 和 `app.tableRendering.inlineColumnLimit` 时，CLI 会直接在终端完整渲染表格。
如果结果更大，则只在终端展示前 `app.tableRendering.previewRowLimit` 行，并附带生成的 HTML 文件 URL，方便在浏览器中查看完整缓存表格。
生成 HTML 的同时，还会为同一批缓存行额外写出一份 CSV，并把 CSV 地址补在 HTML 地址下面。

### 直接执行 SQL

```bash
node dist/index.js sql "select * from users limit 10"
```

只读 SQL 会立即执行。
如果当前数据库访问级别允许，DML、DDL 和未分类 SQL 会触发包含三个选项的审批提示：`Approve Once`、`Approve All For Turn`、`Reject`。
如果当前访问级别不允许该语句，CLI 会在打开审批提示前直接拒绝执行。
只读结果预览会沿用和 `ask`、`chat` 相同的表格策略：小表格直接终端渲染，大表格输出终端预览，并附带 `~/.db-chat-cli/tmp/` 下的 HTML 地址和对应 CSV 地址。
如果成功执行的语句改变了表结构，例如 `CREATE TABLE`、`ALTER TABLE`、`DROP TABLE` 或 `RENAME TABLE`，CLI 会保留 SQL 执行结果，并提醒你在依赖 schema 搜索结果前手动运行 `dbchat catalog sync`。

### 查看执行计划

```bash
node dist/index.js explain "select * from orders where created_at >= now() - interval '7 day'"
```

### 查看 Schema

```bash
node dist/index.js schema
node dist/index.js schema --count
node dist/index.js schema --table orders
```

默认情况下，schema summary 只列出表名。
如果你需要实时行数，请传入 `--count`，CLI 会在展示前对每张表执行实时 `COUNT(*)`。

查看具体表时，CLI 会优先显示 `CREATE TABLE ...` 风格的 DDL 预览，而不是纯文本列说明。
对于 MySQL，会优先使用数据库原生的 `SHOW CREATE TABLE` 输出。
对于 PostgreSQL，目前展示的是根据 system catalogs 重建出的 DDL，因为 PostgreSQL 不会原样存储最初的 `CREATE TABLE` 文本。

### 构建或刷新本地 Schema Catalog

```bash
node dist/index.js catalog sync
node dist/index.js catalog search "用户表"
```

`catalog sync` 是 schema 变更后手动重建本地 catalog 的方式。
它会直接基于数据库里的真实 schema 元数据，以及当前目标命中的 `global/host/database` instruction 分层内容重建本地 snapshot。
在这个重建过程中，如果当前可见表对应的 `tables/<table>.md` 缺失，也会一起补齐为空白文件；已经存在的表级 md 不会被覆盖。

`catalog search` 会基于合并后的本地 catalog 执行 BM25 风格检索，不会调用 embedding API。
如果多个候选表分数接近，agent 会先要求用户确认具体指的是哪张表，再继续依赖该表生成 SQL 或执行操作。
如果配置了 embedding，catalog 重建会直接向外部 embedding API 发送合并后的 schema 元数据，不再额外弹确认提示。

### 查看当前配置

```bash
node dist/index.js config show
node dist/index.js config embedding update
```

`config show` 会同时打印做过脱敏的“已保存配置”和“最终解析后的运行时配置”。
这也是确认 shell 环境变量或项目 `.env` 是否真正生效的最直接方式。

### 管理已保存的数据库 Host 和 Database

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

对于 `update`、`remove`、`use` 命令，名称参数是可选的；省略时 CLI 会打开方向键选择菜单。
对于 `config db use-database`，选择菜单会查询目标 host 的实时数据库列表，并在需要时把选中的数据库保存到本地配置中。
如果你给同一台服务器的不同端口重复使用同一个 host 配置名，`dbchat` 会自动把保存时的名称调整成唯一值，通常会补成 `-<port>` 后缀。

## 测试

使用开发脚本时，请在 `--` 后面传入 CLI 命令。

```bash
pnpm run dev -- init
pnpm run dev -- config show
pnpm run dev -- sql "select 1"
pnpm run dev -- schema
pnpm run dev -- catalog sync
pnpm run dev -- catalog search "用户表"
pnpm run dev -- ask "show the tables in this database"
pnpm run dev -- chat
```

如果只运行 `pnpm run dev` 而不附带额外命令，CLI 会打印帮助并退出。

也可以运行轻量级回归测试：

```bash
pnpm test
```

### 推荐的冒烟测试顺序

1. 初始化配置

```bash
pnpm run dev -- init
```

2. 验证已保存的配置

```bash
pnpm run dev -- config show
```

3. 测试数据库连通性

```bash
pnpm run dev -- sql "select 1"
```

4. 测试 schema 查看

```bash
pnpm run dev -- schema
```

5. 构建本地 schema catalog

```bash
pnpm run dev -- catalog sync
```

6. 验证本地 schema 搜索

```bash
pnpm run dev -- catalog search "用户表"
```

7. 测试 LLM 工具循环

```bash
pnpm run dev -- ask "show me the top 10 rows from users"
```

8. 测试交互式聊天

```bash
pnpm run dev -- chat
```

### 测试变更语句

下面这条命令应当在执行前触发确认提示：

```bash
pnpm run dev -- sql "create table test_cli(id int)"
```

### 测试构建产物

也可以直接验证编译后的 CLI：

```bash
pnpm build
node dist/index.js init
node dist/index.js config show
node dist/index.js sql "select 1"
```

## REPL Slash Commands

- `/help`
- `/schema [table] [--count]`
- `/plan`
- `/clear` 清空当前会话和屏幕
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

在 Ink 聊天 UI 中，输入 `/` 会打开 slash-command 建议列表。
使用 Up/Down 选择命令，使用 `Tab` 或 `Enter` 自动补全。
输入 `@` 会打开当前 host 的实时数据库选择器。
使用 Up/Down 选择数据库，使用 `Tab` 或 `Enter` 切换。
`/schema` 默认只列出表名；如果你明确需要实时行数，请使用 `/schema --count`。

## 当前实现说明

- SQL 执行路径分为 `read-only`、`DML`、`DDL` 和 `unclassified`。
- 当前运行时访问级别始终是 `read-only`、`select+insert+update`、`select+insert+update+delete`、`select+insert+update+delete+ddl` 之一，但不会写入配置文件。
- 超出当前数据库访问级别的语句会在审批前直接被拦截。
- 允许执行的 DML、DDL 和未分类 SQL 都必须经过显式审批：`Approve Once`、`Approve All For Turn`、`Reject`。
- 同一时间只允许执行一条 SQL 语句。
- CLI 只会在进入某个数据库目标时初始化本地 schema catalog；之后默认复用已有 snapshot，后续刷新由显式的 `catalog sync` 完成。
- schema catalog 在同一 scope 下保存一个 `catalog.json` 本地 snapshot。
- `catalog sync` 会根据数据库里的真实 schema 信息重建本地 snapshot，并构建表级、字段级、关系级检索文档。
- 本地 schema 搜索默认是基于这些合并文档的 BM25 风格词项检索；embedding 只是同步阶段生成的可选增强，不是检索前提。
- `catalog search` 默认完全在本地执行，不会把查询文本发送到远程 API。
- 当 schema 搜索出现多个高分近似候选时，agent 会先要求用户澄清，再依赖某一张表继续执行。
- 模型可以先搜索本地 schema catalog，再决定加载哪张表的定义。
- 对于依赖当前表集合的破坏性 schema 操作，模型可以直接从活动数据库连接验证实时表名，而不只是依赖本地 schema catalog。
- 查询结果在生成浏览器查看用的 HTML 结果页时，会自动同时生成同批缓存行的 CSV 文件。
- `app.resultRowLimit` 用于限制查询后缓存到内存中的行数；导出最后一次查询结果时导出的也是这个缓存切片。
- `ask` 和 `chat` 中，如果只读 `SELECT` 没有显式行数限制，工具层会基于 `app.previewRowLimit` 自动补一个默认 `LIMIT`，除非用户明确表达了完整结果或导出意图。
- `app.tableRendering.inlineRowLimit` 和 `app.tableRendering.inlineColumnLimit` 用于决定缓存结果是否可以直接完整渲染到终端。
- 对于更大的缓存结果，CLI 只在终端展示前 `app.tableRendering.previewRowLimit` 行，并额外生成位于 `~/.db-chat-cli/tmp/` 的 HTML 结果页和对应 CSV 文件。
- 显式的 agent 导出工具现在只负责 `JSON` 导出；CSV 会随着 HTML 结果页一起自动生成。
- CLI 启动时会清理工作目录临时区中超过 `app.tempArtifactRetentionDays` 的 HTML 和导出产物；默认值是 3 天，也可以通过 `.env` 中的 `DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS` 覆盖。
- `app.contextCompression.recentRawTurns` 控制多少个最近 turn 会保留完整原始历史。
- `app.contextCompression.rawHistoryChars` 限制单次 LLM 请求可携带的原始历史字符预算。
- 超过 `app.contextCompression.largeToolOutputChars` 的工具结果不会直接内联到模型上下文中，而是保存为带 `persistedOutputId` 的外部内容，模型可在后续通过 `inspect_history_entry` 再读取。
- `app.contextCompression.maxToolCallsPerTurn` 限制单个用户请求最多可执行多少次工具调用。
- `app.contextCompression.maxAgentIterations` 限制单个用户请求最多可进行多少轮 LLM 往返。
- 如果模型已经通过 `render_last_result` 渲染过缓存 SQL 结果，最终回答会保留这些终端表格页，而不是退化成纯文字总结。
- 数据库驱动采用惰性加载，避免非数据库命令启动时做不必要初始化。
- CLI 同时支持 OpenAI-compatible tool calling 和 Anthropic tool calling。
- 数据库配置支持多个 host 和每个 host 下多个 database，并支持通过 CLI 命令和实时数据库发现进行切换。
- 非交互式终端命令默认保持紧凑输出，而 `chat` 保留更丰富的交互反馈。
- 聊天会话会压缩较早的 turn，仅保留少量最近的原始窗口，并在需要时把历史上下文打包进后续请求。

## 后续方向

- SQLite / SQL Server
- session history and resume
- stronger SQL linting and heuristics
- finer-grained approval policies
