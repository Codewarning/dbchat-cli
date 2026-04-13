import type { DatabaseAdapter } from "../db/adapter.js";
import type { AgentIO, AppConfig, SchemaCatalogSyncResult, SqlOperation } from "../types/index.js";
import { syncSchemaCatalog } from "./catalog-sync.js";

export interface SchemaCatalogRefreshOutcome {
  status: "not_needed" | "refreshed" | "failed" | "skipped";
  reason: string;
  result?: SchemaCatalogSyncResult;
  error?: string;
}

const TABLE_SCHEMA_CHANGE_OPERATIONS = new Set<SqlOperation>(["CREATE", "ALTER", "DROP", "RENAME"]);
const TABLE_SCHEMA_CHANGE_PATTERNS = [
  /^create\s+(temporary\s+|temp\s+|unlogged\s+)?table\b/i,
  /^alter\s+table\b/i,
  /^drop\s+table\b/i,
  /^rename\s+table\b/i,
];

/**
 * Remove leading whitespace and SQL comments so statement-shape checks can inspect the first real token.
 */
function stripLeadingSqlTrivia(sql: string): string {
  let remaining = sql.trimStart();

  while (remaining) {
    if (remaining.startsWith("--")) {
      const nextLineIndex = remaining.indexOf("\n");
      if (nextLineIndex === -1) {
        return "";
      }

      remaining = remaining.slice(nextLineIndex + 1).trimStart();
      continue;
    }

    if (remaining.startsWith("/*")) {
      const commentEndIndex = remaining.indexOf("*/");
      if (commentEndIndex === -1) {
        return remaining;
      }

      remaining = remaining.slice(commentEndIndex + 2).trimStart();
      continue;
    }

    break;
  }

  return remaining;
}

/**
 * Decide whether one executed SQL statement likely changed tracked table structure and therefore requires a catalog refresh.
 */
export function shouldRefreshSchemaCatalogAfterSql(sql: string, operation: SqlOperation): boolean {
  if (!TABLE_SCHEMA_CHANGE_OPERATIONS.has(operation)) {
    return false;
  }

  const normalizedSql = stripLeadingSqlTrivia(sql);
  return TABLE_SCHEMA_CHANGE_PATTERNS.some((pattern) => pattern.test(normalizedSql));
}

/**
 * Refresh the local schema catalog after a successful schema-changing SQL statement, while preserving the original SQL outcome if refresh fails.
 */
export async function refreshSchemaCatalogAfterSqlIfNeeded(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
  sql: string,
  operation: SqlOperation,
  allowRemoteRefresh = true,
): Promise<SchemaCatalogRefreshOutcome> {
  if (!shouldRefreshSchemaCatalogAfterSql(sql, operation)) {
    return {
      status: "not_needed",
      reason: "The executed SQL did not change tracked table structure.",
    };
  }

  if (!allowRemoteRefresh) {
    io.log("Schema catalog refresh skipped because remote data transfer was not approved.");
    return {
      status: "skipped",
      reason: "The SQL statement succeeded, but the schema catalog refresh was skipped because remote data transfer was not approved.",
    };
  }

  io.log("Refreshing local schema catalog after table schema change");

  try {
    const synced = await io.withLoading("Refreshing schema catalog", () => syncSchemaCatalog(config, db, io));
    io.log(
      `Schema catalog refreshed: ${synced.result.tableCount} tables, +${synced.result.addedTables.length} added, ~${synced.result.updatedTables.length} updated, -${synced.result.removedTables.length} removed`,
    );
    return {
      status: "refreshed",
      reason: "The executed SQL changed tracked table structure.",
      result: synced.result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.log(`Warning: schema catalog refresh failed after SQL execution: ${message}`);
    return {
      status: "failed",
      reason: "The SQL statement succeeded, but refreshing the local schema catalog failed.",
      error: message,
    };
  }
}
