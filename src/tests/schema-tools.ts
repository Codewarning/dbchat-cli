import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "../db/adapter.js";
import { buildCreateTableDdl } from "../schema/table-ddl.js";
import { assessSchemaCatalogFreshness } from "../schema/catalog.js";
import { executeTool } from "../tools/registry.js";
import { serializeToolResultForModel } from "../tools/model-payload.js";
import { formatSchemaSummaryText, formatTableSchemaText } from "../ui/text-formatters.js";
import { RunTest, createDatabaseStub, createTestConfig, createToolRuntimeContext } from "./support.js";

export async function registerSchemaAndToolTests(runTest: RunTest): Promise<void> {
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
