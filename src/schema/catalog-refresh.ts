import type { DatabaseAdapter } from "../db/adapter.js";
import type { AgentIO, AppConfig, SchemaCatalogSyncResult, SqlOperation } from "../types/index.js";

export interface SchemaCatalogRefreshOutcome {
  status: "not_needed" | "manual_required";
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
 * Report when a successful schema-changing SQL statement leaves the local schema catalog stale.
 */
export async function refreshSchemaCatalogAfterSqlIfNeeded(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
  sql: string,
  operation: SqlOperation,
  allowRemoteRefresh = true,
): Promise<SchemaCatalogRefreshOutcome> {
  void config;
  void db;
  void allowRemoteRefresh;
  if (!shouldRefreshSchemaCatalogAfterSql(sql, operation)) {
    return {
      status: "not_needed",
      reason: "The executed SQL did not change tracked table structure.",
    };
  }

  io.log("Automatic schema catalog refresh is disabled after schema changes. Run `dbchat catalog sync` manually when you need updated schema search results.");
  return {
    status: "manual_required",
    reason: "The SQL statement changed tracked table structure. Automatic schema catalog refresh is disabled; run `dbchat catalog sync` manually when you need updated schema search results.",
  };
}
