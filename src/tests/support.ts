import type { DatabaseAdapter } from "../db/adapter.js";
import type { ToolRuntimeContext } from "../tools/specs.js";
import type { AgentIO, AppConfig } from "../types/index.js";

export type RunTest = (name: string, test: () => void | Promise<void>) => Promise<void>;

export async function runTest(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

export function createTestConfig(): AppConfig {
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
      tempArtifactRetentionDays: 3,
      tableRendering: {
        inlineRowLimit: 10,
        inlineColumnLimit: 8,
        previewRowLimit: 10,
      },
      contextCompression: {
        recentRawTurns: 2,
        rawHistoryChars: 7000,
        largeToolOutputChars: 2400,
        persistedToolPreviewChars: 1200,
        maxToolCallsPerTurn: 12,
        maxAgentIterations: 24,
      },
    },
  };
}

export function createTestIo(): AgentIO {
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

export function createDatabaseStub(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
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
      throw new Error("not used");
    },
    async explain() {
      throw new Error("not used");
    },
    async close() {},
    ...overrides,
  };
}

export function createToolRuntimeContext(overrides: Partial<ToolRuntimeContext> = {}): ToolRuntimeContext {
  return {
    config: createTestConfig(),
    db: createDatabaseStub(),
    io: createTestIo(),
    schemaCatalogCache: null,
    getPlan: () => [],
    setPlan() {},
    getLastResult: () => null,
    setLastResult() {},
    getLastExplain: () => null,
    setLastExplain() {},
    pushDisplayBlock() {},
    history: {
      inspectTurn: () => null,
      inspectPersistedOutput: () => null,
    },
    mutationApproval: { allowAllForCurrentTurn: false },
    ...overrides,
  };
}
