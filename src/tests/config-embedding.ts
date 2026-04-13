import assert from "node:assert/strict";
import { ensureUniqueHostAddress, orderDatabaseNamesForSelection } from "../commands/database-config-helpers.js";
import { updateEmbeddingConfigInMemory } from "../commands/embedding-config.js";
import { promptEmbeddingConfig } from "../commands/embedding-config-helpers.js";
import { findDatabaseHostByConnection, persistNormalizedDatabaseSelectionForConnection } from "../config/database-hosts.js";
import { DEFAULT_ALIYUN_EMBEDDING_BASE_URL, DEFAULT_ALIYUN_EMBEDDING_MODEL } from "../config/defaults.js";
import { storedConfigSchema } from "../config/schema.js";
import { buildResolvedAppConfig } from "../config/store.js";
import { embedTexts } from "../embedding/client.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import type { PromptRuntime } from "../ui/prompts.js";
import { RunTest } from "./support.js";

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
