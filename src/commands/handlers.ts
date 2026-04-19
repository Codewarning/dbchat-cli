import path from "node:path";
import { AgentSession } from "../agent/session.js";
import { createDatabaseAdapter } from "../db/factory.js";
import { assessSqlSafety } from "../db/safety.js";
import { defaultPromptRuntime } from "../ui/prompts.js";
import { getConfigPath, getMaskedConfig, getMaskedResolvedConfig } from "../config/store.js";
import type { ChatRuntimeState } from "../repl/runtime.js";
import { initializeScopedInstructionFilesForDatabase } from "../services/scoped-instructions.js";
import { ensureLocalSchemaCatalogReady, initializeLocalSchemaCatalogOnEntry, refreshLocalSchemaCatalog, searchLocalSchemaCatalog } from "../services/schema-catalog.js";
import { executeManagedSql, explainSql } from "../services/sql.js";
import {
  addDatabaseConfig,
  addHostConfig,
  loadDatabaseConfigList,
  removeDatabaseConfig,
  removeHostConfig,
  updateDatabaseConfig,
  updateHostConfig,
  useDatabaseConfig,
  useHostConfig,
} from "./database-config.js";
import { updateEmbeddingConfig } from "./embedding-config.js";
import { printDatabaseConfigList } from "./database-config-helpers.js";
import {
  printQueryResult,
  printSchemaCatalogSearch,
  printSchemaCatalogSyncResult,
  printSchemaSummary,
  printTableSchema,
  createRuntimeContext,
  withResolvedConfig,
  withRuntime,
} from "./shared.js";
import { buildResultArtifactDisplayText } from "../ui/result-artifacts.js";
import type { DatabaseConfig } from "../types/index.js";

async function tryInitializeScopedInstructionFilesForTarget(target: DatabaseConfig): Promise<string | null> {
  let db = null;
  try {
    db = await createDatabaseAdapter(target);
    await db.testConnection();
    await initializeScopedInstructionFilesForDatabase(target, db);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

/**
 * Execute a one-shot natural-language task through the agent loop.
 */
export async function handleAskCommand(prompt: string): Promise<void> {
  await withRuntime(async ({ config, db, io }) => {
    try {
      await initializeScopedInstructionFilesForDatabase(config.database, db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.log(`Warning: failed to initialize scoped instruction files: ${message}`);
    }
    await initializeLocalSchemaCatalogOnEntry(config, db, io);
    const session = new AgentSession(config, db, io);
    const result = await session.run(prompt);
    io.logBlock("Final answer", result.content);
    for (const block of result.displayBlocks) {
      io.logBlock(block.title, block.body);
    }
    const artifactDisplay = buildResultArtifactDisplayText(result.lastResult?.htmlArtifact);
    if (artifactDisplay) {
      io.logBlock("Artifacts", artifactDisplay);
    }
  });
}

/**
 * Run a single SQL statement directly while preserving the same safety checks as tool execution.
 */
export async function handleSqlCommand(sql: string): Promise<void> {
  await withRuntime(async ({ config, db, io }) => {
    io.log("Running direct SQL command");
    const safety = assessSqlSafety(sql);
    io.logBlock("SQL input", sql);

    if (safety.warnings.length) {
      io.logBlock("SQL warnings", safety.warnings.join("\n"));
    }

    const execution = await executeManagedSql({
      config,
      db,
      io,
      sql,
      approvalState: { allowAllForCurrentTurn: false },
    });
    if (execution.status === "cancelled") {
      if (execution.cancelledBy !== "database_access") {
        io.log(execution.reason);
      }
      process.exitCode = 1;
      return;
    }

    printQueryResult(execution.result, config.app.tableRendering);
  });
}

/**
 * Run EXPLAIN directly without executing the underlying statement.
 */
export async function handleExplainCommand(sql: string): Promise<void> {
  await withRuntime(async ({ db, io }) => {
    io.log("Running direct EXPLAIN command");
    io.logBlock("SQL input", sql);
    const plan = await explainSql({ db, io, sql });
    console.log(`Operation: ${plan.operation}`);
    console.log(`Elapsed: ${plan.elapsedMs.toFixed(2)}ms`);
    if (plan.warnings.length) {
      io.logBlock("SQL warnings", plan.warnings.join("\n"));
    }
    io.log("Explain plan");
    console.log(JSON.stringify(plan.rawPlan, null, 2));
  });
}

/**
 * Show either a schema summary or a specific table definition.
 */
export async function handleSchemaCommand(tableName?: string, includeRowCount = false): Promise<void> {
  await withRuntime(async ({ db, io }) => {
    io.log("Running schema inspection");
    if (tableName) {
      const schema = await io.withLoading(`Loading schema for table ${tableName}`, () => db.describeTable(tableName));
      printTableSchema(schema);
      return;
    }

    const loadingLabel = includeRowCount ? "Loading schema summary with live row counts" : "Loading schema summary";
    const summary = await io.withLoading(loadingLabel, () => db.getSchemaSummary({ includeRowCount }));
    printSchemaSummary(summary);
  });
}

/**
 * Launch the interactive chat REPL.
 */
export async function handleChatCommand(): Promise<void> {
  const runtime = await createRuntimeContext({
    loggerProfile: "verbose",
    showLifecycleLogs: false,
  });
  try {
    await initializeScopedInstructionFilesForDatabase(runtime.config.database, runtime.db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.log(`Warning: failed to initialize scoped instruction files: ${message}`);
  }
  await initializeLocalSchemaCatalogOnEntry(runtime.config, runtime.db, runtime.io);
  const state: ChatRuntimeState = {
    config: runtime.config,
    db: runtime.db,
    session: null,
  };

  const startReadlineFallback = async (reason: string) => {
    runtime.io.log(`Ink chat UI is unavailable in the current environment. Falling back to the plain REPL. Reason: ${reason}`);
    const { startReadlineChatRepl } = await import("../repl/chat-readline.js");
    await startReadlineChatRepl(state, runtime.io);
  };

  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await startReadlineFallback("Ink requires a TTY terminal.");
      return;
    }

    try {
      const { startInkChatRepl } = await import("../repl/chat-ink.js");
      await startInkChatRepl(state, runtime.io);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/tty|terminal|raw mode|stdout|stdin|current environment|screen/i.test(message)) {
        throw error;
      }

      await startReadlineFallback(message);
    }
  } finally {
    if (state.db) {
      await runtime.io.withLoading("Closing active database connection", () => state.db!.close());
      state.db = null;
    }
  }
}

/**
 * Refresh the local schema catalog for the active database target.
 */
export async function handleCatalogSyncCommand(): Promise<void> {
  await withRuntime(async ({ config, db, io }) => {
    const synced = await refreshLocalSchemaCatalog(config, db, io);
    printSchemaCatalogSyncResult(synced.result);
  });
}

/**
 * Search the local schema catalog without opening a chat session.
 */
export async function handleCatalogSearchCommand(query: string, limit: number): Promise<void> {
  await withResolvedConfig(async ({ config, io }) => {
    const ready = await ensureLocalSchemaCatalogReady(config, io);
    const search = await searchLocalSchemaCatalog(config, ready.catalog, query, limit);
    printSchemaCatalogSearch(search);
  });
}

/**
 * Print stored config plus the resolved runtime config with secrets redacted for safe inspection.
 */
export async function handleConfigShowCommand(): Promise<void> {
  const projectEnvPath = path.join(process.cwd(), ".env");
  const maskedStored = await getMaskedConfig();
  console.log(`Config file: ${getConfigPath()}`);
  console.log(`Config resolution order: shell env > stored config > ${projectEnvPath} > built-in defaults`);
  console.log("Stored config:");
  console.log(JSON.stringify(maskedStored, null, 2));

  try {
    const maskedResolved = await getMaskedResolvedConfig();
    console.log("Resolved runtime config:");
    console.log(JSON.stringify(maskedResolved, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("Resolved runtime config:");
    console.log(`(unavailable: ${message})`);
  }
}

/**
 * Update the stored embedding provider configuration.
 */
export async function handleConfigEmbeddingUpdateCommand(): Promise<void> {
  const result = await updateEmbeddingConfig(defaultPromptRuntime);
  console.log(result.message);
}

/**
 * Print all stored host/database configs plus the active selection.
 */
export async function handleConfigDbListCommand(): Promise<void> {
  const config = await loadDatabaseConfigList();
  console.log(`Config file: ${getConfigPath()}`);
  printDatabaseConfigList(config);
}

/**
 * Add one new host config with its first database entry.
 */
export async function handleConfigDbAddHostCommand(name: string): Promise<void> {
  const result = await addHostConfig(defaultPromptRuntime, name);
  console.log(result.message);
}

/**
 * Update one existing host config without touching its database list.
 */
export async function handleConfigDbUpdateHostCommand(hostName?: string): Promise<void> {
  const result = await updateHostConfig(defaultPromptRuntime, hostName);
  console.log(result.message);
}

/**
 * Remove one host config and all databases grouped under it.
 */
export async function handleConfigDbRemoveHostCommand(hostName?: string): Promise<void> {
  const result = await removeHostConfig(defaultPromptRuntime, hostName);
  console.log(result.message);
}

/**
 * Switch the active host config and default its active database to the first entry under that host.
 */
export async function handleConfigDbUseHostCommand(hostName?: string): Promise<void> {
  const result = await useHostConfig(defaultPromptRuntime, hostName);
  console.log(result.message);
  if (result.nextActiveTarget) {
    const bootstrapError = await tryInitializeScopedInstructionFilesForTarget(result.nextActiveTarget);
    if (bootstrapError) {
      console.log(`Warning: switched the active target, but initializing scoped instruction files failed: ${bootstrapError}`);
    }
  }
}

/**
 * Add one new database entry under the selected host config.
 */
export async function handleConfigDbAddDatabaseCommand(databaseName: string, hostName?: string): Promise<void> {
  const result = await addDatabaseConfig(defaultPromptRuntime, databaseName, hostName);
  console.log(result.message);
}

/**
 * Update one database entry under the selected host config.
 */
export async function handleConfigDbUpdateDatabaseCommand(databaseName?: string, hostName?: string): Promise<void> {
  const result = await updateDatabaseConfig(defaultPromptRuntime, databaseName, hostName);
  console.log(result.message);
}

/**
 * Remove one database entry from the selected host config.
 */
export async function handleConfigDbRemoveDatabaseCommand(databaseName?: string, hostName?: string): Promise<void> {
  const result = await removeDatabaseConfig(defaultPromptRuntime, databaseName, hostName);
  console.log(result.message);
}

/**
 * Switch the active database under the selected or active host config.
 */
export async function handleConfigDbUseDatabaseCommand(databaseName?: string, hostName?: string): Promise<void> {
  const result = await useDatabaseConfig(defaultPromptRuntime, databaseName, hostName);
  console.log(result.message);
  if (result.nextActiveTarget) {
    const bootstrapError = await tryInitializeScopedInstructionFilesForTarget(result.nextActiveTarget);
    if (bootstrapError) {
      console.log(`Warning: switched the active target, but initializing scoped instruction files failed: ${bootstrapError}`);
    }
  }
}
