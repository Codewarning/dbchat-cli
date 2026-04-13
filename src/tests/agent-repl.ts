import assert from "node:assert/strict";
import { buildArchivedTurnSummary, createConversationTurn, createSessionContextMemory, mergeRollingSummary } from "../agent/memory.js";
import { buildSessionMessages } from "../agent/message-builder.js";
import { isPlanResolved } from "../agent/plan.js";
import { buildContextPrompt, buildSystemPrompt } from "../agent/prompts.js";
import { classifyUserRequestExecutionIntent } from "../agent/session.js";
import { buildContextPromptProfile, compactAssistantContentForHistory } from "../agent/session-policy.js";
import { selectNextComposerHistoryEntry, selectPreviousComposerHistoryEntry } from "../repl/input-history.js";
import { parseSchemaCommandArgs, parseSlashCommand } from "../repl/slash-commands.js";
import { findCatalogTable, suggestCatalogTableNames } from "../schema/catalog.js";
import { RunTest, createTestConfig } from "./support.js";

export async function registerAgentAndReplTests(runTest: RunTest): Promise<void> {
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

    assert.match(prompt, /Session cache availability:/);
    assert.match(prompt, /last query result cached: yes/i);
    assert.match(prompt, /last explain cached: yes/i);
    assert.match(prompt, /schema memory cached: yes/i);
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

  await runTest("assistant history content is compacted before it is archived", () => {
    const original = "Detailed answer. ".repeat(80);
    const compacted = compactAssistantContentForHistory(original);
    assert.ok(compacted.length < original.length);
    assert.match(compacted, /\.\.\.$/);
  });

  await runTest("archived turn summary prioritizes outcomes over raw tool calls", () => {
    const turn = createConversationTurn("show top users");
    turn.summaryLines.push("Request intent: read_only_results");
    turn.summaryLines.push('Tool call: search_schema_catalog {"query":"users"}');
    turn.summaryLines.push('Schema catalog search: 2 matches for "users". Top matches: users.');
    turn.summaryLines.push('Tool call: run_sql {"sql":"select * from users limit 5"}');
    turn.summaryLines.push("SQL executed: SELECT returned 5 rows in 3.00ms. Fields: id, email.");
    turn.summaryLines.push("Final answer: I queried the users table and returned 5 rows.");

    const summary = buildArchivedTurnSummary(turn);
    assert.match(summary, /User request:/);
    assert.match(summary, /SQL executed: SELECT returned 5 rows/i);
    assert.match(summary, /Final answer:/);
    assert.doesNotMatch(summary, /Tool call:/);
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
    assert.match(prompt, /prefer showing a compact plain-text table preview/i);
    assert.match(prompt, /stop searching and explicitly say that the current schema likely does not contain that concept/i);
  });
}
