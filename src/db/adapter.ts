// DatabaseAdapter is the narrow contract shared by the agent, CLI commands, and concrete drivers.
import type { QueryExecutionResult, QueryPlanResult, SchemaSummary, TableSchema } from "../types/index.js";
import type { QueryExecutionOptions } from "./query-results.js";

export type { QueryExecutionOptions } from "./query-results.js";

export interface SchemaSummaryOptions {
  includeRowCount?: boolean;
}

/**
 * Unified database API exposed to the rest of the CLI regardless of dialect.
 */
export interface DatabaseAdapter {
  /** Verify that the configured database connection is usable. */
  testConnection(): Promise<void>;
  /** Return the databases on the current host that are visible to the configured user. */
  listDatabases(): Promise<string[]>;
  /** Return a compact list of tables available to the assistant. */
  getSchemaSummary(options?: SchemaSummaryOptions): Promise<SchemaSummary>;
  /** Return ordered column definitions for all base tables in the active schema/database. */
  getAllTableSchemas(): Promise<TableSchema[]>;
  /** Return the full column definition for one table. */
  describeTable(tableName: string): Promise<TableSchema>;
  /** Execute one SQL statement and return rows plus execution metadata. */
  execute(sql: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult>;
  /** Produce a structured execution plan without mutating the database. */
  explain(sql: string): Promise<QueryPlanResult>;
  /** Close any underlying pools or connections. */
  close(): Promise<void>;
}
