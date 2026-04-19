import { AgentSession } from "../agent/session.js";
import { persistNormalizedDatabaseSelectionForConnection } from "../config/database-hosts.js";
import { loadNormalizedStoredConfig, resolveAppConfig, saveNormalizedStoredConfig } from "../config/store.js";
import { DEFAULT_DATABASE_OPERATION_ACCESS } from "../db/operation-access.js";
import { formatDatabaseOperationAccess } from "../db/operation-access.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { createDatabaseAdapter } from "../db/factory.js";
import { initializeScopedInstructionFilesForDatabase } from "../services/scoped-instructions.js";
import { initializeLocalSchemaCatalogOnEntry } from "../services/schema-catalog.js";
import type { AgentIO, AppConfig, DatabaseConfig, DatabaseOperationAccess } from "../types/index.js";
import type { DatabaseConfigCommandOutcome } from "../commands/database-config.js";

export interface ChatRuntimeState {
  config: AppConfig | null;
  db: DatabaseAdapter | null;
  session: AgentSession | null;
}

export interface RuntimeSwitchOutcome {
  notices: string[];
  runtimeChanged: boolean;
  connectionChanged: boolean;
  clearedConversation: boolean;
}

/**
 * Format one database target for human-facing runtime messages.
 */
export function formatDatabaseTarget(target: DatabaseConfig | null | undefined): string {
  if (!target) {
    return "(none)";
  }

  const schema = target.schema ? ` schema=${target.schema}` : "";
  return `${target.dialect} ${target.host}:${target.port}/${target.database}${schema} access=${formatDatabaseOperationAccess(target.operationAccess)}`;
}

/**
 * Format only the connection identity shown in the runtime header.
 */
export function formatDatabaseConnectionTarget(target: DatabaseConfig | null | undefined): string {
  if (!target) {
    return "(none)";
  }

  const schema = target.schema ? ` schema=${target.schema}` : "";
  return `${target.dialect} ${target.host}:${target.port}/${target.database}${schema}`;
}

/**
 * Format only the permission label shown in the runtime header.
 */
export function formatDatabasePermission(target: DatabaseConfig | null | undefined): string {
  if (!target) {
    return "(none)";
  }

  return formatDatabaseOperationAccess(target.operationAccess);
}

/**
 * Compare two runtime connection configs to decide whether the adapter must be recreated.
 */
function sameRuntimeDatabaseConfig(left: DatabaseConfig | null | undefined, right: DatabaseConfig | null | undefined): boolean {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.dialect === right.dialect &&
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.username === right.username &&
    left.password === right.password &&
    left.schema === right.schema &&
    left.ssl === right.ssl
  );
}

/**
 * Compare the runtime SQL access policy independently from the database connection details.
 */
function sameRuntimeOperationAccess(left: DatabaseConfig | null | undefined, right: DatabaseConfig | null | undefined): boolean {
  if (!left || !right) {
    return !left && !right;
  }

  return left.operationAccess === right.operationAccess;
}

/**
 * Compare only the schema-level database identity used by conversation memory.
 */
export function sameConversationTarget(left: DatabaseConfig | null | undefined, right: DatabaseConfig | null | undefined): boolean {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.dialect === right.dialect &&
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.schema === right.schema
  );
}

/**
 * Connect the live REPL runtime to one resolved config target and refresh the local schema catalog.
 */
async function activateRuntimeTarget(
  nextConfig: AppConfig,
  state: ChatRuntimeState,
  chatIo: AgentIO,
  io: AgentIO,
): Promise<{ runtimeChanged: boolean; clearedConversation: boolean; connectionChanged: boolean }> {
  const connectionChanged = !sameRuntimeDatabaseConfig(state.config?.database, nextConfig.database);
  const accessChanged = !sameRuntimeOperationAccess(state.config?.database, nextConfig.database);
  const runtimeChanged = connectionChanged || accessChanged;
  if (!runtimeChanged) {
    return {
      runtimeChanged: false,
      clearedConversation: false,
      connectionChanged: false,
    };
  }

  if (!connectionChanged) {
    if (!state.db) {
      throw new Error("The current database adapter is unavailable.");
    }

    state.config = nextConfig;
    if (state.session) {
      state.session.replaceRuntime(nextConfig, state.db);
    } else {
      state.session = new AgentSession(nextConfig, state.db, chatIo);
    }

    return {
      runtimeChanged: true,
      clearedConversation: false,
      connectionChanged: false,
    };
  }

  let nextDb: DatabaseAdapter | null = null;
  try {
    const createdDb = await io.withLoading("Creating database adapter", () => createDatabaseAdapter(nextConfig.database));
    nextDb = createdDb;
    await io.withLoading("Testing switched database connection", () => createdDb.testConnection());
  } catch (error) {
    if (nextDb) {
      await nextDb.close();
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to the updated database target: ${message}`);
  }

  if (!nextDb) {
    throw new Error("Failed to create the updated database adapter.");
  }

  const shouldClearConversation = !sameConversationTarget(state.config?.database, nextConfig.database);

  if (state.db) {
    await io.withLoading("Closing previous database connection", () => state.db!.close());
  }

  state.config = nextConfig;
  state.db = nextDb;

  if (state.session) {
    state.session.replaceRuntime(nextConfig, nextDb);
    if (shouldClearConversation) {
      state.session.clearConversation();
    }
  } else {
    state.session = new AgentSession(nextConfig, nextDb, chatIo);
  }

  try {
    await initializeScopedInstructionFilesForDatabase(nextConfig.database, nextDb);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    chatIo.log(`Warning: failed to initialize scoped instruction files: ${message}`);
  }

  await initializeLocalSchemaCatalogOnEntry(nextConfig, nextDb, chatIo);

  return {
    runtimeChanged: true,
    clearedConversation: shouldClearConversation,
    connectionChanged: true,
  };
}

async function persistRuntimeDatabaseSelection(nextDatabase: DatabaseConfig): Promise<{
  persisted: boolean;
  addedDatabase: boolean;
  updatedSchema: boolean;
}> {
  const storedConfig = await loadNormalizedStoredConfig();
  const persisted = persistNormalizedDatabaseSelectionForConnection(storedConfig, nextDatabase);
  if (!persisted.persisted) {
    return {
      persisted: false,
      addedDatabase: false,
      updatedSchema: false,
    };
  }

  await saveNormalizedStoredConfig(storedConfig);
  return {
    persisted: true,
    addedDatabase: persisted.addedDatabase,
    updatedSchema: persisted.updatedSchema,
  };
}

/**
 * Switch the live REPL runtime to another database on the current host without requiring it to be pre-saved in config.
 */
export async function switchRuntimeToDatabase(
  databaseName: string,
  schema: string | undefined,
  operationAccess: DatabaseOperationAccess | undefined,
  state: ChatRuntimeState,
  chatIo: AgentIO,
  io: AgentIO,
): Promise<RuntimeSwitchOutcome> {
  if (!state.config) {
    throw new Error("No active database is configured. Add or switch to a database first.");
  }

  const nextDatabaseName = databaseName.trim();
  if (!nextDatabaseName) {
    throw new Error("Database name cannot be empty.");
  }

  const currentDatabase = state.config.database;
  const schemaCandidates =
    currentDatabase.dialect === "postgres"
      ? Array.from(new Set([schema, currentDatabase.schema, undefined]))
      : [undefined];
  const triedSchemas = new Set<string>();
  let lastError: Error | null = null;

  for (const candidateSchema of schemaCandidates) {
    const schemaKey = candidateSchema ?? "__default__";
    if (triedSchemas.has(schemaKey)) {
      continue;
    }

    triedSchemas.add(schemaKey);

    const nextConfig: AppConfig = {
      ...state.config,
      database: {
        ...currentDatabase,
        database: nextDatabaseName,
        schema: currentDatabase.dialect === "postgres" ? candidateSchema : undefined,
        operationAccess: operationAccess ?? currentDatabase.operationAccess,
      },
    };

    try {
      const result = await activateRuntimeTarget(nextConfig, state, chatIo, io);
      const notices: string[] = [];
      if (!result.runtimeChanged) {
        notices.push(`Already connected to ${formatDatabaseTarget(nextConfig.database)}.`);
        return {
          notices,
          runtimeChanged: false,
          connectionChanged: false,
          clearedConversation: false,
        };
      }

      if (!result.connectionChanged) {
        notices.push(`Active database access updated: ${formatDatabaseTarget(nextConfig.database)}.`);
        return {
          notices,
          runtimeChanged: true,
          connectionChanged: false,
          clearedConversation: false,
        };
      }

      if (currentDatabase.dialect === "postgres" && currentDatabase.schema && candidateSchema == null) {
        notices.push(
          `Schema '${currentDatabase.schema}' was not reused for database '${nextDatabaseName}'. Switched using the default schema.`,
        );
      }

      if (result.clearedConversation) {
        notices.push(`Active database target changed to ${formatDatabaseTarget(nextConfig.database)}. Session and terminal cleared.`);
      } else {
        notices.push(`Active database connection reloaded: ${formatDatabaseTarget(nextConfig.database)}.`);
      }

      try {
        const persistedSelection = await persistRuntimeDatabaseSelection(nextConfig.database);
        if (!persistedSelection.persisted) {
          notices.push("The runtime database changed, but the host is not stored in local config, so the default selection was not updated.");
        } else if (persistedSelection.addedDatabase) {
          notices.push(`Saved '${nextConfig.database.database}' as the default database for future sessions on this host.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notices.push(`Warning: the runtime database changed, but saving the new default database failed: ${message}`);
      }

      return {
        notices,
        runtimeChanged: true,
        connectionChanged: true,
        clearedConversation: result.clearedConversation,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`Failed to switch to database '${nextDatabaseName}'.`);
}

/**
 * Apply a saved config change to the live REPL runtime, rolling back if the new target cannot be used.
 */
export async function synchronizeRuntimeAfterConfigChange(
  outcome: DatabaseConfigCommandOutcome,
  state: ChatRuntimeState,
  chatIo: AgentIO,
  io: AgentIO,
  operationAccess?: DatabaseOperationAccess,
): Promise<RuntimeSwitchOutcome> {
  const notices: string[] = [];
  let connectionChanged = false;
  let clearedConversation = false;

  if (!outcome.nextActiveTarget) {
    if (state.db) {
      await io.withLoading("Closing database connection", () => state.db!.close());
    }

    state.config = null;
    state.db = null;
    state.session = null;
    notices.push("No active database is configured now. Session and terminal cleared.");
    return {
      notices,
      runtimeChanged: true,
      connectionChanged: true,
      clearedConversation: true,
    };
  }

  let nextConfig: AppConfig;
  try {
    nextConfig = await resolveAppConfig();
    const targetChanged = !sameConversationTarget(state.config?.database, nextConfig.database);
    nextConfig = {
      ...nextConfig,
      database: {
        ...nextConfig.database,
        operationAccess:
          operationAccess ??
          (targetChanged ? DEFAULT_DATABASE_OPERATION_ACCESS : state.config?.database.operationAccess ?? nextConfig.database.operationAccess),
      },
    };
  } catch (error) {
    await saveNormalizedStoredConfig(outcome.previousConfig);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The updated database config is not runnable: ${message}. Restored the previous selection.`);
  }

  const storedSelectionOverridden = !sameRuntimeDatabaseConfig(outcome.nextActiveTarget, nextConfig.database);
  const runtimeChanged =
    !sameRuntimeDatabaseConfig(state.config?.database, nextConfig.database) ||
    !sameRuntimeOperationAccess(state.config?.database, nextConfig.database);

  if (!runtimeChanged) {
    if (storedSelectionOverridden) {
      notices.push("Stored selection changed, but the current runtime target is still controlled by environment overrides.");
    }

    return {
      notices,
      runtimeChanged: false,
      connectionChanged: false,
      clearedConversation: false,
    };
  }

  try {
    const result = await activateRuntimeTarget(nextConfig, state, chatIo, io);
    connectionChanged = result.connectionChanged;
    clearedConversation = result.clearedConversation;

    if (storedSelectionOverridden) {
      notices.push("Stored selection changed, but the current runtime target is still controlled by environment overrides.");
    }

    if (!result.connectionChanged) {
      notices.push(`Active database access updated: ${formatDatabaseTarget(nextConfig.database)}.`);
    } else if (result.clearedConversation) {
      notices.push(`Active database target changed to ${formatDatabaseTarget(nextConfig.database)}. Session and terminal cleared.`);
    } else {
      notices.push(`Active database connection reloaded: ${formatDatabaseTarget(nextConfig.database)}.`);
    }
  } catch (error) {
    await saveNormalizedStoredConfig(outcome.previousConfig);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. Restored the previous selection.`);
  }

  return {
    notices,
    runtimeChanged: true,
    connectionChanged,
    clearedConversation,
  };
}
