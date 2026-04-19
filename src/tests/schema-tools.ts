import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseAdapter } from "../db/adapter.js";
import { createConversationTurn, createSessionContextMemory } from "../agent/memory.js";
import { executeAgentToolCall } from "../agent/tool-execution.js";
import { readMySqlRowField } from "../db/mysql.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import { initializeLocalSchemaCatalogOnEntry } from "../services/schema-catalog.js";
import { buildCreateTableDdl } from "../schema/table-ddl.js";
import { SCHEMA_CATALOG_VERSION } from "../schema/catalog-storage.js";
import {
  assessSchemaCatalogFreshness,
  ensureSchemaCatalogReady,
  getSchemaCatalogPath,
  saveSchemaCatalog,
  searchSchemaCatalog,
  syncSchemaCatalog,
} from "../schema/catalog.js";
import { executeTool } from "../tools/registry.js";
import { serializeToolResultForModel } from "../tools/model-payload.js";
import { formatRecordsTable } from "../ui/text-table.js";
import { formatSchemaSummaryText, formatTableSchemaText } from "../ui/text-formatters.js";
import type { SchemaCatalog, SchemaCatalogTable } from "../types/index.js";
import { RunTest, createDatabaseStub, createTestConfig, createTestIo, createToolRuntimeContext } from "./support.js";

function createCatalogTableFixture(overrides: Partial<SchemaCatalogTable> = {}): SchemaCatalogTable {
  return {
    tableName: "users",
    schemaHash: "users-hash",
    summaryText: "users table",
    instructionContext: undefined,
    description: "Stores users.",
    tags: ["users", "accounts", "profiles"],
    aliases: [],
    examples: [],
    embeddingText: "users",
    embeddingVector: [0.1, 0.2],
    columns: [{ name: "id", dataType: "integer", isNullable: false, defaultValue: null }],
    relations: [],
    ...overrides,
  };
}

function createCatalogFixture(config = createTestConfig(), tableOverrides: Array<Partial<SchemaCatalogTable>> = []): SchemaCatalog {
  const tables = tableOverrides.length ? tableOverrides.map((overrides) => createCatalogTableFixture(overrides)) : [createCatalogTableFixture()];
  return {
    version: SCHEMA_CATALOG_VERSION,
    dialect: config.database.dialect,
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    schema: config.database.schema,
    generatedAt: new Date().toISOString(),
    tableCount: tables.length,
    documentCount: 0,
    instructionFingerprint: null,
    embeddingModelId: getEmbeddingModelInfo(config.embedding).modelId,
    tables,
    documents: [],
  };
}

export async function registerSchemaAndToolTests(runTest: RunTest): Promise<void> {
  await runTest("formatRecordsTable truncates long cell values onto a single line without trailing whitespace", () => {
    const rendered = formatRecordsTable(
      [
        {
          id: 1,
          note: "This value is intentionally long so the table renderer must wrap it instead of pushing one very wide line.",
        },
      ],
      ["id", "note"],
    );

    assert.match(rendered, /^id\s+\| note$/m);
    assert.match(rendered, /^1\s+\| This value is intentionally long so…$/m);
    assert.doesNotMatch(rendered, /^\s+\|/m);
    assert.doesNotMatch(rendered, /[ \t]+$/m);
  });

  await runTest("formatRecordsTable computes column widths from the visible content of each column", () => {
    const rendered = formatRecordsTable(
      [
        { id: 1, name: "Alice" },
        { id: 22, name: "Bo" },
      ],
      ["id", "name"],
    );

    const [headerLine, separatorLine, firstRow] = rendered.split("\n");
    assert.equal(headerLine, "id   | name");
    assert.equal(separatorLine, "-----+------");
    assert.equal(firstRow, "1    | Alice");
    assert.ok((headerLine?.length ?? 0) < 20);
  });

  await runTest("schema catalog loading reuses the stored snapshot without live freshness checks", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-catalog-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const config = createTestConfig();
      await saveSchemaCatalog(config.database, createCatalogFixture(config));

      const ready = await ensureSchemaCatalogReady(config, createTestIo());
      assert.equal(ready.refreshed, false);
      assert.equal(ready.catalog.tableCount, 1);
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

  await runTest("runtime catalog initialization no longer waits for confirm() when embeddings are enabled", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-catalog-init-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const config = createTestConfig();
      let confirmCalls = 0;
      const io = {
        ...createTestIo(),
        async confirm() {
          confirmCalls += 1;
          return false;
        },
      };

      const initialized = await initializeLocalSchemaCatalogOnEntry(
        config,
        createDatabaseStub({
          async getAllTableSchemas() {
            return [];
          },
        }),
        io,
      );

      assert.equal(confirmCalls, 0);
      assert.equal(initialized?.refreshed, true);
      assert.equal(initialized?.catalog.tableCount, 0);
      assert.equal(initialized?.result?.semanticIndexEnabled, true);
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
        version: SCHEMA_CATALOG_VERSION,
        dialect: "postgres",
        host: "localhost",
        port: 5432,
        database: "testdb",
        schema: "public",
        generatedAt: new Date().toISOString(),
        tableCount: 1,
        documentCount: 0,
        instructionFingerprint: null,
        embeddingModelId: "embedding-model",
        tables: [
          createCatalogTableFixture({ schemaHash: "stale-hash" }),
        ],
        documents: [],
      },
      db,
    );

    assert.equal(stale.fresh, false);
    assert.match(stale.reason, /changed/i);

    const freshSchemaHash = createHash("sha256")
      .update(
        JSON.stringify({
          tableName: "users",
          comment: null,
          columns: [
            { name: "id", dataType: "integer", isNullable: false, defaultValue: null, comment: null },
            { name: "email", dataType: "text", isNullable: false, defaultValue: null, comment: null },
          ],
          relations: [],
          ddlPreview: null,
        }),
      )
      .digest("hex");
    const fresh = await assessSchemaCatalogFreshness(
      {
        version: SCHEMA_CATALOG_VERSION,
        dialect: "postgres",
        host: "localhost",
        port: 5432,
        database: "testdb",
        schema: "public",
        generatedAt: new Date().toISOString(),
        tableCount: 1,
        documentCount: 0,
        instructionFingerprint: null,
        embeddingModelId: "embedding-model",
        tables: [
          createCatalogTableFixture({
            schemaHash: freshSchemaHash,
            columns: [
              { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
              { name: "email", dataType: "text", isNullable: false, defaultValue: null },
            ],
          }),
        ],
        documents: [],
      },
      db,
    );

    assert.equal(fresh.fresh, true);
  });

  await runTest("mysql information_schema field reader accepts uppercase metadata keys", () => {
    assert.equal(readMySqlRowField<string>({ TABLE_NAME: "users" }, "table_name"), "users");
    assert.equal(readMySqlRowField<string>({ table_name: "orders" }, "table_name"), "orders");
    assert.equal(readMySqlRowField<string>({ COLUMN_COMMENT: "note" }, "column_comment"), "note");
    assert.equal(readMySqlRowField<string>({}, "table_name"), undefined);
  });

  await runTest("schema catalog paths stay readable without hash fragments", () => {
    const config = createTestConfig();
    const catalogPath = getSchemaCatalogPath(config.database);

    assert.match(catalogPath, /schema-catalog/i);
    assert.match(catalogPath, /localhost-5432/i);
    assert.match(catalogPath, /testdb/i);
    assert.match(catalogPath, /public/i);
    assert.match(catalogPath, /catalog\.json$/i);
    assert.doesNotMatch(catalogPath, /[a-f0-9]{12}\.json$/i);
  });

  await runTest("mysql schema catalog paths use the public scope directory", () => {
    const config = createTestConfig();
    config.database.dialect = "mysql";
    config.database.port = 3306;
    config.database.schema = "analytics";

    const catalogPath = getSchemaCatalogPath(config.database);

    assert.match(catalogPath, /schema-catalog/i);
    assert.match(catalogPath, /localhost-3306/i);
    assert.match(catalogPath, /testdb/i);
    assert.match(catalogPath, /catalog\.json$/i);
    assert.match(catalogPath, /[\\/]public[\\/]catalog\.json$/i);
    assert.doesNotMatch(catalogPath, /[\\/]analytics[\\/]catalog\.json$/i);
    assert.doesNotMatch(catalogPath, /[\\/]default[\\/]catalog\.json$/i);
  });

  await runTest("schema catalog search indexes local table and column metadata without YAML docs", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-schema-search-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const config = createTestConfig();
      config.embedding.apiKey = "";

      const db: DatabaseAdapter = createDatabaseStub({
        async getAllTableSchemas() {
          return [
            {
              tableName: "sys_user",
              comment: "System user table",
              columns: [
                { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
                { name: "username", dataType: "text", isNullable: false, defaultValue: null },
                { name: "mobile", dataType: "text", isNullable: true, defaultValue: null },
              ],
              relations: [],
            },
          ];
        },
      });

      const synced = await syncSchemaCatalog(config, db);
      const search = await searchSchemaCatalog(synced.catalog, "login username", 5);

      assert.equal(synced.result.semanticIndexEnabled, false);
      assert.equal(search.matches[0]?.tableName, "sys_user");
      assert.ok(search.matches[0]?.matchedColumns.includes("username"));
      assert.equal(search.isAmbiguous, false);
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

  await runTest("inspect_last_result payload preserves requested fields beyond the first eight columns", () => {
    const serialized = serializeToolResultForModel(
      "inspect_last_result",
      {
        sql: "select c1, c2, c3, c4, c5, c6, c7, c8, create_time from users order by id",
        operation: "SELECT",
        rowCount: 3,
        cachedRowCount: 3,
        rowsTruncated: false,
        fields: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "create_time"],
        offset: 1,
        limit: 2,
        rows: [
          { c1: 2, c2: "a", c3: "b", c4: "c", c5: "d", c6: "e", c7: "f", c8: "g", create_time: "2026-04-18 10:00:00" },
          { c1: 3, c2: "h", c3: "i", c4: "j", c5: "k", c6: "l", c7: "m", c8: "n", create_time: "2026-04-18 09:00:00" },
        ],
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.returnedRowCount, 2);
    assert.equal(Array.isArray(payload.rows), true);
    const rows = payload.rows as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.create_time, "2026-04-18 10:00:00");
    assert.equal(payload.previewTable, undefined);
    assert.match(serialized.summary, /Cached result inspected/i);
  });

  await runTest("render_last_result returns ready-to-display plain text for one cached page", async () => {
    const displayBlocks: Array<{ title: string; body: string }> = [];
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 2, columns: ["id", "email"] },
      createToolRuntimeContext({
        pushDisplayBlock(block) {
          displayBlocks.push({ title: block.title, body: block.body });
        },
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
    assert.equal(displayBlocks.length, 1);
    assert.equal(displayBlocks[0]?.title, "Result Preview");
    assert.match(displayBlocks[0]?.body ?? "", /SQL result rows 1-2 of 3:/);
  });

  await runTest("render_last_result clamps oversized limits instead of failing validation", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 150, columns: ["id", "email"], expandPreview: true },
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

  await runTest("render_last_result keeps a compact preview by default when the requested limit is larger than the preview row limit", async () => {
    const context = createToolRuntimeContext({
      config: {
        ...createTestConfig(),
        app: {
          ...createTestConfig().app,
          tableRendering: {
            ...createTestConfig().app.tableRendering,
            inlineRowLimit: 5,
            previewRowLimit: 5,
          },
        },
      },
      getLastResult: () => ({
        sql: "select id, email from users order by id limit 8",
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
    });
    const result = await executeTool("render_last_result", { offset: 0, limit: 8, columns: ["id", "email"] }, context);

    const rendered = result as { limit: number; renderedText: string; hasMoreRows: boolean; rows: Array<Record<string, unknown>> };
    assert.equal(rendered.limit, 5);
    assert.match(rendered.renderedText, /SQL result rows 1-5 of 8:/);
    assert.match(rendered.renderedText, /Requested 8 visible rows, but the terminal preview stayed compact at 5 rows/i);
    assert.equal(rendered.rows.length, 5);
    assert.equal(rendered.hasMoreRows, true);
  });

  await runTest("render_last_result can expand beyond the configured preview row limit when explicitly requested", async () => {
    const context = createToolRuntimeContext({
      config: {
        ...createTestConfig(),
        app: {
          ...createTestConfig().app,
          tableRendering: {
            ...createTestConfig().app.tableRendering,
            inlineRowLimit: 5,
            previewRowLimit: 5,
          },
        },
      },
      getLastResult: () => ({
        sql: "select id, email from users order by id limit 8",
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
    });
    const result = await executeTool("render_last_result", { offset: 0, limit: 8, columns: ["id", "email"], expandPreview: true }, context);

    const rendered = result as { limit: number; renderedText: string; hasMoreRows: boolean; rows: Array<Record<string, unknown>> };
    assert.equal(rendered.limit, 8);
    assert.match(rendered.renderedText, /SQL result rows 1-8 of 8:/);
    assert.equal(rendered.rows.length, 8);
    assert.equal(rendered.hasMoreRows, false);
    assert.doesNotMatch(rendered.renderedText, /terminal preview stayed compact/i);
  });

  await runTest("render_last_result keeps the default preview limit when the executed SQL used a larger limit", async () => {
    const context = createToolRuntimeContext({
      config: {
        ...createTestConfig(),
        app: {
          ...createTestConfig().app,
          tableRendering: {
            ...createTestConfig().app.tableRendering,
            inlineRowLimit: 5,
            previewRowLimit: 5,
          },
        },
      },
      getLastResult: () => ({
        sql: "select id, email from users order by id limit 8",
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
    });
    const result = await executeTool("render_last_result", { offset: 0, columns: ["id", "email"] }, context);

    const rendered = result as { limit: number; renderedText: string; hasMoreRows: boolean; rows: Array<Record<string, unknown>> };
    assert.equal(rendered.limit, 5);
    assert.match(rendered.renderedText, /SQL result rows 1-5 of 8:/);
    assert.equal(rendered.rows.length, 5);
    assert.equal(rendered.hasMoreRows, true);
  });

  await runTest("render_last_result formats Buffer values without exposing Node Buffer objects", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 1, columns: ["id", "deleted"] },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, deleted from sample_records order by id limit 1",
          operation: "SELECT",
          rowCount: 1,
          rows: [{ id: 1, deleted: Buffer.from([0]) }],
          rowsTruncated: false,
          fields: ["id", "deleted"],
          elapsedMs: 2,
        }),
      }),
    );

    const rendered = result as { renderedText: string; rows: Array<Record<string, unknown>> };
    assert.match(rendered.renderedText, /0x00/);
    assert.doesNotMatch(rendered.renderedText, /"type":"Buffer"/);
    assert.equal(rendered.rows[0]?.deleted, "0x00");
  });

  await runTest("render_last_result includes the automatic preview-limit note when present on the cached result", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 2, columns: ["id", "email"] },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email from users order by id limit 2",
          operation: "SELECT",
          rowCount: 2,
          rows: [
            { id: 1, email: "a@example.com" },
            { id: 2, email: "b@example.com" },
          ],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 2,
          autoAppliedReadOnlyLimit: 2,
        }),
      }),
    );

    const rendered = result as { renderedText: string };
    assert.match(rendered.renderedText, /auto-limited to 2 rows/i);
  });

  await runTest("render_last_result includes the HTML view when an artifact is attached", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 2, columns: ["id", "email"] },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email from users order by id",
          operation: "SELECT",
          rowCount: 2,
          rows: [
            { id: 1, email: "a@example.com" },
            { id: 2, email: "b@example.com" },
          ],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 2,
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
        }),
      }),
    );

    const rendered = result as { renderedText: string };
    assert.match(rendered.renderedText, /Open full table in a browser:/i);
    assert.match(rendered.renderedText, /file:\/\/\/tmp\/dbchat\/result\.html/i);
    assert.match(rendered.renderedText, /Open the same cached rows as CSV:/i);
    assert.match(rendered.renderedText, /file:\/\/\/tmp\/dbchat\/result\.csv/i);
  });

  await runTest("render_last_result compacts very wide tables to head and tail columns by default", async () => {
    const result = await executeTool(
      "render_last_result",
      { offset: 0, limit: 1 },
      createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, shop_id, open_user_id, open_user_name, open_user_phone, group_id, task_id, order_status, merchant_code, work_date, rest, create_at, update_at from schedule_info limit 1",
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
          elapsedMs: 2,
        }),
      }),
    );

    const rendered = result as { renderedText: string; fields: string[] };
    assert.deepEqual(rendered.fields, [
      "id",
      "shop_id",
      "open_user_id",
      "open_user_name",
      "open_user_phone",
      "rest",
      "create_at",
      "update_at",
    ]);
    assert.match(rendered.renderedText, /Showing 8 of 13 columns in the terminal preview/i);
    assert.match(rendered.renderedText, /create_at/);
    assert.match(rendered.renderedText, /update_at/);
    assert.doesNotMatch(rendered.renderedText, /\bgroup_id\b/);
  });

  await runTest("render_last_result respects the configured inline column limit by default", async () => {
    const context = createToolRuntimeContext({
      config: {
        ...createTestConfig(),
        app: {
          ...createTestConfig().app,
          tableRendering: {
            ...createTestConfig().app.tableRendering,
            inlineColumnLimit: 5,
          },
        },
      },
      getLastResult: () => ({
        sql: "select id, title, url, icon, is_favorite, created_by, updated_by, deleted from env limit 1",
        operation: "SELECT",
        rowCount: 1,
        rows: [
          {
            id: 1,
            title: "home",
            url: "https://example.com",
            icon: "bookmark",
            is_favorite: true,
            created_by: "system",
            updated_by: "system",
            deleted: false,
          },
        ],
        rowsTruncated: false,
        fields: ["id", "title", "url", "icon", "is_favorite", "created_by", "updated_by", "deleted"],
        elapsedMs: 2,
      }),
    });
    const result = await executeTool("render_last_result", { offset: 0, limit: 1 }, context);

    const rendered = result as { renderedText: string; fields: string[] };
    assert.deepEqual(rendered.fields, ["id", "title", "created_by", "updated_by", "deleted"]);
    assert.match(rendered.renderedText, /Showing 5 of 8 columns in the terminal preview/i);
    assert.doesNotMatch(rendered.renderedText, /\burl\b/);
    assert.doesNotMatch(rendered.renderedText, /\bicon\b/);
    assert.doesNotMatch(rendered.renderedText, /\bis_favorite\b/);
  });

  await runTest("render_last_result serializer returns compact metadata while terminal rendering stays program-side", () => {
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

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.renderedInTerminal, true);
    assert.equal(payload.returnedRowCount, 2);
    assert.equal(payload.hasMoreRows, true);
    assert.equal(payload.offset, 0);
    assert.match(serialized.summary, /Cached result rendered/i);
  });

  await runTest("search_last_result can locate matching cached rows without rerunning SQL", async () => {
    const result = await executeTool(
      "search_last_result",
      { query: "b@example.com", limit: 2, columns: ["email"] },
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

    const searched = result as { matchedRowCount: number; rows: Array<Record<string, unknown>> };
    assert.equal(searched.matchedRowCount, 1);
    assert.equal(searched.rows[0]?.email, "b@example.com");
    assert.equal(searched.rows[0]?.__rowNumber, 2);
  });

  await runTest("search_last_result serializer returns a bounded preview table", () => {
    const serialized = serializeToolResultForModel(
      "search_last_result",
      {
        sql: "select id, email from users order by id",
        operation: "SELECT",
        rowCount: 3,
        cachedRowCount: 3,
        rowsTruncated: false,
        query: "b@example.com",
        fields: ["email"],
        offset: 0,
        limit: 5,
        matchedRowCount: 1,
        rows: [
          {
            __rowNumber: 2,
            __matchedFields: ["email"],
            email: "b@example.com",
          },
        ],
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.matchedRowCount, 1);
    assert.match(String(payload.previewTable), /b@example\.com/);
    assert.match(String(payload.previewTable), /rowNumber/);
    assert.match(serialized.summary, /Cached result search/i);
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
    const displayBlocks: Array<{ title: string; body: string }> = [];

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
        pushDisplayBlock(block) {
          displayBlocks.push({ title: block.title, body: block.body });
        },
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
    const payload = JSON.parse(pushedMessages[0]?.content ?? "{}") as Record<string, unknown>;
    assert.equal(payload.renderedInTerminal, true);
    assert.equal(payload.returnedRowCount, 6);
    assert.equal(displayBlocks.length, 1);
    assert.match(displayBlocks[0]?.body ?? "", /SQL result rows 1-6 of 6:/);
  });

  await runTest("inspect_last_result stays inline even when the global large-output threshold is small", async () => {
    const config = createTestConfig();
    config.app.contextCompression.largeToolOutputChars = 80;
    const pushedMessages: Array<{ role: string; content: string }> = [];
    const persistedOutputs: Array<{ id: string; content: string }> = [];

    const failure = await executeAgentToolCall({
      toolCall: {
        id: "call_3",
        type: "function",
        function: {
          name: "inspect_last_result",
          arguments: JSON.stringify({ offset: 0, limit: 2, columns: ["id", "email", "create_time"] }),
        },
      },
      runtime: createToolRuntimeContext({
        getLastResult: () => ({
          sql: "select id, email, create_time from users order by create_time desc limit 2",
          operation: "SELECT",
          rowCount: 2,
          rows: [
            { id: 1, email: "a@example.com", create_time: "2026-04-18 10:00:00" },
            { id: 2, email: "b@example.com", create_time: "2026-04-18 09:00:00" },
          ],
          rowsTruncated: false,
          fields: ["id", "email", "create_time"],
          elapsedMs: 2,
        }),
      }),
      io: createTestIo(),
      config,
      memory: createSessionContextMemory(),
      currentTurnId: "turn-3",
      persistToolOutput: (entry) => {
        const persisted = {
          id: `tool-output-${persistedOutputs.length + 1}`,
          turnId: "turn-3",
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
    const payload = JSON.parse(pushedMessages[0]?.content ?? "{}") as Record<string, unknown>;
    const rows = payload.rows as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.create_time, "2026-04-18 10:00:00");
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
            matchedAliases: ["bookmark"],
            matchedColumns: ["user_id"],
            matchReasons: ["tag match", "column name overlap"],
            documentKinds: ["table", "column"],
            matchedSources: ["generated"],
            score: 82.3,
            semanticScore: 0.51,
            keywordScore: 31,
          },
          {
            tableName: "bm_tag",
            summaryText: "tags",
            description: "Stores bookmark tags.",
            tags: ["tag", "label", "bookmark"],
            matchedAliases: [],
            matchedColumns: ["user_id"],
            matchReasons: ["partial tag match"],
            documentKinds: ["table"],
            matchedSources: ["generated"],
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
