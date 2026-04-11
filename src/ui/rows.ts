import type { NormalizedStoredConfig } from "../config/database-hosts.js";
import type { SchemaSummary, TableSchema } from "../types/index.js";

/**
 * Render the configured host/database combinations in a table-friendly format.
 */
export function buildDatabaseConfigRows(config: NormalizedStoredConfig): Array<Record<string, string | number>> {
  return config.databaseHosts.flatMap((host) => {
    if (!host.databases.length) {
      return [
        {
          activeHost: host.name === config.activeDatabaseHost ? "*" : "",
          activeDatabase: "",
          hostConfig: host.name,
          dialect: host.dialect,
          host: host.host,
          port: host.port,
          username: host.username,
          database: "(none)",
          schema: "",
          ssl: host.ssl ? "true" : "false",
        },
      ];
    }

    return host.databases.map((database) => ({
      activeHost: host.name === config.activeDatabaseHost ? "*" : "",
      activeDatabase: host.name === config.activeDatabaseHost && database.name === config.activeDatabaseName ? "*" : "",
      hostConfig: host.name,
      dialect: host.dialect,
      host: host.host,
      port: host.port,
      username: host.username,
      database: database.name,
      schema: database.schema ?? "",
      ssl: host.ssl ? "true" : "false",
    }));
  });
}

/**
 * Render a high-level schema summary in a table-friendly format.
 */
export function buildSchemaSummaryRows(summary: SchemaSummary): Array<Record<string, string | number>> {
  return summary.tables.map((table) => {
    const row: Record<string, string | number> = {
      tableName: table.tableName,
    };
    if (typeof table.rowCount === "number") {
      row.rowCount = table.rowCount;
    }
    return row;
  });
}

/**
 * Render the column list for a single table.
 */
export function buildTableSchemaRows(schema: TableSchema): Array<Record<string, string | boolean | null>> {
  return schema.columns.map((column) => ({
    name: column.name,
    dataType: column.dataType,
    isNullable: column.isNullable,
    defaultValue: column.defaultValue,
  }));
}
