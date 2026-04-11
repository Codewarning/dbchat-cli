# dbchat-cli

[English](./README.md) | 简体中文

`dbchat-cli` 是一个面向数据库的命令行助手，基于 `Node.js + TypeScript + pnpm` 构建。

它支持以下自然语言工作流：

- 查询数据
- 生成 SQL
- 分析查询结果
- 导出查询结果
- 分析 SQL 执行计划
- 在显式批准后执行允许的变更 SQL，并受当前数据库访问级别限制

复杂任务应先创建计划，再分步执行。

## 设计

- 详细设计文档：[docs/design.md](./docs/design.md)
- 架构图：[docs/architecture-diagrams.md](./docs/architecture-diagrams.md)

## 技术栈

- Node.js 20+
- TypeScript
- pnpm
- 用于交互式聊天模式的 React Ink 终端 UI
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

之后你就可以运行：

```bash
dbchat --help
```

如果后续修改了源代码，需要重新构建并重新链接：

```bash
pnpm build
pnpm link --global
```

卸载全局链接：

```bash
pnpm unlink --global dbchat-cli
```

另一种方式是：

```bash
pnpm add -g .
```

对于本地迭代开发，通常更推荐使用 `pnpm link --global`。

## 初始化配置

```bash
node dist/index.js init
```

交互式初始化现在支持选择 LLM Provider 预设：

- OpenAI GPT
- Claude / Anthropic
- DeepSeek
- Custom

对于每个预设，CLI 都会预填默认的 `base URL` 和 `model`，你也可以手动覆盖。
交互式初始化现在使用方向键菜单来选择 provider、dialect、yes-no，以及端口、schema、行数限制、base URL、model 等常用值。需要时你仍然可以输入自定义值。
数据库 host 和 database 条目不会持久化存储 SQL 访问预设。
运行时访问级别会在 `chat` 中切换数据库时选择，启动默认值始终为 `Read only`。

数据库配置现在会存储：

- 一个活动 host 配置
- 该 host 下的一个活动数据库
- 任意多个额外的 host 配置和数据库名，后续可通过 `config db` 命令管理

配置文件存储在：

```text
~/.db-chat-cli/config.json
```

当某个基于 embedding 的工作流第一次真正需要时，CLI 会确保本地 GGUF embedding 模型存在于：

```text
~/.db-chat-cli/models/
```

如果模型不存在，会自动下载，并在终端显示进度条。
如果下载失败，CLI 会删除临时文件；下一次尝试时会从零重新下载。
在 Ink 聊天 UI 中，同样的下载会显示在 `Active tasks` 面板中，并带有实时字节进度，而不是直接写到 stdout。
如果设置了 `EMBEDDING_MODEL_URL`，下载会使用这个地址。
否则 CLI 会先尝试这个主地址：

```text
https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf
```

如果主地址失败，CLI 会重试这个地址：

```text
https://hf-mirror.com/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-q8_0.gguf
```

刷新本地 schema catalog 时，CLI 会使用已配置的 LLM 和本地 embedding 模型，为每张表补充：

- 英文描述
- 搜索标签
- 持久化 embedding 向量

未变化的表会复用已有的语义索引，这个索引用于 `dbchat catalog search`、`ask` 和 `chat` 中的快速表检索。

因此，`dbchat catalog sync` 依赖可用的 LLM 配置、本地 embedding 模型以及数据库连接。
catalog 会存储在 `~/.db-chat-cli/schema-catalog/` 下，按 dialect、host-port、database 分层目录组织，每个 schema target 对应一个 JSON 文件。
`ask` 和 `chat` 不再在会话启动前强制刷新 schema catalog。
只有当真正使用到 schema-catalog 工具时，才会检查 catalog；若其缺失、过期或与当前 embedding 模型不兼容，才会重建。

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
- `EMBEDDING_MODEL_URL`
- `DBCHAT_RESULT_ROW_LIMIT`
- `DBCHAT_PREVIEW_ROW_LIMIT`
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

交互式聊天会话在每次 LLM 回复后都会继续保持开启，只有在你输入 `/exit` 或主动终止进程时才会退出。
当 `chat` 运行在 TTY 终端中时，会使用 React Ink 界面，并提供：

- 位于对话顶部的 Codex 风格欢迎区，后续聊天内容会追加在其下方
- 带边框的运行时信息面板，显示当前 model 和活动数据库目标
- 简洁的 `>` 输入区，以及内联提示，而不是盒状输入框
- 在 Ink 聊天 UI 中输入 `/...` 时显示 slash-command 自动补全下拉列表
- 在 Ink 聊天 UI 中输入 `@...` 时显示实时数据库切换下拉列表
- 用于显示用户输入、工具/日志输出和最终回答的滚动时间线
- 长时间任务的内联 loading 面板
- 用于 SQL 批准以及 `/host`、`/database` 配置流程的模态确认、输入和选择提示

如果本地 Ink 运行时无法在当前环境初始化，`chat` 会自动回退到普通 readline REPL，以保证命令仍可使用。

在 REPL 中，你还可以通过 `/host ...` 和 `/database ...` 管理已保存的 host 和 database。
当你通过 `/database use`、`/host use` 或 `@` 选择器切换数据库时，CLI 会提示你为当前运行时选择数据库操作访问级别。该选择不会持久化，默认始终为 `Read only`。
当所选数据库已存在于保存的配置中时，`@` 选择器现在会复用其已保存的 schema，而不是再通过当前数据库 schema 做启发式回退。
如果 REPL 中的活动数据库目标发生变化，CLI 会重新连接、清空当前会话，并清空终端显示，以免旧上下文与新数据库会话混在一起。
如果切换后活动数据库目标没有变化，只是重新加载连接细节或访问策略，则会保留当前会话。
`/clear` slash command 现在会同时清空内存中的会话状态和当前终端聊天界面。
当一个 turn 结束后，已完成、已跳过或已取消的执行计划会从活动会话上下文中清除，避免下一次请求顶部重复出现旧计划。

### 一次性自然语言请求

```bash
node dist/index.js ask "Show the order volume trend for the last 7 days"
node dist/index.js ask "Analyze this SQL for performance and suggest improvements"
```

### 直接执行 SQL

```bash
node dist/index.js sql "select * from users limit 10"
```

只读 SQL 会立即执行。
若当前数据库访问级别允许，DML、DDL 和未分类 SQL 都会触发带有三个选项的批准提示：`Approve Once`、`Approve All For Turn` 或 `Reject`。
如果当前数据库访问级别不允许该语句，CLI 会在打开批准提示之前直接拒绝执行。
如果成功执行的语句会改变表结构，例如 `CREATE TABLE`、`ALTER TABLE`、`DROP TABLE` 或 `RENAME TABLE`，CLI 现在会在执行后自动刷新本地 schema catalog。

### 查看执行计划

```bash
node dist/index.js explain "select * from orders where created_at >= now() - interval '7 day'"
```

### 查看 Schema

```bash
node dist/index.js schema
node dist/index.js schema --table orders
```

当你查看某张具体表时，CLI 现在会优先显示 `CREATE TABLE ...` 风格的 DDL 预览，而不是纯列信息说明。
对于 MySQL，会优先使用数据库原生的 `SHOW CREATE TABLE` 输出。
对于 PostgreSQL，目前展示的是根据 system catalogs 重建出的 DDL，因为 PostgreSQL 不会原样存储最初的 `CREATE TABLE` 文本。

### 构建或刷新本地 Schema Catalog

```bash
node dist/index.js catalog sync
node dist/index.js catalog search "order items"
```

### 查看当前配置

```bash
node dist/index.js config show
```

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

对于 `update/remove/use` 命令，name 参数是可选的；如果省略，CLI 会打开方向键选择菜单。
对于 `config db use-database`，选择菜单会查询目标 host 上的实时数据库列表；如果选中的数据库之前未保存，会自动保存到本地配置中。
已保存的数据库条目现在只保留连接标识信息，例如 host、database name 和可选 schema。
运行时 SQL 访问权限是在 `chat` 中切换时选择的，不会写入配置文件。
如果数据库命令省略了 `--host`，CLI 也会在需要时让你交互式选择 host。
这些 host/database 管理操作在 `chat` 模式下也可以通过 slash command 完成。
当 `chat` 运行在 TTY 终端中时，这些 slash command 选择同样使用方向键菜单。

## 测试

使用开发脚本时，请在 `--` 后面传入 CLI 命令。

```bash
pnpm run dev -- init
pnpm run dev -- config show
pnpm run dev -- sql "select 1"
pnpm run dev -- schema
pnpm run dev -- catalog sync
pnpm run dev -- ask "show the tables in this database"
pnpm run dev -- chat
```

如果你只运行 `pnpm run dev` 而不附带额外命令，CLI 会打印帮助并退出。

你也可以运行轻量级回归检查：

```bash
pnpm test
```

### 推荐的冒烟测试顺序

1. 初始化配置

```bash
pnpm run dev -- init
```

2. 验证保存后的配置

```bash
pnpm run dev -- config show
```

3. 测试数据库直连

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

6. 测试 LLM 工具循环

```bash
pnpm run dev -- ask "show me the top 10 rows from users"
```

7. 测试交互式聊天会话

```bash
pnpm run dev -- chat
```

### 测试变更语句

下面这条命令应当会在执行前触发确认提示：

```bash
pnpm run dev -- sql "create table test_cli(id int)"
```

### 测试构建产物

你也可以直接验证编译后的 CLI：

```bash
pnpm build
node dist/index.js init
node dist/index.js config show
node dist/index.js sql "select 1"
```

### 调试器提示说明

如果你的终端显示 `Debugger attached.` 或 `Waiting for the debugger to disconnect...` 之类的信息，通常是终端或编辑器环境本身导致的，而不是 CLI 输出的。在这种情况下，请按上面示例继续使用明确的子命令进行测试。

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

在 Ink 聊天 UI 中，输入 `/` 会打开 slash-command 建议列表。使用 Up/Down 选择命令，用 `Tab` 或 `Enter` 自动补全。
输入 `@` 会打开当前 host 的实时数据库选择器。使用 Up/Down 选择数据库，用 `Tab` 或 `Enter` 切换。

## 当前实现说明

- SQL 执行路径分为 `read-only`、`DML`、`DDL` 和 `unclassified`。
- 当前运行时访问预设始终是 `read-only`、`select+insert+update`、`select+insert+update+delete` 或 `select+insert+update+delete+ddl` 之一，但不会存储到配置文件中。
- 超出当前数据库访问级别的语句会在批准环节之前直接被拦截。
- 被允许的 DML、DDL 和未分类 SQL 都必须经过显式批准：`Approve Once`、`Approve All For Turn`、`Reject`。
- 同一时间只允许执行一条 SQL 语句。
- CLI 现在会在 schema-catalog 工具真正需要时才加载或重建本地 schema catalog，而不是在每次 `ask` 或 `chat` 启动前强制执行这一步。
- 模型可以先搜索本地 schema catalog，再决定加载哪张表的定义。
- 对于依赖当前表集合的破坏性 schema 操作，模型可以直接从活动数据库连接验证实时表名，而不只是依赖本地 schema catalog。
- 查询结果可以导出为 `JSON` 或 `CSV`。
- `app.resultRowLimit` 用于限制查询后缓存到内存中的行数，导出最后结果时导出的也是这个缓存切片。
- 数据库驱动采用懒加载，因此非数据库命令启动时不必初始化所有驱动。
- CLI 同时支持 OpenAI-compatible tool calling 和 Anthropic tool calling。
- 数据库配置支持多个 host 配置，以及每个 host 下多个数据库名；CLI 命令和 `use-database` 中的实时数据库发现都支持活动 host/database 切换。
- 非交互式终端命令默认保持紧凑进度输出，而 `chat` 会保留更丰富的交互反馈。
- 聊天会话会将较早的 turn 压缩成结构化摘要，只保留少量最近的原始窗口，以控制 token 使用量。
- 返回给模型的工具结果是压缩后的 payload，而不是完整原始 JSON。

## 下一步

- SQLite / SQL Server
- session history and resume
- stronger SQL linting and heuristics
- finer-grained approval policies
