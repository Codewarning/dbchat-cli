import assert from "node:assert/strict";
import { AgentSession } from "../agent/session.js";
import { SessionHistoryStore } from "../agent/history-store.js";
import { buildArchivedTurnSummary, createConversationTurn, createSessionContextMemory, mergeRollingSummary } from "../agent/memory.js";
import { buildSessionMessages } from "../agent/message-builder.js";
import { isPlanResolved } from "../agent/plan.js";
import { buildContextPrompt, buildSystemPrompt } from "../agent/prompts.js";
import { classifyUserRequestExecutionIntent } from "../agent/session.js";
import { buildContextPromptProfile, compactAssistantContentForHistory } from "../agent/session-policy.js";
import { selectNextComposerHistoryEntry, selectPreviousComposerHistoryEntry } from "../repl/input-history.js";
import { parseSchemaCommandArgs, parseSlashCommand } from "../repl/slash-commands.js";
import { findCatalogTable, suggestCatalogTableNames } from "../schema/catalog.js";
import { RunTest, createDatabaseStub, createTestConfig, createTestIo } from "./support.js";

export async function registerAgentAndReplTests(runTest: RunTest): Promise<void> {
  await runTest("failed agent turns are discarded before the next request starts", async () => {
    const session = new AgentSession(createTestConfig(), createDatabaseStub(), createTestIo());
    (session as unknown as { llm: { complete: () => Promise<never> } }).llm = {
      async complete() {
        throw new Error("boom");
      },
    };

    await assert.rejects(() => session.run("show users"), /boom/);
    const history = (session as unknown as { history: SessionHistoryStore }).history;
    assert.equal(history.getCurrentTurn(), null);

    await assert.rejects(() => session.run("show orders"), /boom/);
    assert.equal(history.getCurrentTurn(), null);
    assert.equal(history.getRecentCompletedTurns().length, 0);
  });

  await runTest("request intent classification prefers actual results for Chinese query wording", () => {
    assert.equal(classifyUserRequestExecutionIntent("查询用户信息及其分组数、标签数、书签数"), "read_only_results");
    assert.equal(classifyUserRequestExecutionIntent("只生成 SQL，不要执行"), "sql_only");
    assert.equal(classifyUserRequestExecutionIntent("help me with this database"), "neutral");
  });

  await runTest("standalone requests keep context packing minimal", () => {
    const profile = buildContextPromptProfile("show top 10 users by signup date", {
      hasPlan: false,
      hasLastResult: true,
      hasSchemaMemory: true,
      hasRecentQueryMemory: true,
      hasLastExplainSummary: true,
      hasLastExportSummary: true,
    });

    assert.equal(profile.kind, "fresh_query");
    assert.equal(profile.includePriorRawTurns, false);
    assert.equal(profile.includeArchivedConversation, false);
    assert.equal(profile.includeLastSchemaSummary, false);
    assert.equal(profile.includeDescribedTables, false);
    assert.equal(profile.includeRecentQueryMemory, false);
    assert.equal(profile.includeLastExplainSummary, false);
    assert.equal(profile.includeLastExportSummary, false);
    assert.equal(profile.includeLastResultSummary, false);
    assert.equal(profile.includeLastResultTablePreview, false);
  });

  await runTest("follow-up requests keep relevant result context", () => {
    const profile = buildContextPromptProfile("export that result to csv", {
      hasPlan: false,
      hasLastResult: true,
      hasSchemaMemory: true,
      hasRecentQueryMemory: true,
      hasLastExplainSummary: true,
      hasLastExportSummary: true,
    });

    assert.equal(profile.kind, "export_follow_up");
    assert.equal(profile.includePriorRawTurns, true);
    assert.equal(profile.includeArchivedConversation, true);
    assert.equal(profile.includeRecentQueryMemory, true);
    assert.equal(profile.includeLastExportSummary, true);
    assert.equal(profile.includeLastResultSummary, true);
    assert.equal(profile.includeLastResultTablePreview, false);
  });

  await runTest("schema requests keep schema memory without dragging query memory", () => {
    const profile = buildContextPromptProfile("describe table users", {
      hasPlan: false,
      hasLastResult: true,
      hasSchemaMemory: true,
      hasRecentQueryMemory: true,
      hasLastExplainSummary: true,
      hasLastExportSummary: true,
    });

    assert.equal(profile.kind, "fresh_schema");
    assert.equal(profile.includeLastSchemaSummary, true);
    assert.equal(profile.includeDescribedTables, true);
    assert.equal(profile.includeRecentQueryMemory, false);
    assert.equal(profile.includeLastResultSummary, false);
  });

  await runTest("explain follow-up keeps explain memory without result preview", () => {
    const profile = buildContextPromptProfile("why did that plan use a seq scan", {
      hasPlan: false,
      hasLastResult: true,
      hasSchemaMemory: true,
      hasRecentQueryMemory: true,
      hasLastExplainSummary: true,
      hasLastExportSummary: false,
    });

    assert.equal(profile.kind, "explain_follow_up");
    assert.equal(profile.includeLastExplainSummary, true);
    assert.equal(profile.includeLastResultSummary, false);
    assert.equal(profile.includeLastResultTablePreview, false);
  });

  await runTest("context prompt always exposes cache availability as a language-agnostic fallback", () => {
    const memory = createSessionContextMemory();
    memory.lastSchemaSummary = "Schema summary loaded: 3 tables.";
    memory.lastExplainSummary = "Explain completed for SELECT in 5.00ms.";
    const profile = buildContextPromptProfile("consulta eso otra vez", {
      hasPlan: false,
      hasLastResult: true,
      hasSchemaMemory: true,
      hasRecentQueryMemory: false,
      hasLastExplainSummary: true,
      hasLastExportSummary: false,
    });

    const prompt = buildContextPrompt(
      [],
      {
        sql: "select * from users",
        operation: "SELECT",
        rowCount: 3,
        rows: [{ id: 1, email: "a@example.com" }],
        rowsTruncated: false,
        fields: ["id", "email"],
        elapsedMs: 4,
      },
      memory,
      profile,
    );

    assert.match(prompt, /Attached session caches:/);
    assert.match(prompt, /result=yes/i);
    assert.match(prompt, /explain=yes/i);
    assert.match(prompt, /schema=yes/i);
    assert.match(prompt, /Use attached summaries first\./i);
  });

  await runTest("latest result summaries keep datetime values as readable strings", () => {
    const prompt = buildContextPrompt(
      [],
      {
        sql: "select created_at from orders limit 1",
        operation: "SELECT",
        rowCount: 1,
        rows: [{ created_at: new Date("2024-01-02T03:04:05.000Z") }],
        rowsTruncated: false,
        fields: ["created_at"],
        elapsedMs: 4,
      },
      createSessionContextMemory(),
      {
        kind: "result_follow_up",
        includePriorRawTurns: true,
        includeArchivedConversation: false,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: true,
        includeLastResultTablePreview: true,
      },
    );

    assert.match(prompt, /2024-01-02 03:04:05 UTC/);
    assert.doesNotMatch(prompt, /\{\}/);
  });

  await runTest("latest result summaries expand scientific notation and preserve bigint values", () => {
    const prompt = buildContextPrompt(
      [],
      {
        sql: "select total_cents, ratio from metrics limit 1",
        operation: "SELECT",
        rowCount: 1,
        rows: [{ total_cents: 12345678901234567890n, ratio: 1.23e-7 }],
        rowsTruncated: false,
        fields: ["total_cents", "ratio"],
        elapsedMs: 4,
      },
      createSessionContextMemory(),
      {
        kind: "result_follow_up",
        includePriorRawTurns: true,
        includeArchivedConversation: false,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: true,
        includeLastResultTablePreview: true,
      },
    );

    assert.match(prompt, /12345678901234567890/);
    assert.match(prompt, /0.000000123/);
    assert.doesNotMatch(prompt, /e-7/i);
  });

  await runTest("message builder can skip prior raw turns for standalone requests", () => {
    const previousTurn = createConversationTurn("show users");
    previousTurn.messages.push({
      role: "assistant",
      content: "Previous answer with old rows.",
    });
    const currentTurn = createConversationTurn("show top 10 orders");

    const messages = buildSessionMessages(
      createTestConfig(),
      [],
      null,
      createSessionContextMemory(),
      [previousTurn],
      currentTurn,
      "show top 10 orders",
    );

    assert.equal(messages.some((message) => message.role === "assistant" && message.content === "Previous answer with old rows."), false);
    assert.equal(messages.some((message) => message.role === "user" && message.content === "show top 10 orders"), true);
  });

  await runTest("message builder keeps prior raw turns for follow-up requests", () => {
    const previousTurn = createConversationTurn("show users");
    previousTurn.messages.push({
      role: "assistant",
      content: "Previous answer with old rows.",
    });
    const currentTurn = createConversationTurn("export that result");

    const messages = buildSessionMessages(
      createTestConfig(),
      [],
      {
        sql: "select * from users",
        operation: "SELECT",
        rowCount: 3,
        rows: [{ id: 1, email: "a@example.com" }],
        rowsTruncated: false,
        fields: ["id", "email"],
        elapsedMs: 4,
      },
      createSessionContextMemory(),
      [previousTurn],
      currentTurn,
      "export that result",
    );

    assert.equal(messages.some((message) => message.role === "assistant" && message.content === "Previous answer with old rows."), true);
  });

  await runTest("message builder obeys the configured raw history character budget", () => {
    const config = createTestConfig();
    config.app.contextCompression.rawHistoryChars = 40;
    const previousTurn = createConversationTurn("show users");
    previousTurn.messages.push({
      role: "assistant",
      content: "Previous answer with a long history payload that should not fit.",
    });
    const currentTurn = createConversationTurn("export that result");

    const messages = buildSessionMessages(
      config,
      [],
      {
        sql: "select * from users",
        operation: "SELECT",
        rowCount: 3,
        rows: [{ id: 1, email: "a@example.com" }],
        rowsTruncated: false,
        fields: ["id", "email"],
        elapsedMs: 4,
      },
      createSessionContextMemory(),
      [previousTurn],
      currentTurn,
      "export that result",
    );

    assert.equal(messages.some((message) => message.role === "assistant" && message.content === "Previous answer with a long history payload that should not fit."), false);
  });

  await runTest("archived context prompt discourages unnecessary history inspection", () => {
    const memory = createSessionContextMemory();
    memory.archivedTurnSummaries.push("Turn ID: turn-2\nUser request: previous report\nFinal answer: Returned a report.");
    const prompt = buildContextPrompt(
      [],
      null,
      memory,
      {
        kind: "general_follow_up",
        includePriorRawTurns: true,
        includeArchivedConversation: true,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      },
    );

    assert.match(prompt, /Compressed conversation memory:/);
    assert.match(prompt, /Use this attached summary first\./i);
    assert.match(prompt, /Inspect a specific Turn ID or persistedOutputId only when exact omitted detail is necessary\./i);
  });

  await runTest("assistant history content is compacted before it is archived", () => {
    const original = "Detailed answer. ".repeat(80);
    const compacted = compactAssistantContentForHistory(original);
    assert.ok(compacted.length < original.length);
    assert.match(compacted, /\.\.\.$/);
  });

  await runTest("archived turn summary prioritizes outcomes over raw tool calls", () => {
    const turn = createConversationTurn("show top users");
    turn.summaryLines.push("Request intent: read_only_results");
    turn.summaryLines.push("Persisted tool output: tool-output-1 from inspect_last_explain (4800 chars).");
    turn.summaryLines.push('Tool call: search_schema_catalog {"query":"users"}');
    turn.summaryLines.push('Schema catalog search: 2 matches for "users". Top matches: users.');
    turn.summaryLines.push('Tool call: run_sql {"sql":"select * from users limit 5"}');
    turn.summaryLines.push("SQL executed: SELECT returned 5 rows in 3.00ms. Fields: id, email.");
    turn.summaryLines.push("Final answer: I queried the users table and returned 5 rows.");

    const summary = buildArchivedTurnSummary(turn);
    assert.match(summary, /Turn ID:/);
    assert.match(summary, /tool-output-1/);
    assert.match(summary, /User request:/);
    assert.match(summary, /SQL executed: SELECT returned 5 rows/i);
    assert.match(summary, /Final answer:/);
    assert.doesNotMatch(summary, /Tool call:/);
  });

  await runTest("completed turn compression uses the configured recent raw turn limit", () => {
    const recentRawTurnLimit = { value: 1 };
    const history = new SessionHistoryStore(() => recentRawTurnLimit.value);
    history.startTurn("show users");
    history.finalizeCurrentTurn("Returned users.");
    history.startTurn("show orders");
    history.finalizeCurrentTurn("Returned orders.");

    const completedTurns = history.getRecentCompletedTurns();
    const sessionMemory = history.getSessionMemory();
    assert.equal(completedTurns.length, 1);
    assert.equal(completedTurns[0]?.id, "turn-2");
    assert.match(sessionMemory.archivedTurnSummaries[0] ?? "", /turn-1/);
  });

  await runTest("rolling summary keeps whole newest entries instead of a raw suffix", () => {
    const merged = mergeRollingSummary(
      Array.from({ length: 8 }, (_value, index) => `Older archived summary ${index}: ${"detail ".repeat(40)}`).join("\n\n"),
      ["Newest archived summary: users query completed successfully."],
    );

    assert.match(merged, /Newest archived summary:/);
    assert.match(merged, /Older context was truncated\./);
  });

  await runTest("catalog helpers resolve exact tables and suggest similar names", () => {
    const catalog = {
      version: 5,
      dialect: "postgres" as const,
      host: "localhost",
      port: 5432,
      database: "testdb",
      schema: "public",
      generatedAt: new Date().toISOString(),
      tableCount: 4,
      embeddingModelId: "embedding-model",
      tables: [
        {
          tableName: "sys_user",
          schemaHash: "a",
          summaryText: "users table",
          description: "Stores users.",
          tags: ["user", "account", "auth"],
          embeddingText: "sys_user",
          embeddingVector: [0.1, 0.2],
          columns: [
            { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
            { name: "email", dataType: "text", isNullable: false, defaultValue: null },
          ],
        },
        {
          tableName: "bm_group",
          schemaHash: "b",
          summaryText: "groups table",
          description: "Stores groups.",
          tags: ["group", "bookmark", "sharing"],
          embeddingText: "bm_group",
          embeddingVector: [0.2, 0.1],
          columns: [{ name: "user_id", dataType: "integer", isNullable: false, defaultValue: null }],
        },
        {
          tableName: "bm_tag",
          schemaHash: "c",
          summaryText: "tags table",
          description: "Stores tags.",
          tags: ["tag", "bookmark", "label"],
          embeddingText: "bm_tag",
          embeddingVector: [0.2, 0.2],
          columns: [{ name: "user_id", dataType: "integer", isNullable: false, defaultValue: null }],
        },
        {
          tableName: "bm_bookmark",
          schemaHash: "d",
          summaryText: "bookmarks table",
          description: "Stores bookmarks.",
          tags: ["bookmark", "link", "save"],
          embeddingText: "bm_bookmark",
          embeddingVector: [0.3, 0.1],
          columns: [{ name: "user_id", dataType: "integer", isNullable: false, defaultValue: null }],
        },
      ],
    };

    assert.equal(findCatalogTable(catalog, "SYS_USER")?.tableName, "sys_user");
    assert.equal(findCatalogTable(catalog, "bm_user"), null);
    assert.deepEqual(suggestCatalogTableNames(catalog, "bm_user", 3), ["sys_user", "bm_bookmark", "bm_group"]);
  });

  await runTest("composer history navigation walks backward and forward to empty input", () => {
    const initialState = {
      entries: ["show users", "count orders", "top customers"],
      index: null,
      value: "",
    };

    const previous = selectPreviousComposerHistoryEntry(initialState);
    assert.equal(previous.index, 2);
    assert.equal(previous.value, "top customers");

    const oldest = selectPreviousComposerHistoryEntry(selectPreviousComposerHistoryEntry(previous));
    assert.equal(oldest.index, 0);
    assert.equal(oldest.value, "show users");

    const next = selectNextComposerHistoryEntry(oldest);
    assert.equal(next.index, 1);
    assert.equal(next.value, "count orders");

    const backToEmpty = selectNextComposerHistoryEntry(selectNextComposerHistoryEntry(next));
    assert.equal(backToEmpty.index, null);
    assert.equal(backToEmpty.value, "");
  });

  await runTest("schema slash arguments treat --count as a flag instead of a table name", () => {
    assert.deepEqual(parseSchemaCommandArgs(["--count"]), {
      tableName: undefined,
      includeRowCount: true,
    });
    assert.deepEqual(parseSchemaCommandArgs(["users", "--count"]), {
      tableName: "users",
      includeRowCount: true,
    });
    assert.throws(() => parseSchemaCommandArgs(["users", "roles"]), /Usage: \/schema \[table\] \[--count\]/i);
  });

  await runTest("parsed slash schema command treats the action token as schema args", () => {
    const fromFlagOnly = parseSlashCommand("/schema --count");
    assert.equal(fromFlagOnly.command, "schema");
    assert.equal(fromFlagOnly.action, "--count");
    assert.deepEqual(parseSchemaCommandArgs(fromFlagOnly.action ? [fromFlagOnly.action, ...fromFlagOnly.args] : fromFlagOnly.args), {
      tableName: undefined,
      includeRowCount: true,
    });

    const fromTableAndFlag = parseSlashCommand("/schema users --count");
    assert.equal(fromTableAndFlag.command, "schema");
    assert.equal(fromTableAndFlag.action, "users");
    assert.deepEqual(
      parseSchemaCommandArgs(fromTableAndFlag.action ? [fromTableAndFlag.action, ...fromTableAndFlag.args] : fromTableAndFlag.args),
      {
        tableName: "users",
        includeRowCount: true,
      },
    );
  });

  await runTest("terminal plans are recognized as clearable", () => {
    assert.equal(
      isPlanResolved([
        { id: "inspect", content: "Inspect schema", status: "completed" },
        { id: "query", content: "Run query", status: "completed" },
      ]),
      true,
    );
    assert.equal(
      isPlanResolved([
        { id: "inspect", content: "Inspect schema", status: "completed" },
        { id: "delete", content: "Delete stale tables", status: "skipped" },
        { id: "export", content: "Export result", status: "cancelled" },
      ]),
      true,
    );
    assert.equal(isPlanResolved([{ id: "inspect", content: "Inspect schema", status: "in_progress" }]), false);
    assert.equal(isPlanResolved([{ id: "inspect", content: "Inspect schema", status: "pending" }]), false);
    assert.equal(isPlanResolved([]), false);
  });

  await runTest("system prompt allows plain-text tables for query results", () => {
    const prompt = buildSystemPrompt(createTestConfig());
    assert.match(prompt, /plain monospace text tables/i);
    assert.match(prompt, /prefer a compact plain-text table preview over prose alone/i);
    assert.match(prompt, /stop searching and explicitly say the current schema likely does not contain it/i);
    assert.match(prompt, /Do not repeatedly inspect the same history item without a new reason/i);
    assert.match(prompt, /date, datetime, timestamp, or time values, preserve them as readable strings/i);
    assert.match(prompt, /bigint, decimal, numeric, or scientific-notation values, preserve readable exact strings or expanded decimals/i);
    assert.match(prompt, /call render_last_result and reuse its rendered table text instead of manually formatting rows yourself/i);
    assert.match(prompt, /Infer the user's requested visible row limit from the request or the SQL LIMIT when it is explicit/i);
    assert.match(prompt, /If the query returned no more than that requested visible limit, prefer one render_last_result call with that limit instead of splitting the output/i);
    assert.match(prompt, /render_last_result renders up to 100 rows per call/i);
    assert.match(prompt, /Only paginate with multiple render_last_result calls when the user needs more than 100 visible rows/i);
  });
}
