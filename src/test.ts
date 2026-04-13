import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isPlanResolved } from "./agent/plan.js";
import { buildSystemPrompt } from "./agent/prompts.js";
import { classifyUserRequestExecutionIntent } from "./agent/session.js";
import { ensureUniqueHostAddress, orderDatabaseNamesForSelection } from "./commands/database-config-helpers.js";
import { updateEmbeddingConfigInMemory } from "./commands/embedding-config.js";
import { promptEmbeddingConfig } from "./commands/embedding-config-helpers.js";
import { findDatabaseHostByConnection, persistNormalizedDatabaseSelectionForConnection } from "./config/database-hosts.js";
import { storedConfigSchema } from "./config/schema.js";
import { buildResolvedAppConfig } from "./config/store.js";
import { DEFAULT_ALIYUN_EMBEDDING_BASE_URL, DEFAULT_ALIYUN_EMBEDDING_MODEL } from "./config/defaults.js";
import type { DatabaseAdapter } from "./db/adapter.js";
import { applyResultRowLimit } from "./db/query-results.js";
import { assessSqlSafety, ensureSingleStatement } from "./db/safety.js";
import { embedTexts } from "./embedding/client.js";
import { getEmbeddingModelInfo } from "./embedding/config.js";
import { buildCreateTableDdl } from "./schema/table-ddl.js";
import { selectNextComposerHistoryEntry, selectPreviousComposerHistoryEntry } from "./repl/input-history.js";
import { parseSchemaCommandArgs, parseSlashCommand } from "./repl/slash-commands.js";
import { assessSchemaCatalogFreshness, findCatalogTable, shouldRefreshSchemaCatalogAfterSql, suggestCatalogTableNames } from "./schema/catalog.js";
import { executeSqlStatement } from "./sql/execution.js";
import { serializeToolResultForModel } from "./tools/model-payload.js";
import { executeTool } from "./tools/registry.js";
import type { AgentIO, AppConfig } from "./types/index.js";
import { formatSchemaSummaryText, formatTableSchemaText } from "./ui/text-formatters.js";
import type { PromptRuntime } from "./ui/prompts.js";

async function runTest(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createTestConfig(): AppConfig {
  return {
    llm: {
      provider: "openai",
      apiFormat: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    },
    embedding: {
      provider: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "embedding-test-key",
      model: "text-embedding-3-small",
    },
    database: {
      dialect: "postgres",
      host: "localhost",
      port: 5432,
      database: "testdb",
      username: "postgres",
      password: "secret",
      schema: "public",
      ssl: false,
      operationAccess: "read_only",
    },
    app: {
      resultRowLimit: 100,
      previewRowLimit: 10,
    },
  };
}

function createTestIo(): AgentIO {
  return {
    cwd: process.cwd(),
    log() {},
    logBlock() {},
    async confirm() {
      return false;
    },
    async approveSql() {
      return "reject";
    },
    async withLoading(_message, task) {
      return task();
    },
  };
}

async function main(): Promise<void> {
  await runTest("CTE mutation statements are classified as mutations", () => {
    const safety = assessSqlSafety(`
      WITH inactive_users AS (
        SELECT id
        FROM users
        WHERE last_seen_at < now() - interval '90 days'
      )
      UPDATE users
         SET active = false
       WHERE id IN (SELECT id FROM inactive_users)
    `);

    assert.equal(safety.operation, "UPDATE");
    assert.equal(safety.isMutation, true);
    assert.equal(safety.executionCategory, "dml");
  });

  await runTest("CTE select statements stay read-only", () => {
    const safety = assessSqlSafety(`
      WITH recent_orders AS (
        SELECT id, created_at
        FROM orders
        ORDER BY created_at DESC
        LIMIT 5
      )
      SELECT *
      FROM recent_orders
    `);

    assert.equal(safety.operation, "SELECT");
    assert.equal(safety.isMutation, false);
    assert.equal(safety.executionCategory, "read_only");
  });

  await runTest("DDL statements are classified separately from DML", () => {
    const safety = assessSqlSafety("create table audit_log(id int)");
    assert.equal(safety.operation, "CREATE");
    assert.equal(safety.executionCategory, "ddl");
  });

  await runTest("table schema changes trigger schema catalog refresh checks", () => {
    assert.equal(shouldRefreshSchemaCatalogAfterSql("create table audit_log(id int)", "CREATE"), true);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("alter table users add column nickname text", "ALTER"), true);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("drop table temp_users", "DROP"), true);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("create index idx_users_email on users(email)", "CREATE"), false);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("truncate table users", "TRUNCATE"), false);
  });

  await runTest("schema catalog freshness detects live schema drift", async () => {
    const db: DatabaseAdapter = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
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
      async describeTable() {
        throw new Error("not used");
      },
      async execute() {
        throw new Error("not used");
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

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

  await runTest("live database ordering keeps the current database first", () => {
    assert.deepEqual(orderDatabaseNamesForSelection(["analytics", "app", "mysql"], "app"), ["app", "analytics", "mysql"]);
    assert.deepEqual(orderDatabaseNamesForSelection(["analytics", "app", "mysql"], "APP"), ["app", "analytics", "mysql"]);
  });

  await runTest("stored hosts can be resolved by their runtime connection target", () => {
    const host = findDatabaseHostByConnection(
      {
        databaseHosts: [
          {
            name: "primary",
            dialect: "postgres",
            host: "127.0.0.1",
            port: 5432,
            username: "postgres",
            password: "secret",
            databases: [{ name: "app", schema: "tenant_a" }],
          },
        ],
      },
      {
        dialect: "postgres",
        host: "127.0.0.1",
        port: 5432,
      },
    );

    assert.equal(host?.name, "primary");
    assert.equal(host?.databases[0]?.schema, "tenant_a");
  });

  await runTest("runtime database switches are persisted as the next default selection", () => {
    const config = {
      databaseHosts: [
        {
          name: "primary",
          dialect: "postgres" as const,
          host: "127.0.0.1",
          port: 5432,
          username: "postgres",
          password: "secret",
          databases: [{ name: "app", schema: "public" }],
        },
      ],
      activeDatabaseHost: "primary",
      activeDatabaseName: "app",
    };

    const outcome = persistNormalizedDatabaseSelectionForConnection(config, {
      dialect: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database: "analytics",
      schema: "reporting",
    });

    assert.equal(outcome.persisted, true);
    assert.equal(outcome.addedDatabase, true);
    assert.equal(config.activeDatabaseHost, "primary");
    assert.equal(config.activeDatabaseName, "analytics");
    assert.deepEqual(config.databaseHosts[0]?.databases.map((database) => database.name), ["app", "analytics"]);
    assert.equal(config.databaseHosts[0]?.databases[1]?.schema, "reporting");
  });

  await runTest("runtime database persistence is skipped when no stored host matches the current connection", () => {
    const config = {
      databaseHosts: [
        {
          name: "primary",
          dialect: "postgres" as const,
          host: "127.0.0.1",
          port: 5432,
          username: "postgres",
          password: "secret",
          databases: [{ name: "app", schema: "public" }],
        },
      ],
      activeDatabaseHost: "primary",
      activeDatabaseName: "app",
    };

    const outcome = persistNormalizedDatabaseSelectionForConnection(config, {
      dialect: "postgres",
      host: "db.example.com",
      port: 5432,
      database: "analytics",
      schema: "public",
    });

    assert.equal(outcome.persisted, false);
    assert.equal(config.activeDatabaseHost, "primary");
    assert.equal(config.activeDatabaseName, "app");
    assert.deepEqual(config.databaseHosts[0]?.databases.map((database) => database.name), ["app"]);
  });

  await runTest("request intent classification prefers actual results for Chinese query wording", () => {
    assert.equal(classifyUserRequestExecutionIntent("查询用户信息及其分组数、标签数、书签数"), "read_only_results");
    assert.equal(classifyUserRequestExecutionIntent("只生成 SQL，不要执行"), "sql_only");
    assert.equal(classifyUserRequestExecutionIntent("help me with this database"), "neutral");
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
    const db: DatabaseAdapter = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        getSchemaSummaryCalls += 1;
        return {
          dialect: "postgres",
          database: "testdb",
          schema: "public",
          tables: [
            { tableName: "users" },
            { tableName: "roles" },
          ],
        };
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute() {
        throw new Error("not used");
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const result = await executeTool("list_live_tables", {}, {
      config: createTestConfig(),
      db,
      io: createTestIo(),
      schemaCatalogCache: null,
      getPlan: () => [],
      setPlan() {},
      getLastResult: () => null,
      setLastResult() {},
      mutationApproval: { allowAllForCurrentTurn: false },
    });

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

  await runTest("single-statement guard still rejects multiple statements", () => {
    assert.throws(() => ensureSingleStatement("select 1; select 2"), /Only a single SQL statement/i);
  });

  await runTest("single-statement guard allows a trailing comment after the terminator", () => {
    assert.doesNotThrow(() => ensureSingleStatement("select 1; -- trailing comment"));
  });

  await runTest("single-statement guard allows semicolons inside Postgres dollar-quoted strings", () => {
    assert.doesNotThrow(() => ensureSingleStatement("select $$a;b$$"));
  });

  await runTest("comment markers inside strings do not break CTE classification", () => {
    const safety = assessSqlSafety("with x as (select '--not comment' as value) select * from x");
    assert.equal(safety.operation, "SELECT");
    assert.equal(safety.executionCategory, "read_only");
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

  await runTest("applyResultRowLimit trims cached rows and marks truncation", () => {
    const result = applyResultRowLimit(
      "select * from users",
      "SELECT",
      4,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      ["id"],
      12.5,
      { maxRows: 2 },
    );

    assert.equal(result.rowCount, 4);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rowsTruncated, true);
  });

  await runTest("applyResultRowLimit keeps all rows when the cache limit is not exceeded", () => {
    const result = applyResultRowLimit("select 1", "SELECT", 1, [{ value: 1 }], ["value"], 1.2, { maxRows: 10 });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rowsTruncated, false);
  });

  await runTest("environment overrides take precedence over stored config", () => {
    const config = buildResolvedAppConfig(
      {
        llm: {
          provider: "openai",
          apiFormat: "openai",
          baseUrl: "https://stored.example/v1",
          apiKey: "stored-key",
          model: "stored-model",
        },
        embedding: {
          provider: "openai",
          baseUrl: "https://stored-embedding.example/v1",
          apiKey: "stored-embedding-key",
          model: "stored-embedding-model",
        },
        databaseHosts: [
          {
            name: "local",
            dialect: "postgres",
            host: "stored-host",
            port: 5432,
            username: "stored-user",
            password: "stored-pass",
            ssl: false,
            databases: [{ name: "stored-db", schema: "public" }],
          },
        ],
        activeDatabaseHost: "local",
        activeDatabaseName: "stored-db",
        app: {
          resultRowLimit: 200,
          previewRowLimit: 20,
        },
      },
      {
        DBCHAT_LLM_PROVIDER: "openai",
        DBCHAT_LLM_API_FORMAT: "openai",
        DBCHAT_LLM_BASE_URL: "https://env.example/v1",
        DBCHAT_API_KEY: "env-key",
        DBCHAT_LLM_MODEL: "env-model",
        DBCHAT_EMBEDDING_PROVIDER: "aliyun",
        DBCHAT_EMBEDDING_BASE_URL: "https://dashscope.example/compatible-mode/v1",
        DBCHAT_EMBEDDING_API_KEY: "embed-env-key",
        DBCHAT_EMBEDDING_MODEL: "text-embedding-v4",
        DBCHAT_DB_HOST: "env-host",
        DBCHAT_DB_PORT: "6543",
        DBCHAT_DB_NAME: "env-db",
        DBCHAT_DB_USER: "env-user",
        DBCHAT_DB_PASSWORD: "env-pass",
        DBCHAT_DB_SCHEMA: "analytics",
        DBCHAT_DB_SSL: "true",
        DBCHAT_RESULT_ROW_LIMIT: "500",
        DBCHAT_PREVIEW_ROW_LIMIT: "25",
      },
    );

    assert.equal(config.llm.baseUrl, "https://env.example/v1");
    assert.equal(config.llm.apiKey, "env-key");
    assert.equal(config.llm.model, "env-model");
    assert.equal(config.embedding.provider, "aliyun");
    assert.equal(config.embedding.baseUrl, "https://dashscope.example/compatible-mode/v1");
    assert.equal(config.embedding.apiKey, "embed-env-key");
    assert.equal(config.embedding.model, "text-embedding-v4");
    assert.equal(config.database.host, "env-host");
    assert.equal(config.database.port, 6543);
    assert.equal(config.database.database, "env-db");
    assert.equal(config.database.username, "env-user");
    assert.equal(config.database.password, "env-pass");
    assert.equal(config.database.schema, "analytics");
    assert.equal(config.database.ssl, true);
    assert.equal(config.database.operationAccess, "read_only");
    assert.equal(config.app.resultRowLimit, 500);
    assert.equal(config.app.previewRowLimit, 25);
  });

  await runTest("default embedding config uses the Aliyun preset", () => {
    const config = buildResolvedAppConfig({
      databaseHosts: [
        {
          name: "local",
          dialect: "postgres",
          host: "stored-host",
          port: 5432,
          username: "stored-user",
          password: "stored-pass",
          ssl: false,
          databases: [{ name: "stored-db", schema: "public" }],
        },
      ],
      activeDatabaseHost: "local",
      activeDatabaseName: "stored-db",
    }, {});

    assert.equal(config.embedding.provider, "aliyun");
    assert.equal(config.embedding.baseUrl, DEFAULT_ALIYUN_EMBEDDING_BASE_URL);
    assert.equal(config.embedding.model, DEFAULT_ALIYUN_EMBEDDING_MODEL);
    assert.equal(config.embedding.apiKey, "");
  });

  await runTest("embedding model identity is based on provider, base URL, and model", () => {
    const officialInfo = getEmbeddingModelInfo({
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
      apiKey: "first-key",
      model: "text-embedding-v4",
    });
    const mirrorInfo = getEmbeddingModelInfo({
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "second-key",
      model: "text-embedding-v4",
    });
    const alternateInfo = getEmbeddingModelInfo({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
      model: "text-embedding-3-small",
    });

    assert.equal(officialInfo.modelId, mirrorInfo.modelId);
    assert.notEqual(officialInfo.modelId, alternateInfo.modelId);
    assert.equal(officialInfo.baseUrl, DEFAULT_ALIYUN_EMBEDDING_BASE_URL);
    assert.equal(officialInfo.model, "text-embedding-v4");
  });

  await runTest("Aliyun embedding requests are split into batches of 10", async () => {
    const originalFetch = globalThis.fetch;
    const batchSizes: number[] = [];

    globalThis.fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { input: string | string[] };
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      batchSizes.push(inputs.length);

      return new Response(
        JSON.stringify({
          data: inputs.map((_value, index) => ({
            index,
            embedding: [inputs.length, index + 1],
          })),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    };

    try {
      const vectors = await embedTexts(
        Array.from({ length: 12 }, (_value, index) => `table ${index + 1}`),
        {
          config: {
            provider: "aliyun",
            baseUrl: DEFAULT_ALIYUN_EMBEDDING_BASE_URL,
            apiKey: "embed-key",
            model: DEFAULT_ALIYUN_EMBEDDING_MODEL,
          },
        },
      );

      assert.equal(vectors.length, 12);
      assert.deepEqual(batchSizes, [10, 2]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("embedding client retries with smaller batches when the provider rejects the batch size", async () => {
    const originalFetch = globalThis.fetch;
    const batchSizes: number[] = [];

    globalThis.fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { input: string | string[] };
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      batchSizes.push(inputs.length);

      if (inputs.length > 8) {
        return new Response(
          JSON.stringify({
            message: "Value error, batch size is invalid, it should not be larger than 8.: input.contents",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          data: inputs.map((_value, index) => ({
            index,
            embedding: [inputs.length, index + 1],
          })),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    };

    try {
      const vectors = await embedTexts(
        Array.from({ length: 12 }, (_value, index) => `table ${index + 1}`),
        {
          config: {
            provider: "custom",
            baseUrl: "https://emb.example/v1",
            apiKey: "embed-key",
            model: "emb-custom-001",
          },
        },
      );

      assert.equal(vectors.length, 12);
      assert.deepEqual(batchSizes, [12, 8, 4]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("embedding prompt supports provider presets and preserves existing keys when blank", async () => {
    const prompts: PromptRuntime = {
      async input() {
        throw new Error("input should not be used");
      },
      async password() {
        return "";
      },
      async confirm() {
        throw new Error("confirm should not be used");
      },
      async approveSql() {
        throw new Error("approveSql should not be used");
      },
      async select<T extends string>(message: string, _choices: Array<{ label: string; value: T }>, _defaultValue?: T): Promise<T> {
        assert.equal(message, "Select an embedding API provider");
        return "aliyun" as T;
      },
      async selectOrInput(message) {
        if (message === "Embedding API base URL") {
          return DEFAULT_ALIYUN_EMBEDDING_BASE_URL;
        }

        if (message === "Embedding model") {
          return "text-embedding-v3";
        }

        throw new Error(`Unexpected selectOrInput prompt: ${message}`);
      },
    };

    const embedding = await promptEmbeddingConfig(prompts, {
      provider: "openai",
      baseUrl: "https://stored-embedding.example/v1",
      apiKey: "stored-key",
      model: "text-embedding-3-small",
    });

    assert.deepEqual(embedding, {
      provider: "aliyun",
      baseUrl: DEFAULT_ALIYUN_EMBEDDING_BASE_URL,
      apiKey: "stored-key",
      model: "text-embedding-v3",
    });
  });

  await runTest("embedding config update only changes the embedding section", async () => {
    const prompts: PromptRuntime = {
      async input() {
        throw new Error("input should not be used");
      },
      async password() {
        return "new-embedding-key";
      },
      async confirm() {
        throw new Error("confirm should not be used");
      },
      async approveSql() {
        throw new Error("approveSql should not be used");
      },
      async select<T extends string>(_message: string, _choices: Array<{ label: string; value: T }>, _defaultValue?: T): Promise<T> {
        return "custom" as T;
      },
      async selectOrInput(message) {
        if (message === "Embedding API base URL") {
          return "https://emb.example/v1";
        }

        if (message === "Embedding model") {
          return "emb-custom-001";
        }

        throw new Error(`Unexpected selectOrInput prompt: ${message}`);
      },
    };

    const config = {
      llm: {
        provider: "openai" as const,
        apiFormat: "openai" as const,
        baseUrl: "https://llm.example/v1",
        apiKey: "llm-key",
        model: "gpt-5-mini",
      },
      embedding: {
        provider: "aliyun" as const,
        baseUrl: DEFAULT_ALIYUN_EMBEDDING_BASE_URL,
        apiKey: "old-embedding-key",
        model: "text-embedding-v4",
      },
      databaseHosts: [
        {
          name: "primary",
          dialect: "postgres" as const,
          host: "127.0.0.1",
          port: 5432,
          username: "postgres",
          password: "secret",
          databases: [{ name: "app", schema: "public" }],
        },
      ],
      activeDatabaseHost: "primary",
      activeDatabaseName: "app",
      app: {
        resultRowLimit: 200,
        previewRowLimit: 20,
      },
    };

    const outcome = await updateEmbeddingConfigInMemory(config, prompts);

    assert.equal(outcome.message, "Embedding configuration was updated.");
    assert.deepEqual(config.embedding, {
      provider: "custom",
      baseUrl: "https://emb.example/v1",
      apiKey: "new-embedding-key",
      model: "emb-custom-001",
    });
    assert.equal(config.llm?.baseUrl, "https://llm.example/v1");
    assert.equal(config.activeDatabaseHost, "primary");
    assert.equal(config.activeDatabaseName, "app");
    assert.equal(outcome.previousConfig.embedding?.provider, "aliyun");
    assert.equal(outcome.nextConfig.embedding?.provider, "custom");
  });

  await runTest("stored database entries reject the legacy operationAccess field", () => {
    assert.throws(
      () =>
        storedConfigSchema.parse({
          databaseHosts: [
            {
              name: "local",
              dialect: "postgres",
              host: "stored-host",
              port: 5432,
              username: "stored-user",
              password: "stored-pass",
              ssl: false,
              databases: [{ name: "stored-db", schema: "public", operationAccess: "select_update_delete" }],
            },
          ],
          activeDatabaseHost: "local",
          activeDatabaseName: "stored-db",
        }),
      /unrecognized key/i,
    );
  });

  await runTest("system prompt explains that blocked SQL does not reach approval", () => {
    const prompt = buildSystemPrompt(createTestConfig());
    assert.match(prompt, /blocked before execution and no terminal approval prompt will appear/i);
    assert.match(prompt, /Do not tell the user to confirm in the terminal in that case/i);
  });

  await runTest("host uniqueness allows the same host on a different port", () => {
    assert.doesNotThrow(() =>
      ensureUniqueHostAddress(
        {
          databaseHosts: [
            {
              name: "pg-local",
              dialect: "postgres",
              host: "127.0.0.1",
              port: 5432,
              username: "postgres",
              password: "secret",
              databases: [{ name: "app", schema: "public" }],
            },
          ],
        },
        {
          dialect: "mysql",
          host: "127.0.0.1",
          port: 3306,
        },
      ),
    );
  });

  await runTest("host uniqueness rejects the same dialect/host/port tuple", () => {
    assert.throws(
      () =>
        ensureUniqueHostAddress(
          {
            databaseHosts: [
              {
                name: "pg-local",
                dialect: "postgres",
                host: "127.0.0.1",
                port: 5432,
                username: "postgres",
                password: "secret",
                databases: [{ name: "app", schema: "public" }],
              },
            ],
          },
          {
            dialect: "postgres",
            host: "127.0.0.1",
            port: 5432,
          },
        ),
      /already exists/i,
    );
  });

  await runTest("Approve Once executes one DML statement without unlocking later approvals", async () => {
    const approveSqlCalls: string[] = [];
    let executeCount = 0;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql(message: string) {
        approveSqlCalls.push(message);
        return "approve_once";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute(sql: string) {
        executeCount += 1;
        return {
          sql,
          operation: "UPDATE" as const,
          rowCount: 1,
          rows: [],
          rowsTruncated: false,
          fields: [],
          elapsedMs: 1,
        };
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const approvalState = { allowAllForCurrentTurn: false };
    const first = await executeSqlStatement({
      db,
      io,
      sql: "update users set active = false where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update_delete",
      approvalState,
    });
    const second = await executeSqlStatement({
      db,
      io,
      sql: "delete from users where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update_delete",
      approvalState,
    });

    assert.equal(first.status, "executed");
    assert.equal(second.status, "executed");
    assert.equal(executeCount, 2);
    assert.equal(approveSqlCalls.length, 2);
    assert.equal(approvalState.allowAllForCurrentTurn, false);
  });

  await runTest("Approve All For Turn skips later prompts in the same request", async () => {
    let approveSqlCallCount = 0;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        approveSqlCallCount += 1;
        return "approve_all";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute(sql: string) {
        return {
          sql,
          operation: "ALTER" as const,
          rowCount: 0,
          rows: [],
          rowsTruncated: false,
          fields: [],
          elapsedMs: 1,
        };
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const approvalState = { allowAllForCurrentTurn: false };
    await executeSqlStatement({
      db,
      io,
      sql: "alter table users add column nickname text",
      resultRowLimit: 20,
      operationAccess: "select_update_delete_ddl",
      approvalState,
    });
    await executeSqlStatement({
      db,
      io,
      sql: "drop table temp_users",
      resultRowLimit: 20,
      operationAccess: "select_update_delete_ddl",
      approvalState,
    });

    assert.equal(approveSqlCallCount, 1);
    assert.equal(approvalState.allowAllForCurrentTurn, true);
  });

  await runTest("Reject cancels a mutating statement", async () => {
    let executeCalled = false;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        return "reject";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute() {
        executeCalled = true;
        throw new Error("not used");
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "delete from users where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update_delete",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "cancelled");
    assert.equal(executeCalled, false);
  });

  await runTest("read-only database access blocks UPDATE without approval", async () => {
    let executeCalled = false;
    let approveSqlCalled = false;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        approveSqlCalled = true;
        return "approve_once";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute() {
        executeCalled = true;
        throw new Error("not used");
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "update users set active = false where id = 1",
      resultRowLimit: 20,
      operationAccess: "read_only",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "cancelled");
    assert.match(outcome.reason, /read-only/i);
    assert.equal(executeCalled, false);
    assert.equal(approveSqlCalled, false);
  });

  await runTest("SELECT + INSERT + UPDATE access still blocks DELETE", async () => {
    let executeCalled = false;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        throw new Error("approveSql should not be called when access blocks the statement");
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute() {
        executeCalled = true;
        throw new Error("not used");
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "delete from users where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "cancelled");
    assert.match(outcome.reason, /DELETE is not allowed/i);
    assert.equal(executeCalled, false);
  });

  await runTest("SELECT + INSERT + UPDATE access allows INSERT with approval", async () => {
    let approveSqlCallCount = 0;
    let executeCallCount = 0;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        approveSqlCallCount += 1;
        return "approve_once";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = {
      async testConnection() {},
      async listDatabases() {
        return [];
      },
      async getSchemaSummary() {
        throw new Error("not used");
      },
      async getAllTableSchemas() {
        throw new Error("not used");
      },
      async describeTable() {
        throw new Error("not used");
      },
      async execute(sql: string) {
        executeCallCount += 1;
        return {
          sql,
          operation: "INSERT" as const,
          rowCount: 1,
          rows: [],
          rowsTruncated: false,
          fields: [],
          elapsedMs: 1,
        };
      },
      async explain() {
        throw new Error("not used");
      },
      async close() {},
    };

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "insert into users(id, name) values (1, 'alice')",
      resultRowLimit: 20,
      operationAccess: "select_update",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "executed");
    assert.equal(approveSqlCallCount, 1);
    assert.equal(executeCallCount, 1);
  });

  await runTest("cancelled SQL payload tells the model when access policy blocked execution", () => {
    const serialized = serializeToolResultForModel(
      "run_sql",
      {
        status: "cancelled",
        cancelledBy: "database_access",
        approvalPromptShown: false,
        reason: "SQL blocked by database access 'read-only': CREATE is not allowed.",
        sql: "create table users(id int)",
        operation: "CREATE",
        executionCategory: "ddl",
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.cancelledBy, "database_access");
    assert.equal(payload.approvalPromptShown, false);
    assert.match(serialized.summary, /blocked by database access policy/i);
  });

  await runTest("successful SQL payload includes a plain-text preview table", () => {
    const serialized = serializeToolResultForModel(
      "run_sql",
      {
        status: "executed",
        sql: "select email, bookmark_count from users limit 2",
        operation: "SELECT",
        rowCount: 2,
        rows: [
          { email: "admin@123.com", bookmark_count: 64 },
          { email: "test@example.com", bookmark_count: 0 },
        ],
        rowsTruncated: false,
        fields: ["email", "bookmark_count"],
        elapsedMs: 3.2,
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(typeof payload.previewTable, "string");
    assert.match(String(payload.previewTable), /email/);
    assert.match(String(payload.previewTable), /bookmark_count/);
    assert.match(String(payload.previewTable), /admin@123\.com/);
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

  await runTest("system prompt allows plain-text tables for query results", () => {
    const prompt = buildSystemPrompt(createTestConfig());
    assert.match(prompt, /plain monospace text tables/i);
    assert.match(prompt, /prefer showing a compact plain-text table preview/i);
    assert.match(prompt, /stop searching and explicitly say that the current schema likely does not contain that concept/i);
  });

  console.log("All tests passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
