import assert from "node:assert/strict";
import { AgentSession } from "../agent/session.js";
import { SessionHistoryStore } from "../agent/history-store.js";
import { buildArchivedTurnSummary, createConversationTurn, createSessionContextMemory, mergeRollingSummary } from "../agent/memory.js";
import { buildSessionMessages } from "../agent/message-builder.js";
import { isPlanResolved } from "../agent/plan.js";
import { buildContextPrompt, buildSystemPrompt } from "../agent/prompts.js";
import { classifyUserRequestExecutionIntent } from "../agent/session.js";
import { buildContextPromptProfile, buildFinalAgentContent, compactAssistantContentForHistory } from "../agent/session-policy.js";
import { resolveStructuredEntryTable } from "../repl/chat-entry-view.js";
import { selectNextComposerHistoryEntry, selectPreviousComposerHistoryEntry } from "../repl/input-history.js";
import { parseSchemaCommandArgs, parseSlashCommand } from "../repl/slash-commands.js";
import { findCatalogTable, suggestCatalogTableNames } from "../schema/catalog.js";
import { formatRecordsTable } from "../ui/text-table.js";
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

  await runTest("agent session skips duplicate render_last_result calls for the same cached slice", async () => {
    const logs: string[] = [];
    const io = {
      ...createTestIo(),
      log(message: string) {
        logs.push(message);
      },
    };
    const session = new AgentSession(createTestConfig(), createDatabaseStub(), io);
    (session as unknown as { lastResult: NonNullable<ReturnType<AgentSession["getLastResult"]>> }).lastResult = {
      sql: "select id, email, created_time, updated_time, enabled from sys_user where deleted = false order by updated_time desc limit 10",
      operation: "SELECT",
      rowCount: 4,
      rows: [
        { id: 1, email: "a@example.com", created_time: "2026-04-01 10:00:00", updated_time: "2026-04-17 10:00:00", enabled: true },
        { id: 2, email: "b@example.com", created_time: "2026-04-02 10:00:00", updated_time: "2026-04-16 10:00:00", enabled: true },
        { id: 3, email: "c@example.com", created_time: "2026-04-03 10:00:00", updated_time: "2026-04-15 10:00:00", enabled: false },
        { id: 4, email: "d@example.com", created_time: "2026-04-04 10:00:00", updated_time: "2026-04-14 10:00:00", enabled: true },
      ],
      rowsTruncated: false,
      fields: ["id", "email", "created_time", "updated_time", "enabled"],
      elapsedMs: 5,
    };

    let completionCalls = 0;
    (session as unknown as { llm: { complete: () => Promise<unknown> } }).llm = {
      async complete() {
        completionCalls += 1;
        if (completionCalls === 1) {
          return {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "render_last_result",
                  arguments: JSON.stringify({ offset: 0, limit: 4 }),
                },
              },
            ],
          };
        }

        if (completionCalls === 2) {
          return {
            content: null,
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "render_last_result",
                  arguments: JSON.stringify({ offset: 0, limit: 4 }),
                },
              },
            ],
          };
        }

        return {
          content: "The latest users are already shown in the terminal preview.",
        };
      },
    };

    const result = await session.run("查询最近更新的用户信息");

    assert.equal(completionCalls, 3);
    assert.equal(result.displayBlocks.length, 1);
    assert.match(result.content, /already shown in the terminal preview/i);
    assert.equal(logs.filter((line) => /Rendering cached result rows 1-4/.test(line)).length, 1);
  });

  await runTest("agent session drops stale result previews after a later SQL result replaces them", async () => {
    const session = new AgentSession(
      createTestConfig(),
      createDatabaseStub({
        async execute(sql) {
          if (/select content_type from cs_cms_content_article/i.test(sql)) {
            return {
              sql,
              operation: "SELECT",
              rowCount: 1,
              rows: [{ content_type: "html" }],
              rowsTruncated: false,
              fields: ["content_type"],
              elapsedMs: 2,
            };
          }

          if (/select article_id, title, content_type from cs_cms_content_article/i.test(sql)) {
            return {
              sql,
              operation: "SELECT",
              rowCount: 2,
              rows: [
                { article_id: 842945, title: "Winter storage wisdom", content_type: "html" },
                { article_id: 842972, title: "Morning frost flowers", content_type: "html" },
              ],
              rowsTruncated: false,
              fields: ["article_id", "title", "content_type"],
              elapsedMs: 3,
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      }),
      createTestIo(),
    );

    let completionCalls = 0;
    (session as unknown as { llm: { complete: () => Promise<unknown> } }).llm = {
      async complete() {
        completionCalls += 1;
        switch (completionCalls) {
          case 1:
            return {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "run_sql",
                    arguments: JSON.stringify({
                      sql: "select content_type from cs_cms_content_article where content_type = 'html' limit 1",
                      reason: "Verify the stored article content type.",
                    }),
                  },
                },
              ],
            };
          case 2:
            return {
              content: null,
              tool_calls: [
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "render_last_result",
                    arguments: JSON.stringify({ offset: 0, limit: 1 }),
                  },
                },
              ],
            };
          case 3:
            return {
              content: null,
              tool_calls: [
                {
                  id: "call_3",
                  type: "function",
                  function: {
                    name: "run_sql",
                    arguments: JSON.stringify({
                      sql: "select article_id, title, content_type from cs_cms_content_article where content_type = 'html' order by article_id limit 2",
                      reason: "Load the actual html articles to answer the user.",
                    }),
                  },
                },
              ],
            };
          case 4:
            return {
              content: null,
              tool_calls: [
                {
                  id: "call_4",
                  type: "function",
                  function: {
                    name: "render_last_result",
                    arguments: JSON.stringify({ offset: 0, limit: 2 }),
                  },
                },
              ],
            };
          default:
            return {
              content: "I found html articles and showed the final result preview.",
            };
        }
      },
    };

    const result = await session.run("show html article content");

    assert.equal(result.displayBlocks.length, 1);
    assert.match(result.displayBlocks[0]?.body ?? "", /SQL result rows 1-2 of 2:/);
    assert.match(result.displayBlocks[0]?.body ?? "", /article_id/);
    assert.doesNotMatch(result.displayBlocks[0]?.body ?? "", /SQL result rows 1-1 of 1:/);
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

  await runTest("latest result summaries expose artifact availability without leaking file URLs", () => {
    const prompt = buildContextPrompt(
      [],
      {
        sql: "select id, email from users limit 2",
        operation: "SELECT",
        rowCount: 2,
        rows: [
          { id: 1, email: "a@example.com" },
          { id: 2, email: "b@example.com" },
        ],
        rowsTruncated: false,
        fields: ["id", "email"],
        elapsedMs: 4,
        htmlArtifact: {
          outputPath: "/tmp/dbchat/result.html",
          fileUrl: "file:///tmp/dbchat/result.html",
          csvOutputPath: "/tmp/dbchat/result.csv",
          csvFileUrl: "file:///tmp/dbchat/result.csv",
          generatedAt: "2026-04-16T00:00:00.000Z",
          cachedRowCount: 2,
          rowCount: 2,
          fieldCount: 2,
        },
      },
      createSessionContextMemory(),
      {
        kind: "export_follow_up",
        includePriorRawTurns: true,
        includeArchivedConversation: false,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: true,
        includeLastResultTablePreview: false,
      },
    );

    assert.match(prompt, /"htmlArtifactAvailable":true/);
    assert.doesNotMatch(prompt, /file:\/\/\/tmp\/dbchat\/result\.html/);
    assert.doesNotMatch(prompt, /file:\/\/\/tmp\/dbchat\/result\.csv/);
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

  await runTest("final agent output appends rendered result tables when the assistant only returns a prose summary", () => {
    const finalContent = buildFinalAgentContent({
      responseContent: "Query completed. Returned the latest rows from users.",
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [
        { role: "user", content: "show users" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "SQL result rows 1-2 of 2:\nid | email\n---+----------------\n1  | a@example.com\n2  | b@example.com",
        },
      ],
      lastResult: null,
      appConfig: createTestConfig().app,
    });

    assert.match(finalContent, /Query completed\./);
    assert.match(finalContent, /SQL result rows 1-2 of 2:/);
    assert.match(finalContent, /a@example\.com/);
  });

  await runTest("final agent output preserves assistant-authored markdown tables", () => {
    const finalContent = buildFinalAgentContent({
      responseContent:
        "Found the latest rows from users:\n\n| id | email |\n| --- | --- |\n| 1 | a@example.com |\n| 2 | b@example.com |",
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [
        { role: "user", content: "show users" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "SQL result rows 1-2 of 2:\nid | email\n---+----------------\n1  | a@example.com\n2  | b@example.com",
        },
      ],
      lastResult: null,
      appConfig: createTestConfig().app,
    });

    assert.match(finalContent, /\| id \| email \|/);
    assert.doesNotMatch(finalContent, /SQL result rows 1-2 of 2:/);
  });

  await runTest("final agent output strips assistant-authored markdown result tables when a rendered preview will be shown separately", () => {
    const finalContent = buildFinalAgentContent({
      responseContent: [
        "Query completed. Here is a quick preview:",
        "",
        "| id | email |",
        "| --- | --- |",
        "| 1 | a@example.com |",
        "| 2 | b@example.com |",
        "",
        "Open the preview block below for the program-rendered rows.",
      ].join("\n"),
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [{ role: "user", content: "show users" }],
      lastResult: {
        sql: "select id, email from users limit 2",
        operation: "SELECT",
        rowCount: 2,
        rows: [
          { id: 1, email: "a@example.com" },
          { id: 2, email: "b@example.com" },
        ],
        rowsTruncated: false,
        fields: ["id", "email"],
        elapsedMs: 3,
      },
      appConfig: createTestConfig().app,
      displayBlocks: [
        {
          kind: "result_table",
          title: "Result Preview",
          body: "SQL result rows 1-2 of 2:\nid | email\n---+----------------\n1  | a@example.com\n2  | b@example.com",
        },
      ],
    });

    assert.match(finalContent, /Query completed/i);
    assert.match(finalContent, /program-rendered rows/i);
    assert.doesNotMatch(finalContent, /\| id \| email \|/);
    assert.doesNotMatch(finalContent, /\| 1 \| a@example\.com \|/);
  });


  await runTest("final agent output no longer re-adds artifact address lines when the assistant copied only the table body", () => {
    const finalContent = buildFinalAgentContent({
      responseContent:
        "已查询最近七天创建的订单数据，共找到100条记录。以下是部分结果预览：\n\nid | email\n---+----------------\n1  | a@example.com",
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [
        { role: "user", content: "show users" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content:
            "SQL result rows 1-1 of 1:\nid | email\n---+----------------\n1  | a@example.com\nOpen full table in a browser: file:///tmp/dbchat/result.html\nHTML file: /tmp/dbchat/result.html\nOpen the same cached rows as CSV: file:///tmp/dbchat/result.csv\nCSV file: /tmp/dbchat/result.csv\nMore cached rows are available. Open the HTML view for the full cached result or call render_last_result with offset=10 to continue.",
        },
      ],
      lastResult: null,
      appConfig: createTestConfig().app,
    });

    assert.match(finalContent, /a@example\.com/);
    assert.doesNotMatch(finalContent, /Open full table in a browser:/);
    assert.doesNotMatch(finalContent, /Open the same cached rows as CSV:/);
    assert.doesNotMatch(finalContent, /^HTML file:/m);
    assert.doesNotMatch(finalContent, /^CSV file:/m);
    assert.match(finalContent, /More cached rows are available/i);
  });

  await runTest("final agent output does not duplicate artifact links when the assistant already referenced them", () => {
    const finalContent = buildFinalAgentContent({
      responseContent:
        "id | email\n---+----------------\n1  | a@example.com\n\n完整结果已缓存，可通过以下链接查看：\nHTML 视图: file:///C:/tmp/dbchat/result.html\nCSV 文件: C:\\tmp\\dbchat\\result.csv",
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [
        { role: "user", content: "show users" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content:
            "SQL result rows 1-1 of 1:\nid | email\n---+----------------\n1  | a@example.com\nOpen full table in a browser: file:///C:/tmp/dbchat/result.html\nHTML file: C:\\tmp\\dbchat\\result.html\nOpen the same cached rows as CSV: file:///C:/tmp/dbchat/result.csv\nCSV file: C:\\tmp\\dbchat\\result.csv\nMore cached rows are available. Open the HTML view for the full cached result or call render_last_result with offset=10 to continue.",
        },
      ],
      lastResult: null,
      appConfig: createTestConfig().app,
    });

    assert.doesNotMatch(finalContent, /file:\/\/\/C:\/tmp\/dbchat\/result\.html/);
    assert.doesNotMatch(finalContent, /C:\\tmp\\dbchat\\result\.csv/);
    assert.doesNotMatch(finalContent, /Open full table in a browser:/);
    assert.doesNotMatch(finalContent, /Open the same cached rows as CSV:/);
    assert.doesNotMatch(finalContent, /^HTML file:/m);
    assert.doesNotMatch(finalContent, /^CSV file:/m);
  });

  await runTest("final agent output strips markdown artifact links instead of exposing file paths", () => {
    const finalContent = buildFinalAgentContent({
      responseContent:
        "查询执行成功，结果已缓存。您可以点击以下链接查看完整结果：\n[HTML 视图](file:///C:/tmp/dbchat/result.html)\n[CSV 文件](file:///C:/tmp/dbchat/result.csv)",
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [
        { role: "user", content: "show users" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content:
            "SQL result rows 1-1 of 1:\nid | email\n---+----------------\n1  | a@example.com\nOpen full table in a browser: file:///C:/tmp/dbchat/result.html\nHTML file: C:\\tmp\\dbchat\\result.html\nOpen the same cached rows as CSV: file:///C:/tmp/dbchat/result.csv\nCSV file: C:\\tmp\\dbchat\\result.csv\nMore cached rows are available. Open the HTML view for the full cached result or call render_last_result with offset=10 to continue.",
        },
      ],
      lastResult: null,
      appConfig: createTestConfig().app,
    });

    assert.doesNotMatch(finalContent, /file:\/\/\/C:\/tmp\/dbchat\/result\.html/);
    assert.doesNotMatch(finalContent, /file:\/\/\/C:\/tmp\/dbchat\/result\.csv/);
    assert.doesNotMatch(finalContent, /\[HTML 视图\]\(/);
    assert.doesNotMatch(finalContent, /Open full table in a browser:/);
  });

  await runTest("final agent output keeps prose only when a result preview will be shown separately", () => {
    const finalContent = buildFinalAgentContent({
      responseContent: "Query completed.",
      lastToolFailure: null,
      toolCallsThisTurn: 1,
      currentTurnMessages: [{ role: "user", content: "show users" }],
      lastResult: {
        sql: "select id, email from users limit 2",
        operation: "SELECT",
        rowCount: 2,
        rows: [
          { id: 1, email: "a@example.com" },
          { id: 2, email: "b@example.com" },
        ],
        rowsTruncated: false,
        fields: ["id", "email"],
        elapsedMs: 3,
        autoAppliedReadOnlyLimit: 2,
      },
      appConfig: createTestConfig().app,
    });

    assert.match(finalContent, /Query completed\./);
    assert.doesNotMatch(finalContent, /SQL result rows 1-2 of 2:/);
    assert.doesNotMatch(finalContent, /a@example\.com/);
  });

  await runTest("final agent output no longer embeds wide fallback result tables", () => {
    const finalContent = buildFinalAgentContent({
      responseContent: "Query completed.",
      lastToolFailure: null,
      toolCallsThisTurn: 1,
      currentTurnMessages: [{ role: "user", content: "show schedule info" }],
      lastResult: {
        sql: "select ... from schedule_info limit 1",
        operation: "SELECT",
        rowCount: 1,
        rows: [
          {
            id: 1,
            shop_id: 2,
            open_user_id: "u-1",
            open_user_name: "Alice",
            open_user_phone: "1234567890",
            group_id: 3,
            task_id: "task-1",
            order_status: 1,
            merchant_code: "DOMINO",
            work_date: "2026-04-16",
            rest: false,
            create_at: "2026-04-16 10:00:00",
            update_at: "2026-04-16 10:05:00",
          },
        ],
        rowsTruncated: false,
        fields: [
          "id",
          "shop_id",
          "open_user_id",
          "open_user_name",
          "open_user_phone",
          "group_id",
          "task_id",
          "order_status",
          "merchant_code",
          "work_date",
          "rest",
          "create_at",
          "update_at",
        ],
        elapsedMs: 3,
      },
      appConfig: createTestConfig().app,
    });

    assert.equal(finalContent, "Query completed.");
  });

  await runTest("final agent output strips manual field:value rows when a rendered preview will be shown separately", () => {
    const finalContent = buildFinalAgentContent({
      responseContent: [
        "I queried the most-visited bookmark. Result below:",
        "id: 1",
        "title: Home",
        "url: https://example.com",
        "visit_count: 1234",
        "",
        "This bookmark currently has the highest visit count.",
      ].join("\n"),
      lastToolFailure: null,
      toolCallsThisTurn: 2,
      currentTurnMessages: [{ role: "user", content: "show the most-visited bookmark" }],
      lastResult: {
        sql: "select id, title, url, visit_count from bm_bookmark order by visit_count desc limit 1",
        operation: "SELECT",
        rowCount: 1,
        rows: [{ id: 2014690613985214466n, title: "docker-compose部署完整java应用", url: "https://blog.example", visit_count: 4 }],
        rowsTruncated: false,
        fields: ["id", "title", "url", "visit_count"],
        elapsedMs: 3,
      },
      appConfig: createTestConfig().app,
      displayBlocks: [
        {
          kind: "result_table",
          title: "Result Preview",
          body: "SQL result rows 1-1 of 1:\nid | title | url | visit_count\n---+---+---+---\n2014690613985214466 | docker-compose部署完整java应用 | https://blog.example | 4",
        },
      ],
    });

    assert.match(finalContent, /I queried the most-visited bookmark/i);
    assert.match(finalContent, /highest visit count/i);
    assert.doesNotMatch(finalContent, /^id:/m);
    assert.doesNotMatch(finalContent, /^title:/m);
    assert.doesNotMatch(finalContent, /^url:/m);
    assert.doesNotMatch(finalContent, /^visit_count:/m);
  });

  await runTest("assistant preview entries resolve structured tables before plain assistant text rendering", () => {
    const fields = ["id", "title", "created_by", "updated_by", "deleted"];
    const rows = [
      {
        id: 1,
        title: "home",
        created_by: "system",
        updated_by: "system",
        deleted: false,
      },
    ];
    const entry = {
      id: "entry-1",
      title: "Result Preview",
      body: [
        "SQL result rows 1-1 of 1:",
        "Showing 5 of 15 columns in the terminal preview. Open the HTML view for all columns.",
        formatRecordsTable(rows, fields),
      ].join("\n"),
      tone: "assistant" as const,
      meta: {
        table: {
          fields,
          rows,
        },
      },
    };

    const structuredTable = resolveStructuredEntryTable(entry);
    assert.ok(structuredTable);
    assert.deepEqual(structuredTable?.fields, fields);
    assert.deepEqual(structuredTable?.rows, rows);
    assert.deepEqual(structuredTable?.beforeLines, [
      "SQL result rows 1-1 of 1:",
      "Showing 5 of 15 columns in the terminal preview. Open the HTML view for all columns.",
    ]);
    assert.deepEqual(structuredTable?.afterLines, []);
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
      version: 9,
      dialect: "postgres" as const,
      host: "localhost",
      port: 5432,
      database: "testdb",
      schema: "public",
      generatedAt: new Date().toISOString(),
      tableCount: 4,
      documentCount: 0,
      instructionFingerprint: null,
      embeddingModelId: "embedding-model",
      tables: [
        {
          tableName: "sys_user",
          schemaHash: "a",
          summaryText: "users table",
          instructionContext: undefined,
          description: "Stores users.",
          tags: ["user", "account", "auth"],
          aliases: [],
          examples: [],
          embeddingText: "sys_user",
          embeddingVector: [0.1, 0.2],
          columns: [
            { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
            { name: "email", dataType: "text", isNullable: false, defaultValue: null },
          ],
          relations: [],
        },
        {
          tableName: "bm_group",
          schemaHash: "b",
          summaryText: "groups table",
          instructionContext: undefined,
          description: "Stores groups.",
          tags: ["group", "bookmark", "sharing"],
          aliases: [],
          examples: [],
          embeddingText: "bm_group",
          embeddingVector: [0.2, 0.1],
          columns: [{ name: "user_id", dataType: "integer", isNullable: false, defaultValue: null }],
          relations: [],
        },
        {
          tableName: "bm_tag",
          schemaHash: "c",
          summaryText: "tags table",
          instructionContext: undefined,
          description: "Stores tags.",
          tags: ["tag", "bookmark", "label"],
          aliases: [],
          examples: [],
          embeddingText: "bm_tag",
          embeddingVector: [0.2, 0.2],
          columns: [{ name: "user_id", dataType: "integer", isNullable: false, defaultValue: null }],
          relations: [],
        },
        {
          tableName: "bm_bookmark",
          schemaHash: "d",
          summaryText: "bookmarks table",
          instructionContext: undefined,
          description: "Stores bookmarks.",
          tags: ["bookmark", "link", "save"],
          aliases: [],
          examples: [],
          embeddingText: "bm_bookmark",
          embeddingVector: [0.3, 0.1],
          columns: [{ name: "user_id", dataType: "integer", isNullable: false, defaultValue: null }],
          relations: [],
        },
      ],
      documents: [],
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
    assert.match(prompt, /Match the user's language/i);
    assert.doesNotMatch(prompt, /Write all user-visible output in English plain CLI text/i);
    assert.match(prompt, /plain monospace text tables/i);
    assert.match(prompt, /prefer a compact plain-text table preview over prose alone/i);
    assert.match(prompt, /stop searching and explicitly say the current schema likely does not contain it/i);
    assert.match(prompt, /Do not repeatedly inspect the same history item without a new reason/i);
    assert.match(prompt, /date, datetime, timestamp, or time values, preserve them as readable strings/i);
    assert.match(prompt, /bigint, decimal, numeric, or scientific-notation values, preserve readable exact strings or expanded decimals/i);
    assert.match(prompt, /Program-rendered query results may use plain monospace text tables/i);
    assert.match(prompt, /prefer inspect_last_result, search_last_result, render_last_result/i);
    assert.match(prompt, /call render_last_result and reuse its rendered table text instead of manually formatting rows yourself/i);
    assert.match(prompt, /Treat render_last_result as a terminal-display tool/i);
    assert.match(prompt, /Do not manually restate SQL row values or build your own tables from SQL tool metadata/i);
    assert.match(prompt, /Never author Markdown tables, plain-text row tables, or copied row dumps for SQL results/i);
    assert.match(prompt, /keep your own reply focused on summary, explanation, and next-step reasoning/i);
    assert.match(prompt, /use search_last_result or inspect_last_result instead of guessing from memory/i);
    assert.match(prompt, /CSV files are generated automatically alongside HTML result views/i);
    assert.match(prompt, /Never use SELECT \* in generated SQL/i);
    assert.match(prompt, /spell out the columns explicitly/i);
    assert.match(prompt, /avoid selecting obvious secrets or credentials such as password, token, secret, api_key/i);
    assert.match(prompt, /put business-relevant fields first and move bookkeeping or audit fields such as created_by, created_time, deleted, updated_by, updated_time/i);
    assert.match(prompt, /include an explicit LIMIT unless the user clearly asks for all rows, a full export, or another exact row count/i);
    assert.match(prompt, /default to a representative preview instead of rendering every cached row in the terminal/i);
    assert.match(prompt, /Only render all returned rows when the user explicitly asks to see all rows/i);
    assert.match(prompt, /Do not treat a large SQL LIMIT as a requirement to display that many rows in the terminal/i);
    assert.match(prompt, /Only set render_last_result expandPreview=true when the user explicitly asked to see all rows/i);
    assert.match(prompt, /render_last_result renders up to 100 rows per call/i);
    assert.match(prompt, /Only paginate with multiple render_last_result calls when the user needs more than 100 visible rows/i);
  });
}
