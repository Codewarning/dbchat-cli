import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseAdapter } from "../db/adapter.js";
import { createConversationTurn, createSessionContextMemory } from "../agent/memory.js";
import { executeAgentToolCall } from "../agent/tool-execution.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import { buildCreateTableDdl } from "../schema/table-ddl.js";
import { SCHEMA_CATALOG_VERSION } from "../schema/catalog-storage.js";
import { assessSchemaCatalogFreshness, ensureSchemaCatalogReady, saveSchemaCatalog } from "../schema/catalog.js";
import { executeTool } from "../tools/registry.js";
import { serializeToolResultForModel } from "../tools/model-payload.js";
import { formatSchemaSummaryText, formatTableSchemaText } from "../ui/text-formatters.js";
import { RunTest, createDatabaseStub, createTestConfig, createTestIo, createToolRuntimeContext } from "./support.js";

export async function registerSchemaAndToolTests(runTest: RunTest): Promise<void> {
  await runTest("schema catalog loading reuses the stored snapshot without live freshness checks", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-catalog-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const config = createTestConfig();
      await saveSchemaCatalog(config.database, {
        version: SCHEMA_CATALOG_VERSION,
        dialect: config.database.dialect,
        host: config.database.host,
        port: config.database.port,
        database: config.database.database,
        schema: config.database.schema,
        generatedAt: new Date().toISOString(),
        tableCount: 1,
        embeddingModelId: getEmbeddingModelInfo(config.embedding).modelId,
        tables: [
          {
            tableName: "users",
            schemaHash: "users-hash",
            summaryText: "users table",
            description: "Stores users.",
            tags: ["users", "accounts", "profiles"],
            embeddingText: "users",
            embeddingVector: [0.1, 0.2],
            columns: [{ name: "id", dataType: "integer", isNullable: false, defaultValue: null }],
          },
        ],
      });

      let liveSchemaCalls = 0;
      const db: DatabaseAdapter = createDatabaseStub({
        async getAllTableSchemas() {
          liveSchemaCalls += 1;
          throw new Error("should not inspect live schema");
        },
      });

      const ready = await ensureSchemaCatalogReady(config, db, createTestIo());
      assert.equal(ready.refreshed, false);
      assert.equal(ready.catalog.tableCount, 1);
      assert.equal(liveSchemaCalls, 0);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }

      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  await runTest("schema catalog freshness detects live schema drift", async () => {
    const db: DatabaseAdapter = createDatabaseStub({
      async getAllTableSchemas() {
        return [
          {
            tableName: "users",
            columns: [
              { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
              { name: "email", dataType: "text", isNullable: false, defaultValue: null },
            ],
          },
        ];
      },
    });

    const stale = await assessSchemaCatalogFreshness(
      {
        version: 5,
        dialect: "postgres",
        host: "localhost",
        port: 5432,
        database: "testdb",
        schema: "public",
        generatedAt: new Date().toISOString(),
        tableCount: 1,
        embeddingModelId: "embedding-model",
        tables: [
          {
            tableName: "users",
            schemaHash: "stale-hash",
            summaryText: "users table",
            description: "Stores users.",
            tags: ["users", "accounts", "profiles"],
            embeddingText: "users",
            embeddingVector: [0.1, 0.2],
            columns: [{ name: "id", dataType: "integer", isNullable: false, defaultValue: null }],
          },
        ],
      },
      db,
    );

    assert.equal(stale.fresh, false);
    assert.match(stale.reason, /changed/i);

    const freshSchemaHash = createHash("sha256")
      .update(
        JSON.stringify({
          tableName: "users",
          columns: [
            { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
            { name: "email", dataType: "text", isNullable: false, defaultValue: null },
          ],
          ddlPreview: null,
        }),
      )
      .digest("hex");
    const fresh = await assessSchemaCatalogFreshness(
      {
        version: 5,
        dialect: "postgres",
        host: "localhost",
        port: 5432,
        database: "testdb",
        schema: "public",
        generatedAt: new Date().toISOString(),
        tableCount: 1,
        embeddingModelId: "embedding-model",
        tables: [
          {
            tableName: "users",
            schemaHash: freshSchemaHash,
            summaryText: "users table",
            description: "Stores users.",
            tags: ["users", "accounts", "profiles"],
            embeddingText: "users",
            embeddingVector: [0.1, 0.2],
            columns: [
              { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
              { name: "email", dataType: "text", isNullable: false, defaultValue: null },
            ],
          },
        ],
      },
      db,
    );

    assert.equal(fresh.fresh, true);
  });

  await runTest("schema summary text hides counts unless they are explicitly provided", () => {
    const withoutCounts = formatSchemaSummaryText({
      dialect: "postgres",
      database: "testdb",
      schema: "public",
      tables: [{ tableName: "users" }, { tableName: "roles" }],
    });
    const withCounts = formatSchemaSummaryText({
      dialect: "postgres",
      database: "testdb",
      schema: "public",
      tables: [
        { tableName: "users", rowCount: 0 },
        { tableName: "roles", rowCount: 12 },
      ],
    });

    assert.doesNotMatch(withoutCounts, /rowCount/i);
    assert.match(withCounts, /rowCount/i);
  });

  await runTest("list_live_tables returns live table names from the active adapter", async () => {
    let getSchemaSummaryCalls = 0;
    const db: DatabaseAdapter = createDatabaseStub({
      async getSchemaSummary() {
        getSchemaSummaryCalls += 1;
        return {
          dialect: "postgres",
          database: "testdb",
          schema: "public",
          tables: [{ tableName: "users" }, { tableName: "roles" }],
        };
      },
    });

    const result = await executeTool("list_live_tables", {}, createToolRuntimeContext({ db }));

    assert.deepEqual(result, {
      dialect: "postgres",
      database: "testdb",
      schema: "public",
      tableNames: ["users", "roles"],
    });
    assert.equal(getSchemaSummaryCalls, 1);
  });

  await runTest("list_live_tables payload keeps only a bounded preview", () => {
    const serialized = serializeToolResultForModel(
      "list_live_tables",
      {
        dialect: "postgres",
        database: "testdb",
        schema: "public",
        tableNames: Array.from({ length: 120 }, (_value, index) => `table_${index}`),
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.tableCount, 120);
    assert.ok(Array.isArray(payload.tableNamesPreview));
    assert.equal("tableNames" in payload, false);
  });

  await runTest("inspect_last_result returns a cached slice without rerunning SQL", async () => {
    const result = await executeTool(
      "inspect_last_result",
      { offset: 1, limit: 1, columns: ["email"] },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email from users order by id",
          operation: "SELECT",
          rowCount: 3,
          rows: [
            { id: 1, email: "a@example.com" },
            { id: 2, email: "b@example.com" },
            { id: 3, email: "c@example.com" },
          ],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 2,
        }),
      }),
    );

    assert.deepEqual(result, {
      sql: "select id, email from users order by id",
      operation: "SELECT",
      rowCount: 3,
      cachedRowCount: 3,
      rowsTruncated: false,
      fields: ["email"],
      offset: 1,
      limit: 1,
      rows: [{ email: "b@example.com" }],
    });
  });

  await runTest("inspect_last_result payload includes returned rows and table preview", () => {
    const serialized = serializeToolResultForModel(
      "inspect_last_result",
      {
        sql: "select id, email from users order by id",
        operation: "SELECT",
        rowCount: 3,
        cachedRowCount: 3,
        rowsTruncated: false,
        fields: ["id", "email"],
        offset: 1,
        limit: 2,
        rows: [
          { id: 2, email: "b@example.com" },
          { id: 3, email: "c@example.com" },
        ],
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.returnedRowCount, 2);
    assert.equal(typeof payload.previewTable, "string");
    assert.match(String(payload.previewTable), /b@example\.com/);
    assert.match(serialized.summary, /Cached result inspected/i);
  });

  await runTest("render_last_result returns ready-to-display plain text for one cached page", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 2, columns: ["id", "email"] },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email from users order by id",
          operation: "SELECT",
          rowCount: 3,
          rows: [
            { id: 1, email: "a@example.com" },
            { id: 2, email: "b@example.com" },
            { id: 3, email: "c@example.com" },
          ],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 2,
        }),
      }),
    );

    const rendered = result as { renderedText: string; hasMoreRows: boolean; rows: Array<Record<string, unknown>> };
    assert.match(rendered.renderedText, /SQL result rows 1-2 of 3:/);
    assert.match(rendered.renderedText, /a@example\.com/);
    assert.match(rendered.renderedText, /More cached rows are available/i);
    assert.equal(rendered.hasMoreRows, true);
    assert.equal(rendered.rows.length, 2);
  });

  await runTest("render_last_result clamps oversized limits instead of failing validation", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 150, columns: ["id", "email"] },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email from users order by id",
          operation: "SELECT",
          rowCount: 8,
          rows: [
            { id: 1, email: "a@example.com" },
            { id: 2, email: "b@example.com" },
            { id: 3, email: "c@example.com" },
            { id: 4, email: "d@example.com" },
            { id: 5, email: "e@example.com" },
            { id: 6, email: "f@example.com" },
            { id: 7, email: "g@example.com" },
            { id: 8, email: "h@example.com" },
          ],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 2,
        }),
      }),
    );

    const rendered = result as { limit: number; rows: Array<Record<string, unknown>>; renderedText: string };
    assert.equal(rendered.limit, 100);
    assert.equal(rendered.rows.length, 8);
    assert.match(rendered.renderedText, /Requested limit 150 exceeded the per-call maximum/i);
  });

  await runTest("render_last_result serializer returns plain text instead of json payload", () => {
    const serialized = serializeToolResultForModel(
      "render_last_result",
      {
        sql: "select id, email from users order by id",
        operation: "SELECT",
        rowCount: 3,
        cachedRowCount: 3,
        rowsTruncated: false,
        fields: ["id", "email"],
        offset: 0,
        limit: 2,
        rows: [
          { id: 1, email: "a@example.com" },
          { id: 2, email: "b@example.com" },
        ],
        renderedText: "SQL result rows 1-2 of 3:\nid | email\n---+------",
        hasMoreRows: true,
      },
      createTestConfig().app,
    );

    assert.match(serialized.content, /SQL result rows 1-2 of 3:/);
    assert.doesNotMatch(serialized.content, /^\{/);
    assert.match(serialized.summary, /Cached result rendered/i);
  });

  await runTest("inspect_last_explain returns a cached focused plan preview", async () => {
    const result = await executeTool(
      "inspect_last_explain",
      { focus: "users", maxChars: 120 },
      createToolRuntimeContext({
        getLastExplain: () => ({
          sql: "select * from users where id = 1",
          operation: "SELECT",
          elapsedMs: 5,
          warnings: ["Seq scan detected"],
          rawPlan: {
            Plan: {
              NodeType: "Seq Scan",
              RelationName: "users",
              Filter: "(id = 1)",
            },
          },
        }),
      }),
    );

    const inspected = result as { operation: string; focus?: string; preview: string };
    assert.equal(inspected.operation, "SELECT");
    assert.equal(inspected.focus, "users");
    assert.match(inspected.preview, /users/i);
  });

  await runTest("inspect_last_explain payload includes preview and warnings", () => {
    const serialized = serializeToolResultForModel(
      "inspect_last_explain",
      {
        sql: "select * from users where id = 1",
        operation: "SELECT",
        elapsedMs: 5,
        warnings: ["Seq scan detected"],
        focus: "users",
        preview: '{"Plan":{"NodeType":"Seq Scan","RelationName":"users","Filter":"(id = 1)"}}',
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.focus, "users");
    assert.match(String(payload.planPreview), /Seq Scan/);
    assert.match(serialized.summary, /Cached EXPLAIN inspected/i);
  });

  await runTest("inspect_history_entry returns the full messages for one completed turn", async () => {
    const turn = createConversationTurn("show users", "turn-3");
    turn.messages.push({
      role: "assistant",
      content: "Returned 3 rows.",
    });
    turn.summaryLines.push("Final answer: Returned 3 rows.");

    const result = await executeTool(
      "inspect_history_entry",
      { turnId: "turn-3" },
      createToolRuntimeContext({
        history: {
          inspectTurn: (turnId) =>
            turnId === "turn-3"
              ? {
                  turnId: turn.id,
                  summaryLines: [...turn.summaryLines],
                  messages: turn.messages.map((message) => {
                    switch (message.role) {
                      case "system":
                      case "user":
                        return {
                          role: message.role,
                          content: message.content,
                        };
                      case "assistant":
                        return {
                          role: message.role,
                          content: message.content,
                          toolCallNames: message.tool_calls?.map((toolCall) => toolCall.function.name),
                        };
                      case "tool":
                        return {
                          role: message.role,
                          content: message.content,
                          toolCallId: message.tool_call_id,
                          isError: message.is_error,
                        };
                    }
                  }),
                }
              : null,
          inspectPersistedOutput: () => null,
        },
      }),
    );

    const inspected = result as { kind: string; turnId: string; messages: Array<{ role: string; content: string | null }> };
    assert.equal(inspected.kind, "turn");
    assert.equal(inspected.turnId, "turn-3");
    assert.equal(inspected.messages[0]?.role, "user");
    assert.equal(inspected.messages[1]?.content, "Returned 3 rows.");
  });

  await runTest("inspect_history_entry can read a persisted tool output slice", async () => {
    const result = await executeTool(
      "inspect_history_entry",
      { persistedOutputId: "tool-output-2", offset: 2, maxChars: 4 },
      createToolRuntimeContext({
        history: {
          inspectTurn: () => null,
          inspectPersistedOutput: (id) =>
            id === "tool-output-2"
              ? {
                  persistedOutputId: "tool-output-2",
                  turnId: "turn-4",
                  toolName: "inspect_last_explain",
                  summary: "Explain completed for SELECT in 8.00ms.",
                  content: "ABCDEFGHIJ",
                }
              : null,
        },
      }),
    );

    const inspected = result as { kind: string; content: string; offset: number; returnedChars: number; truncated: boolean };
    assert.equal(inspected.kind, "persisted_tool_output");
    assert.equal(inspected.offset, 2);
    assert.equal(inspected.content, "CDEF");
    assert.equal(inspected.returnedChars, 4);
    assert.equal(inspected.truncated, true);
  });

  await runTest("large tool payloads are persisted instead of being inlined into conversation history", async () => {
    const config = createTestConfig();
    config.app.contextCompression.largeToolOutputChars = 220;
    config.app.contextCompression.persistedToolPreviewChars = 120;
    const pushedMessages: Array<{ role: string; content: string }> = [];
    const pushedSummaryLines: string[] = [];
    const persistedOutputs: Array<{ id: string; content: string }> = [];

    const failure = await executeAgentToolCall({
      toolCall: {
        id: "call_1",
        type: "function",
        function: {
          name: "inspect_last_explain",
          arguments: JSON.stringify({ maxChars: 4000 }),
        },
      },
      runtime: createToolRuntimeContext({
        getLastExplain: () => ({
          sql: "select * from users where id = 1",
          operation: "SELECT",
          elapsedMs: 5,
          warnings: ["Seq scan detected"],
          rawPlan: "Node ".repeat(1500),
        }),
      }),
      io: createTestIo(),
      config,
      memory: createSessionContextMemory(),
      currentTurnId: "turn-1",
      persistToolOutput: (entry) => {
        const persisted = {
          id: `tool-output-${persistedOutputs.length + 1}`,
          turnId: "turn-1",
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          summary: entry.summary,
          content: entry.content,
        };
        persistedOutputs.push(persisted);
        return persisted;
      },
      pushCurrentTurnMessage(message) {
        pushedMessages.push({
          role: message.role,
          content: message.role === "tool" ? message.content : "",
        });
      },
      pushCurrentTurnSummary(line) {
        pushedSummaryLines.push(line);
      },
    });

    assert.equal(failure, null);
    assert.equal(persistedOutputs.length, 1);
    assert.equal(pushedMessages[0]?.role, "tool");
    const payload = JSON.parse(pushedMessages[0]!.content) as Record<string, unknown>;
    assert.equal(payload.persistedOutputId, "tool-output-1");
    assert.match(String(payload.note), /omitted from active conversation context/i);
    assert.ok(persistedOutputs[0]!.content.length > config.app.contextCompression.largeToolOutputChars);
    assert.ok(pushedSummaryLines.some((line) => /Persisted tool output: tool-output-1/.test(line)));
  });

  await runTest("render_last_result stays inline even when the global large-output threshold is small", async () => {
    const config = createTestConfig();
    config.app.contextCompression.largeToolOutputChars = 80;
    const pushedMessages: Array<{ role: string; content: string }> = [];
    const persistedOutputs: Array<{ id: string; content: string }> = [];

    const failure = await executeAgentToolCall({
      toolCall: {
        id: "call_2",
        type: "function",
        function: {
          name: "render_last_result",
          arguments: JSON.stringify({ offset: 0, limit: 20, columns: ["id", "email"] }),
        },
      },
      runtime: createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email from users order by id",
          operation: "SELECT",
          rowCount: 6,
          rows: [
            { id: 1, email: "a@example.com" },
            { id: 2, email: "b@example.com" },
            { id: 3, email: "c@example.com" },
            { id: 4, email: "d@example.com" },
            { id: 5, email: "e@example.com" },
            { id: 6, email: "f@example.com" },
          ],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 2,
        }),
      }),
      io: createTestIo(),
      config,
      memory: createSessionContextMemory(),
      currentTurnId: "turn-2",
      persistToolOutput: (entry) => {
        const persisted = {
          id: `tool-output-${persistedOutputs.length + 1}`,
          turnId: "turn-2",
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          summary: entry.summary,
          content: entry.content,
        };
        persistedOutputs.push(persisted);
        return persisted;
      },
      pushCurrentTurnMessage(message) {
        pushedMessages.push({
          role: message.role,
          content: message.role === "tool" ? message.content : "",
        });
      },
      pushCurrentTurnSummary() {},
    });

    assert.equal(failure, null);
    assert.equal(persistedOutputs.length, 0);
    assert.match(pushedMessages[0]?.content ?? "", /SQL result rows 1-6 of 6:/);
  });

  await runTest("table DDL preview renders columns and constraints in CREATE TABLE form", () => {
    const ddl = buildCreateTableDdl(
      "users",
      [
        { name: "id", dataType: "integer", isNullable: false, defaultValue: "nextval('users_id_seq'::regclass)" },
        { name: "username", dataType: "character varying(50)", isNullable: false, defaultValue: null },
      ],
      ["PRIMARY KEY (id)", "UNIQUE (username)"],
    );

    assert.match(ddl, /CREATE TABLE users/i);
    assert.match(ddl, /id integer NOT NULL DEFAULT nextval/i);
    assert.match(ddl, /username character varying\(50\) NOT NULL/i);
    assert.match(ddl, /PRIMARY KEY \(id\)/i);
    assert.match(ddl, /UNIQUE \(username\)/i);
  });

  await runTest("schema catalog search payload includes structured top matches", () => {
    const serialized = serializeToolResultForModel(
      "search_schema_catalog",
      {
        query: "bookmark",
        totalMatches: 2,
        matches: [
          {
            tableName: "bm_bookmark",
            summaryText: "bookmarks",
            description: "Stores bookmark records.",
            tags: ["bookmark", "link", "save"],
            matchedColumns: ["user_id"],
            matchReasons: ["tag match", "column name overlap"],
            score: 82.3,
            semanticScore: 0.51,
            keywordScore: 31,
          },
          {
            tableName: "bm_tag",
            summaryText: "tags",
            description: "Stores bookmark tags.",
            tags: ["tag", "label", "bookmark"],
            matchedColumns: ["user_id"],
            matchReasons: ["partial tag match"],
            score: 54.1,
            semanticScore: 0.33,
            keywordScore: 21,
          },
        ],
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.ok(Array.isArray(payload.topMatches));
    assert.equal((payload.topMatches as Array<Record<string, unknown>>)[0]?.tableName, "bm_bookmark");
    assert.match(serialized.summary, /bookmark/i);
  });

  await runTest("describe_table payload includes ddlPreview when available", () => {
    const serialized = serializeToolResultForModel(
      "describe_table",
      {
        tableName: "users",
        columns: [
          { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
          { name: "email", dataType: "character varying(100)", isNullable: false, defaultValue: null },
        ],
        ddlPreview: "CREATE TABLE users (\n  id integer NOT NULL,\n  email character varying(100) NOT NULL,\n  PRIMARY KEY (id)\n);",
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(typeof payload.ddlPreview, "string");
    assert.match(serialized.summary, /DDL preview/i);
  });

  await runTest("table schema text shows whether DDL is native or reconstructed", () => {
    const nativeText = formatTableSchemaText({
      tableName: "users",
      columns: [],
      ddlPreview: "CREATE TABLE `users` (`id` int NOT NULL);",
      ddlSource: "native",
    });
    const reconstructedText = formatTableSchemaText({
      tableName: "users",
      columns: [],
      ddlPreview: "CREATE TABLE users (\n  id integer NOT NULL\n);",
      ddlSource: "reconstructed",
    });

    assert.match(nativeText, /DDL source: native database DDL/i);
    assert.match(reconstructedText, /DDL source: reconstructed DDL/i);
  });
}
