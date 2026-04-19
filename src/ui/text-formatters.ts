import type { NormalizedStoredConfig } from "../config/database-hosts.js";
import type { SchemaSummary, TableSchema } from "../types/index.js";
import { formatRecordsTable } from "./text-table.js";
import { buildDatabaseConfigRows, buildSchemaSummaryRows, buildTableSchemaRows } from "./rows.js";

/**
 * Format the stored host/database config list as terminal-safe plain text.
 */
export function formatDatabaseConfigListText(config: NormalizedStoredConfig): string {
  if (!config.databaseHosts.length) {
    return "No database host configs are stored.";
  }

  return [
    formatRecordsTable(buildDatabaseConfigRows(config), [
      "activeHost",
      "activeDatabase",
      "hostConfig",
      "dialect",
      "host",
      "port",
      "username",
      "database",
      "schema",
      "ssl",
    ]),
    `Active host: ${config.activeDatabaseHost ? `${config.activeDatabaseHost}:${config.activeDatabasePort ?? "?"}` : "(none)"}`,
    `Active database: ${config.activeDatabaseName ?? "(none)"}`,
  ].join("\n");
}

/**
 * Format a schema summary as terminal-safe plain text.
 */
export function formatSchemaSummaryText(summary: SchemaSummary): string {
  const lines = [`Database: ${summary.database}`];
  if (summary.schema) {
    lines.push(`Schema: ${summary.schema}`);
  }

  const hasRowCounts = summary.tables.some((table) => typeof table.rowCount === "number");
  lines.push(formatRecordsTable(buildSchemaSummaryRows(summary), hasRowCounts ? ["tableName", "rowCount"] : ["tableName"]));
  return lines.join("\n");
}

/**
 * Format a single table schema as terminal-safe plain text.
 */
export function formatTableSchemaText(schema: TableSchema): string {
  if (schema.ddlPreview) {
    const sourceLabel = schema.ddlSource === "native" ? "native database DDL" : "reconstructed DDL";
    return [`-- DDL source: ${sourceLabel}`, schema.ddlPreview].join("\n");
  }

  return [`Table: ${schema.tableName}`, formatRecordsTable(buildTableSchemaRows(schema), ["name", "dataType", "isNullable", "defaultValue"])].join("\n");
}
