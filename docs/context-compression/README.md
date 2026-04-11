# 上下文压缩设计说明

本文档整理 `dbchat-cli` 当前已经落地的上下文压缩业务逻辑与算法实现，重点说明：

- 为什么需要压缩
- 压缩发生在哪些层
- 各层如何控制 token/上下文规模
- 当前实现的关键数据结构、预算参数与执行流程

本文描述的是当前代码实现，不是未来方案草图。对应实现主要位于：

- `src/agent/session.ts`
- `src/agent/memory.ts`
- `src/agent/prompts.ts`
- `src/tools/model-payload.ts`

## 1. 背景与目标

在自然语言数据库助手场景里，token 消耗主要来自三类信息：

1. 长会话中的历史消息反复重放
2. schema、查询结果、explain 结果等工具返回的原始大对象
3. 多轮 follow-up 时对旧结果的重复携带

如果不做压缩，随着 REPL 对话变长，每一轮发给模型的上下文都会不断线性增长，最终带来：

- token 成本上升
- 响应变慢
- 旧信息“挤占”当前任务的有效上下文
- 工具返回的大 JSON 容易稀释真正重要的操作信息

当前实现的目标不是“无限记忆”，而是：

- 保留当前任务真正需要的上下文
- 丢弃或压缩历史的低价值细节
- 将结果集、schema、plan 等大对象改为“结构化摘要 + 少量预览”
- 让长会话的 prompt 大小保持在一个近似稳定的范围内

## 2. 总体思路

当前实现采用的是分层压缩，而不是单一摘要器。

压缩一共发生在三层：

1. 会话层压缩
   把旧 turn 从原始消息压成摘要，只保留最近少量原始 turn。
2. 工具结果压缩
   工具执行后，不把完整结果原样喂给模型，而是先转成紧凑载荷。
3. Prompt 组装压缩
   构建上下文时，对压缩记忆、最新结果预览、schema/query memory 再做一次预算控制。

这三层的职责不同：

- 会话层解决“历史消息无限增长”
- 工具层解决“单次工具结果过大”
- Prompt 层解决“即使有摘要，也不能无限拼接”

## 3. 核心数据结构

### 3.1 ConversationTurn

定义在 `src/agent/memory.ts`。

```ts
interface ConversationTurn {
  messages: LlmMessageParam[];
  summaryLines: string[];
}
```

含义：

- `messages`
  当前 turn 的原始消息，包括 user、assistant、tool。
- `summaryLines`
  当前 turn 的摘要线索，用于 turn 完成后的归档压缩。

每个新用户请求都会创建一个新的 `ConversationTurn`。

### 3.2 SessionContextMemory

定义在 `src/agent/memory.ts`。

```ts
interface SessionContextMemory {
  rollingSummary: string;
  archivedTurnSummaries: string[];
  lastSchemaSummary: string | null;
  describedTables: NamedSummary[];
  recentQueries: string[];
  lastExplainSummary: string | null;
  lastExportSummary: string | null;
}
```

这是长会话压缩后的“结构化记忆层”，其作用是替代无限增长的原始 history。

各字段含义：

- `rollingSummary`
  更老的历史摘要总表。超出归档窗口的摘要会继续合并到这里。
- `archivedTurnSummaries`
  最近一批已经归档的 turn 摘要。
- `lastSchemaSummary`
  最近一次 schema summary 的摘要。
- `describedTables`
  最近查看过的表结构摘要，按表名去重。
- `recentQueries`
  最近执行过的 SQL 摘要列表。
- `lastExplainSummary`
  最近一次 explain 的摘要。
- `lastExportSummary`
  最近一次导出的摘要。

### 3.3 最近原始窗口 + 压缩记忆

当前设计不是“只保留摘要”，而是“两层并存”：

- 最近原始窗口：保留少量完整 turn，保证当前任务细节不丢
- 压缩记忆：保留旧 turn 的结构化摘要，保证 follow-up 还能接得上

这比纯摘要更稳，因为模型在当前任务尚未结束时仍然能看到完整原始上下文。

## 4. 会话层压缩算法

### 4.1 turn 的建立

每次用户调用 `session.run(input)` 时：

1. 创建一个新的 `ConversationTurn`
2. 把用户原始输入放入 `messages`
3. 同时生成一条初始摘要：

```text
User request: ...
```

### 4.2 turn 内摘要累积

在一个 turn 执行过程中，会持续向 `summaryLines` 追加摘要信息：

- tool call 摘要
- tool result 摘要
- final answer 摘要

例如一个 turn 可能积累成：

```text
User request: show top 10 users
Tool call: get_schema_summary {}
Schema summary loaded: 12 tables. Preview: users(8), orders(15)
Tool call: run_sql {"sql":"select ..."}
SQL executed: SELECT returned 10 rows in 12.31ms
Final answer: I inspected the schema and ran ...
```

### 4.3 turn 归档

turn 完成后会进入 `completedTurns`。

如果 `completedTurns.length` 超过最近原始窗口上限，则触发归档压缩：

1. 取出最老的 completed turn
2. 将其 `summaryLines` 合并成一个字符串
3. 写入 `archivedTurnSummaries`
4. 如果 `archivedTurnSummaries` 也超过上限，则继续合并进 `rollingSummary`

### 4.4 最近原始窗口选择算法

当前不是简单“固定保留最后 N 条 message”，而是按 turn 和预算一起控制。

算法逻辑：

1. 从最新 turn 开始倒序扫描
2. 估算每个 turn 的大小
3. 只要未超出原始历史预算，就把该 turn 保留
4. 至少保留最新一个 turn

这样做的好处是：

- 不会把一个 turn 截断到只剩一半
- 当前任务的完整链路更容易保留
- 对多工具回合更稳定

### 4.5 当前会话层预算参数

定义在 `src/agent/memory.ts`：

- `MAX_RECENT_RAW_TURNS = 2`
  最多保留 2 个完整原始 turn
- `MAX_ARCHIVED_TURN_SUMMARIES = 6`
  最多保留 6 条已归档 turn 摘要
- `MAX_RAW_HISTORY_CHARS = 7000`
  最近原始消息窗口的字符预算
- `MAX_ROLLING_SUMMARY_CHARS = 2400`
  最老摘要总表的字符上限
- `MAX_TURN_SUMMARY_CHARS = 480`
  单个 turn 摘要上限
- `MAX_MEMORY_ENTRY_CHARS = 320`
  单条 memory entry 的字符上限

注意：

- 这里使用的是字符预算，而不是 tokenizer 精确 token 预算
- 这是有意的工程折中，优点是实现简单、跨 provider 稳定、无需额外依赖

## 5. 工具结果压缩算法

工具结果压缩由 `src/tools/model-payload.ts` 完成。

核心原则：

- 本地业务层可以保留完整对象
- 模型可见层只拿紧凑结果

也就是说：

- `lastResult` 仍然保留完整查询结果，供导出和本地状态使用
- 但写回模型 history 的内容，不再是完整 `rows` / `rawPlan`

### 5.1 通用压缩方法

工具层主要使用几类通用函数：

- `clipText`
  截断长字符串
- `clipMiddle`
  从中间裁剪，保留头尾
- `takeItemsByCharBudget`
  在字符预算内保留尽可能多的列表项
- `compactValue`
  递归压缩对象/数组/字符串
- `stringifyCompact`
  使用紧凑 JSON 序列化，避免 pretty-print 空白

### 5.2 `run_sql` 压缩

`run_sql` 是最关键的压缩点，因为查询结果最容易失控。

当前策略：

- 不再把完整 `rows` 原样发给模型
- 仅保留：
  - `status`
  - `reason`
  - `sql`
  - `operation`
  - `rowCount`
  - `fields`
  - `elapsedMs`
  - `previewRows`
  - `previewTruncated`

其中：

- `previewRows` 只取预览行
- 每一行还会再次经过 `compactValue`

当前工具层 SQL 结果预算：

- `MAX_SQL_CHARS = 800`
- `MAX_MODEL_PREVIEW_ROWS = 5`

### 5.3 `get_schema_summary` 压缩

schema summary 不传完整表列表对象，而是传：

- `tableCount`
- `tablesPreview`
- `omittedTableCount`

也就是说，模型知道：

- 一共有多少张表
- 其中最重要的一小批表名和列数
- 还有多少张未展示

### 5.4 `describe_table` 压缩

表结构不传完整 column object 数组，而是传：

- `tableName`
- `columnsPreview`
- `omittedColumnCount`

这让模型能拿到：

- 表名
- 列数量
- 若干列的名称、类型、nullable/default 预览

### 5.5 `explain_sql` 压缩

执行计划通常是非常大的嵌套 JSON，因此当前只传：

- `sql`
- `operation`
- `elapsedMs`
- `warnings`
- `planPreview`

其中 `planPreview` 是对 `rawPlan` 做字符串化后再中间裁剪的结果。

这意味着模型能看到：

- explain 是针对哪条 SQL
- 执行计划的大致结构片段
- 风险警告

但不会被整个巨大 JSON 淹没。

### 5.6 `update_plan` / `export_last_result` 压缩

这两类结果本身不大，但仍然统一走紧凑化流程：

- `update_plan`
  保留 plan 项的 `id/content/status`
- `export_last_result`
  保留 `format/outputPath/rowCount`

这样工具结果格式更加一致，便于长期维护。

## 6. Prompt 组装压缩算法

Prompt 组装在 `src/agent/prompts.ts`。

最终上下文不是单一字符串拼出来的，而是分块组装：

1. `system prompt`
2. `context prompt`
3. `recent raw messages`

### 6.1 context prompt 的组成

`buildContextPrompt()` 当前会按顺序加入：

1. 当前 plan
2. 压缩后的会话历史
3. schema memory
4. recent query memory
5. latest query result summary

这意味着旧历史不再通过大量原始消息重放，而是通过结构化 memory 进入 prompt。

### 6.2 历史摘要预算控制

针对 `archivedTurnSummaries`，会做二次控制：

- 只取最近的一部分摘要
- 受字符预算限制
- 再受展示条数限制

当前参数：

- `MAX_ARCHIVED_TURNS_IN_PROMPT = 4`
- `MAX_ARCHIVED_TURN_CHARS = 1800`

这表示：

- 即使归档摘要缓存里有更多内容，也不会全部塞进当前 prompt
- prompt 里只会出现最近且预算内的一小部分历史摘要

### 6.3 schema/query memory 预算控制

当前参数：

- `MAX_SCHEMA_MEMORY_CHARS = 1600`
- `MAX_QUERY_MEMORY_CHARS = 1600`

作用：

- schema memory 不会无限增长
- recent query / explain / export memory 也不会无限增长

### 6.4 latest result 二次压缩

即使 session 内部保留了完整 `lastResult`，放进 prompt 时仍然只带：

- `sql`
- `operation`
- `rowCount`
- `fields`
- `previewRows`

并且：

- `previewRows` 只取很小的一部分
- 行内字段还会再次走 `compactValue`

当前参数：

- `MAX_LAST_RESULT_PREVIEW_ROWS = 3`
- `MAX_VALUE_CHARS = 80`

## 7. 完整执行流程

下面用一次典型 ask/chat 请求说明全链路。

### 7.1 用户输入进入 session

1. 用户输入自然语言请求
2. 创建一个新的 `ConversationTurn`
3. 把用户消息写入 turn 原始消息
4. 同时生成第一条摘要

### 7.2 构建 prompt

1. 加入固定 system prompt
2. 加入当前 plan
3. 加入压缩后的 conversation memory
4. 加入 schema/query memory
5. 加入 latest result summary
6. 加入最近原始 turn

### 7.3 模型发起 tool call

1. assistant message 先进入当前 turn
2. tool call 也会被记录成摘要线索

### 7.4 执行工具

1. tool registry 执行业务逻辑
2. 本地状态保留完整数据
3. `serializeToolResultForModel()` 生成紧凑 payload
4. 紧凑 payload 写回模型可见 history
5. 同时把摘要写入 turn summary 和结构化 session memory

### 7.5 turn 完成

1. final answer 进入 turn
2. 追加 final summary
3. turn 转入 `completedTurns`
4. 如果超出最近原始窗口，则归档压缩旧 turn

## 8. 关键业务规则

### 8.1 压缩不能破坏业务能力

压缩后仍然要保证：

- follow-up query 能继续基于最近结果工作
- `export_last_result` 仍然能导出完整结果
- plan 仍然能持续更新
- schema follow-up 仍然知道最近看过哪些表

因此当前设计明确区分：

- 本地业务状态
- 模型可见上下文

两者不是同一个对象。

### 8.2 结构化记忆优先于自由文本摘要

当前没有把所有历史都扔给一个 LLM 摘要器，而是优先保存结构化 memory：

- `describedTables`
- `recentQueries`
- `lastExplainSummary`
- `lastExportSummary`

这样可以减少“摘要漂移”。

### 8.3 至少保留最新完整 turn

最近原始消息窗口选择时，至少保留最新一个 turn。

原因是：

- 当前任务最怕被截断
- 比起“保留更多旧摘要”，最新完整链路更重要

### 8.4 工具结果摘要和 session memory 复用

工具层返回的 `summary` 不只是展示文本，它还会被 session memory 直接复用。

这让系统具备两个优点：

- 压缩逻辑集中在工具层
- session memory 不需要重复理解一遍完整业务对象

## 9. 当前限制与取舍

### 9.1 使用字符预算，不是精确 token 预算

优点：

- 简单
- 无需 tokenizer 依赖
- 跨 OpenAI-compatible / Anthropic-compatible 一致

限制：

- 只是近似控制，不是绝对 token 上限

### 9.2 explain 仍然只保留字符串预览

当前 `rawPlan` 没有做“按节点结构化摘取”，只是裁剪后的预览字符串。

优点：

- 实现简单
- 立即有效

限制：

- 对超大 explain JSON 的语义提炼还不够精细

### 9.3 schema memory 只保留最近少量对象

当前保留的是：

- 最近 schema summary
- 最近若干张 describe 过的表

这足够支撑多数 follow-up，但不等于永久保留完整 schema 知识。

## 10. 后续可演进方向

如果后续要进一步增强，可以沿下面几个方向演进：

### 10.1 引入更精确的 token 预算器

当前是字符预算，未来可替换成 tokenizer 估算或 provider-aware token estimator。

### 10.2 引入 artifact handle 机制

即：

- 工具结果完整对象保存在本地 artifact store
- history 中只保留 artifact id + 摘要
- 模型需要更多细节时，再通过工具按需读取局部数据

这会进一步降低超大结果集带来的上下文压力。

### 10.3 explain 结构化摘要

未来可以对 explain JSON 做更细的结构抽取，例如：

- 节点类型
- 预计扫描行数
- 是否全表扫描
- 关键 filter / join / sort 节点

### 10.4 基于任务类型的动态预算

当前预算是固定常量。

未来可以按任务动态调整，例如：

- schema inspection 场景提高 schema memory 预算
- explain 场景提高 plan preview 预算
- export 场景提高 latest result summary 预算

## 11. 一句话总结

当前上下文压缩实现的核心不是“把所有历史压成一段文本”，而是：

- 用 turn 级压缩控制历史消息增长
- 用结构化 memory 保存真正有价值的状态
- 用紧凑 tool payload 控制大对象进入模型
- 用 prompt 分块预算控制最终上下文规模

这样做的结果是：

- 长会话不会无限膨胀
- follow-up 能力仍然保留
- 导出、plan、schema、SQL 执行这些业务能力不会因压缩被破坏
