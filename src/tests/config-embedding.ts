import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureUniqueHostAddress, orderDatabaseNamesForSelection, promptDatabaseHostConfig } from "../commands/database-config-helpers.js";
import { useDatabaseConfig } from "../commands/database-config.js";
import { updateEmbeddingConfigInMemory } from "../commands/embedding-config.js";
import { promptEmbeddingConfig } from "../commands/embedding-config-helpers.js";
import { handleInitCommand } from "../commands/init.js";
import { findDatabaseHostByConnection, getActiveDatabaseHost, normalizeStoredConfig, persistNormalizedDatabaseSelectionForConnection } from "../config/database-hosts.js";
import {
  DEFAULT_ALIYUN_EMBEDDING_BASE_URL,
  DEFAULT_ALIYUN_EMBEDDING_MODEL,
  DEFAULT_CONTEXT_COMPRESSION_CONFIG,
} from "../config/defaults.js";
import { storedConfigSchema } from "../config/schema.js";
import { loadProjectEnvDefaults } from "../config/env-file.js";
import { buildResolvedAppConfig, loadStoredConfig, saveNormalizedStoredConfig } from "../config/store.js";
import { embedTexts } from "../embedding/client.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import type { PromptRuntime } from "../ui/prompts.js";
import { RunTest } from "./support.js";

async function withTemporaryHome(test: () => Promise<void>): Promise<void> {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-config-home-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = temporaryHome;
  process.env.USERPROFILE = temporaryHome;

  try {
    await test();
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
}

export async function registerConfigAndEmbeddingTests(runTest: RunTest): Promise<void> {
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

  await runTest("active host selection can disambiguate the same host label with an explicit port pointer", () => {
    const config = normalizeStoredConfig({
      databaseHosts: [
        {
          name: "prod",
          dialect: "postgres",
          host: "121.41.85.176",
          port: 5432,
          username: "postgres",
          password: "secret",
          databases: [{ name: "app", schema: "public" }],
        },
        {
          name: "prod",
          dialect: "postgres",
          host: "121.41.85.176",
          port: 5433,
          username: "postgres",
          password: "secret",
          databases: [{ name: "analytics", schema: "public" }],
        },
      ],
      activeDatabaseHost: "prod",
      activeDatabasePort: 5433,
      activeDatabaseName: "analytics",
    });

    assert.equal(getActiveDatabaseHost(config)?.port, 5433);
    assert.equal(config.activeDatabasePort, 5433);
    assert.equal(config.activeDatabaseName, "analytics");
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

  await runTest("stored database switches do not require live discovery when the database is already saved locally", async () => {
    await withTemporaryHome(async () => {
      await saveNormalizedStoredConfig(
        normalizeStoredConfig({
          databaseHosts: [
            {
              name: "primary",
              dialect: "postgres",
              host: "127.0.0.1",
              port: 1,
              username: "postgres",
              password: "secret",
              databases: [
                { name: "app", schema: "public" },
                { name: "analytics", schema: "reporting" },
              ],
            },
          ],
          activeDatabaseHost: "primary",
          activeDatabaseName: "app",
        }),
      );

      const prompts: PromptRuntime = {
        async input() {
          throw new Error("input should not be used");
        },
        async password() {
          throw new Error("password should not be used");
        },
        async confirm() {
          throw new Error("confirm should not be used");
        },
        async approveSql() {
          throw new Error("approveSql should not be used");
        },
        async select() {
          throw new Error("select should not be used");
        },
        async selectOrInput() {
          throw new Error("selectOrInput should not be used");
        },
      };

      const outcome = await useDatabaseConfig(prompts, "analytics", "primary");
      const stored = normalizeStoredConfig(await loadStoredConfig());

      assert.equal(outcome.message, "Active database switched to 'analytics' under host 'primary'.");
      assert.equal(outcome.nextActiveTarget?.database, "analytics");
      assert.equal(stored.activeDatabaseHost, "primary");
      assert.equal(stored.activeDatabaseName, "analytics");
      assert.deepEqual(stored.databaseHosts[0]?.databases.map((database) => database.name), ["app", "analytics"]);
    });
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
        DBCHAT_LLM_PROVIDER: "deepseek",
        DBCHAT_LLM_API_FORMAT: "openai",
        DBCHAT_API_KEY: "env-key",
        DBCHAT_LLM_BASE_URL: "https://env.example/v1",
        DBCHAT_LLM_MODEL: "env-model",
        DBCHAT_DB_HOST: "env-host",
        DBCHAT_DB_PORT: "6543",
        DBCHAT_DB_NAME: "env-db",
        DBCHAT_DB_USER: "env-user",
        DBCHAT_DB_PASSWORD: "env-pass",
        DBCHAT_DB_SCHEMA: "analytics",
        DBCHAT_DB_SSL: "true",
        DBCHAT_RESULT_ROW_LIMIT: "500",
        DBCHAT_PREVIEW_ROW_LIMIT: "25",
        DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS: "9",
        DBCHAT_CONTEXT_RECENT_RAW_TURNS: "4",
        DBCHAT_CONTEXT_RAW_HISTORY_CHARS: "9000",
        DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS: "3100",
        DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS: "1500",
        DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN: "9",
        DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS: "30",
      },
    );

    assert.equal(config.llm.provider, "deepseek");
    assert.equal(config.llm.baseUrl, "https://env.example/v1");
    assert.equal(config.llm.apiKey, "env-key");
    assert.equal(config.llm.model, "env-model");
    assert.equal(config.database.host, "env-host");
    assert.equal(config.database.port, 6543);
    assert.equal(config.database.database, "env-db");
    assert.equal(config.database.username, "env-user");
    assert.equal(config.database.password, "env-pass");
    assert.equal(config.database.schema, "analytics");
    assert.equal(config.database.ssl, true);
    assert.equal(config.app.resultRowLimit, 500);
    assert.equal(config.app.previewRowLimit, 25);
    assert.equal(config.app.tempArtifactRetentionDays, 9);
    assert.equal(config.app.contextCompression.recentRawTurns, 4);
    assert.equal(config.app.contextCompression.rawHistoryChars, 9000);
    assert.equal(config.app.contextCompression.largeToolOutputChars, 3100);
    assert.equal(config.app.contextCompression.persistedToolPreviewChars, 1500);
    assert.equal(config.app.contextCompression.maxToolCallsPerTurn, 9);
    assert.equal(config.app.contextCompression.maxAgentIterations, 30);
  });

  await runTest("invalid numeric environment overrides are ignored instead of aborting config resolution", () => {
    const config = buildResolvedAppConfig(
      {
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
          contextCompression: {
            recentRawTurns: 2,
            rawHistoryChars: 7000,
            largeToolOutputChars: 2400,
            persistedToolPreviewChars: 1200,
            maxToolCallsPerTurn: 12,
            maxAgentIterations: 24,
          },
        },
      },
      {
        DBCHAT_DB_PORT: "-1",
        DBCHAT_RESULT_ROW_LIMIT: "-5",
        DBCHAT_PREVIEW_ROW_LIMIT: "0",
        DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS: "-2",
        DBCHAT_CONTEXT_RECENT_RAW_TURNS: "1.5",
        DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN: "NaN",
        DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS: "0",
      },
    );

    assert.equal(config.database.port, 5432);
    assert.equal(config.app.resultRowLimit, 200);
    assert.equal(config.app.previewRowLimit, 20);
    assert.equal(config.app.tempArtifactRetentionDays, 3);
    assert.equal(config.app.contextCompression.recentRawTurns, 2);
    assert.equal(config.app.contextCompression.maxToolCallsPerTurn, 12);
    assert.equal(config.app.contextCompression.maxAgentIterations, 24);
  });

  await runTest("project .env defaults apply below stored config and below runtime env", async () => {
    const temporaryWorkspace = await mkdtemp(path.join(os.tmpdir(), "dbchat-env-defaults-"));

    try {
      await writeFile(
        path.join(temporaryWorkspace, ".env"),
        [
          "# Project defaults for local development",
          "DBCHAT_LLM_PROVIDER=deepseek",
          "DBCHAT_LLM_BASE_URL=https://project.example/v1",
          "DBCHAT_LLM_MODEL=project-model",
          "DBCHAT_API_KEY=project-key",
          "DBCHAT_EMBEDDING_PROVIDER=openai",
          "DBCHAT_EMBEDDING_BASE_URL=https://project-embedding.example/v1",
          "DBCHAT_EMBEDDING_MODEL=project-embedding-model",
          "DBCHAT_EMBEDDING_API_KEY=project-embedding-key",
          "DBCHAT_DB_DIALECT=mysql",
          "DBCHAT_DB_HOST=project-host",
          "DBCHAT_DB_PORT=3307",
          "DBCHAT_DB_NAME=project-db",
          "DBCHAT_DB_USER=project-user",
          "DBCHAT_DB_PASSWORD=project-pass",
          "DBCHAT_DB_SCHEMA=reporting",
          "DBCHAT_DB_SSL=true",
          "DBCHAT_RESULT_ROW_LIMIT=150",
          "DBCHAT_PREVIEW_ROW_LIMIT=12",
          "DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS=6",
          "DBCHAT_INLINE_TABLE_ROW_LIMIT=5",
          "DBCHAT_INLINE_TABLE_COLUMN_LIMIT=6",
          "DBCHAT_PREVIEW_TABLE_ROW_LIMIT=5",
          "DBCHAT_CONTEXT_RECENT_RAW_TURNS=3",
          "DBCHAT_CONTEXT_RAW_HISTORY_CHARS=8000",
          "DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS=2800",
          "DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS=1300",
          "DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN=10",
          "DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS=28",
          "",
        ].join("\n"),
        "utf8",
      );

      const projectDefaults = await loadProjectEnvDefaults(temporaryWorkspace);
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
            provider: "aliyun",
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
          DBCHAT_LLM_MODEL: "runtime-model",
          DBCHAT_DB_PASSWORD: "runtime-pass",
        },
        projectDefaults,
      );

      assert.equal(config.llm.provider, "openai");
      assert.equal(config.llm.baseUrl, "https://stored.example/v1");
      assert.equal(config.llm.model, "runtime-model");
      assert.equal(config.llm.apiKey, "stored-key");
      assert.equal(config.embedding.provider, "aliyun");
      assert.equal(config.embedding.baseUrl, "https://stored-embedding.example/v1");
      assert.equal(config.embedding.apiKey, "stored-embedding-key");
      assert.equal(config.database.dialect, "postgres");
      assert.equal(config.database.host, "stored-host");
      assert.equal(config.database.port, 5432);
      assert.equal(config.database.database, "stored-db");
      assert.equal(config.database.username, "stored-user");
      assert.equal(config.database.password, "runtime-pass");
      assert.equal(config.app.tempArtifactRetentionDays, 6);
      assert.equal(config.database.schema, "public");
      assert.equal(config.database.ssl, false);
      assert.equal(config.app.resultRowLimit, 200);
      assert.equal(config.app.previewRowLimit, 20);
      assert.equal(config.app.tableRendering.inlineRowLimit, 5);
      assert.equal(config.app.tableRendering.inlineColumnLimit, 6);
      assert.equal(config.app.tableRendering.previewRowLimit, 5);
      assert.equal(config.app.contextCompression.recentRawTurns, 3);
      assert.equal(config.app.contextCompression.rawHistoryChars, 8000);
      assert.equal(config.app.contextCompression.largeToolOutputChars, 2800);
      assert.equal(config.app.contextCompression.persistedToolPreviewChars, 1300);
      assert.equal(config.app.contextCompression.maxToolCallsPerTurn, 10);
      assert.equal(config.app.contextCompression.maxAgentIterations, 28);
    } finally {
      await rm(temporaryWorkspace, { recursive: true, force: true });
    }
  });

  await runTest("init persists app runtime defaults from project .env instead of built-in context compression defaults", async () => {
    const temporaryWorkspace = await mkdtemp(path.join(os.tmpdir(), "dbchat-init-env-defaults-"));
    const originalCwd = process.cwd();

    await withTemporaryHome(async () => {
      try {
        await writeFile(
          path.join(temporaryWorkspace, ".env"),
          [
            "DBCHAT_RESULT_ROW_LIMIT=150",
            "DBCHAT_PREVIEW_ROW_LIMIT=12",
            "DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS=6",
            "DBCHAT_INLINE_TABLE_ROW_LIMIT=5",
            "DBCHAT_INLINE_TABLE_COLUMN_LIMIT=6",
            "DBCHAT_PREVIEW_TABLE_ROW_LIMIT=5",
            "DBCHAT_CONTEXT_RECENT_RAW_TURNS=3",
            "DBCHAT_CONTEXT_RAW_HISTORY_CHARS=8000",
            "DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS=2800",
            "DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS=1300",
            "DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN=10",
            "DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS=28",
            "",
          ].join("\n"),
          "utf8",
        );
        process.chdir(temporaryWorkspace);

        const prompts: PromptRuntime = {
          async input(message, defaultValue) {
            if (defaultValue) {
              return defaultValue;
            }

            switch (message) {
              case "Host config name":
                return "local";
              case "Database name":
                return "app";
              default:
                return "";
            }
          },
          async password(message, defaultValue) {
            if (defaultValue) {
              return defaultValue;
            }

            if (/embedding/i.test(message)) {
              return "embedding-test-key";
            }

            if (/database/i.test(message)) {
              return "database-test-password";
            }

            return "llm-test-key";
          },
          async confirm(_message, defaultValue) {
            return defaultValue ?? false;
          },
          async approveSql() {
            return "reject";
          },
          async select(_message, choices, defaultValue) {
            return defaultValue ?? choices[0]!.value;
          },
          async selectOrInput(_message, choices, defaultValue) {
            return defaultValue ?? choices[0]!.value;
          },
        };

        await handleInitCommand(prompts);
        const stored = await loadStoredConfig();

        assert.equal(stored.app?.resultRowLimit, 150);
        assert.equal(stored.app?.previewRowLimit, 12);
        assert.equal(stored.app?.tempArtifactRetentionDays, 6);
        assert.equal(stored.app?.tableRendering?.inlineRowLimit, 5);
        assert.equal(stored.app?.tableRendering?.inlineColumnLimit, 6);
        assert.equal(stored.app?.tableRendering?.previewRowLimit, 5);
        assert.equal(stored.app?.contextCompression?.recentRawTurns, 3);
        assert.equal(stored.app?.contextCompression?.rawHistoryChars, 8000);
        assert.equal(stored.app?.contextCompression?.largeToolOutputChars, 2800);
        assert.equal(stored.app?.contextCompression?.persistedToolPreviewChars, 1300);
        assert.equal(stored.app?.contextCompression?.maxToolCallsPerTurn, 10);
        assert.equal(stored.app?.contextCompression?.maxAgentIterations, 28);
      } finally {
        process.chdir(originalCwd);
        await rm(temporaryWorkspace, { recursive: true, force: true });
      }
    });
  });

  await runTest("default embedding config uses the Aliyun preset", () => {
    const config = buildResolvedAppConfig(
      {
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
      },
      {},
    );

    assert.equal(config.embedding.provider, "aliyun");
    assert.equal(config.embedding.baseUrl, DEFAULT_ALIYUN_EMBEDDING_BASE_URL);
    assert.equal(config.embedding.model, DEFAULT_ALIYUN_EMBEDDING_MODEL);
    assert.equal(config.embedding.apiKey, "");
    assert.deepEqual(config.app.contextCompression, DEFAULT_CONTEXT_COMPRESSION_CONFIG);
  });

  await runTest("stored app config accepts partial context compression overrides", () => {
    const parsed = storedConfigSchema.parse({
      app: {
        contextCompression: {
          maxToolCallsPerTurn: 7,
          maxAgentIterations: 19,
        },
      },
    });

    assert.equal(parsed.app?.contextCompression?.maxToolCallsPerTurn, 7);
    assert.equal(parsed.app?.contextCompression?.maxAgentIterations, 19);
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
      const vectors = await embedTexts(Array.from({ length: 12 }, (_value, index) => `table ${index + 1}`), {
        config: {
          provider: "aliyun",
          baseUrl: DEFAULT_ALIYUN_EMBEDDING_BASE_URL,
          apiKey: "embed-key",
          model: DEFAULT_ALIYUN_EMBEDDING_MODEL,
        },
      });

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
      const vectors = await embedTexts(Array.from({ length: 12 }, (_value, index) => `table ${index + 1}`), {
        config: {
          provider: "custom",
          baseUrl: "https://emb.example/v1",
          apiKey: "embed-key",
          model: "emb-custom-001",
        },
      });

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

  await runTest("database host prompts use mysql-specific defaults for port and username", async () => {
    const promptCalls: Array<{ message: string; defaultValue?: string }> = [];
    const prompts: PromptRuntime = {
      async input(message, defaultValue = "") {
        promptCalls.push({ message, defaultValue });
        if (message === "Host config name") {
          return "mysql-prod";
        }
        if (message === "Database host") {
          return "121.41.85.176";
        }
        if (message === "Database username") {
          return defaultValue;
        }
        throw new Error(`Unexpected input prompt: ${message}`);
      },
      async password() {
        return "secret";
      },
      async confirm() {
        return false;
      },
      async approveSql() {
        throw new Error("approveSql should not be used");
      },
      async select<T extends string>(message: string, _choices: Array<{ label: string; value: T }>, _defaultValue?: T): Promise<T> {
        if (message === "Select a database dialect") {
          return "mysql" as T;
        }
        throw new Error(`Unexpected select prompt: ${message}`);
      },
      async selectOrInput(message, _choices, defaultValue = "") {
        if (message === "Database port") {
          return defaultValue;
        }
        throw new Error(`Unexpected selectOrInput prompt: ${message}`);
      },
    };

    const result = await promptDatabaseHostConfig(prompts, {
      name: "pg-prod",
      dialect: "postgres",
      host: "121.41.85.176",
      port: 5432,
      username: "postgres",
      password: "secret",
      ssl: false,
    });

    assert.equal(result.dialect, "mysql");
    assert.equal(result.port, 3306);
    assert.equal(result.username, "root");
    assert.equal(promptCalls.find((entry) => entry.message === "Database username")?.defaultValue, "root");
  });

  await runTest("database host prompts keep postgres-specific defaults when postgres is selected", async () => {
    const promptCalls: Array<{ message: string; defaultValue?: string }> = [];
    const prompts: PromptRuntime = {
      async input(message, defaultValue = "") {
        promptCalls.push({ message, defaultValue });
        if (message === "Host config name") {
          return "pg-prod";
        }
        if (message === "Database host") {
          return "121.41.85.176";
        }
        if (message === "Database username") {
          return defaultValue;
        }
        throw new Error(`Unexpected input prompt: ${message}`);
      },
      async password() {
        return "secret";
      },
      async confirm() {
        return false;
      },
      async approveSql() {
        throw new Error("approveSql should not be used");
      },
      async select<T extends string>(message: string, _choices: Array<{ label: string; value: T }>, _defaultValue?: T): Promise<T> {
        if (message === "Select a database dialect") {
          return "postgres" as T;
        }
        throw new Error(`Unexpected select prompt: ${message}`);
      },
      async selectOrInput(message, _choices, defaultValue = "") {
        if (message === "Database port") {
          return defaultValue;
        }
        throw new Error(`Unexpected selectOrInput prompt: ${message}`);
      },
    };

    const result = await promptDatabaseHostConfig(prompts, {
      name: "pg-prod",
    });

    assert.equal(result.dialect, "postgres");
    assert.equal(result.port, 5432);
    assert.equal(result.username, "postgres");
    assert.equal(promptCalls.find((entry) => entry.message === "Database username")?.defaultValue, "postgres");
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
}
