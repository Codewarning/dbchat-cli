// MySQL adapter backed by mysql2's promise API.
import { performance } from "node:perf_hooks";
import mysql from "mysql2/promise";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { DatabaseConfig, QueryExecutionResult, QueryPlanResult, SchemaSummary, TableColumn, TableSchema } from "../types/index.js";
import { buildTableSchema, type TableConstraintDefinition } from "./table-schema.js";
import { assessSqlSafety, inferSqlOperation } from "./safety.js";
import type { DatabaseAdapter, SchemaSummaryOptions } from "./adapter.js";
import type { QueryExecutionOptions } from "./query-results.js";
import { applyResultRowLimit } from "./query-results.js";

interface TableRow extends RowDataPacket {
  table_name: string;
  row_count: number;
}

interface TableNameRow extends RowDataPacket {
  table_name: string;
}

interface DatabaseRow extends RowDataPacket {
  Database: string;
}

interface ColumnRow extends RowDataPacket {
  table_name?: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  extra?: string | null;
}

interface ConstraintRow extends RowDataPacket {
  table_name: string;
  constraint_name: string;
  constraint_type: "PRIMARY KEY" | "UNIQUE";
  constraint_columns: string;
}

interface ShowCreateTableRow extends RowDataPacket {
  [key: string]: unknown;
}

function quoteMySqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function quoteMySqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toTableColumn(row: ColumnRow): TableColumn {
  return {
    name: row.column_name,
    dataType: row.extra?.toLowerCase().includes("auto_increment") ? `${row.data_type} AUTO_INCREMENT` : row.data_type,
    isNullable: row.is_nullable === "YES",
    defaultValue: row.column_default,
  };
}

function buildConstraintMap(rows: ConstraintRow[]): Map<string, TableConstraintDefinition[]> {
  const grouped = new Map<string, TableConstraintDefinition[]>();

  for (const row of rows) {
    const constraints = grouped.get(row.table_name) ?? [];
    constraints.push({
      constraintName: row.constraint_name,
      constraintType: row.constraint_type,
      columns: row.constraint_columns.split(",").map((column) => column.trim()).filter(Boolean),
    });
    grouped.set(row.table_name, constraints);
  }

  return grouped;
}

function groupTableSchemas(rows: ColumnRow[], constraintMap: Map<string, TableConstraintDefinition[]>): TableSchema[] {
  const grouped = new Map<string, TableColumn[]>();

  for (const row of rows) {
    const tableName = row.table_name;
    if (!tableName) {
      continue;
    }

    const columns = grouped.get(tableName) ?? [];
    columns.push(toTableColumn(row));
    grouped.set(tableName, columns);
  }

  return Array.from(grouped.entries())
    .map(([tableName, columns]) => buildTableSchema(tableName, columns, constraintMap.get(tableName) ?? [], undefined, "reconstructed"))
    .sort((left, right) => left.tableName.localeCompare(right.tableName));
}

function buildColumnMetadataQuery(includeTableFilter: boolean): string {
  return `
    select c.table_name, c.column_name, c.column_type as data_type, c.is_nullable, c.column_default, c.extra
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
   where c.table_schema = ?
     and t.table_type = 'BASE TABLE'
     ${includeTableFilter ? "and c.table_name = ?" : ""}
   order by c.table_name, c.ordinal_position
  `;
}

function buildConstraintMetadataQuery(includeTableFilter: boolean): string {
  return `
    select
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      group_concat(kcu.column_name order by kcu.ordinal_position separator ',') as constraint_columns
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_schema = tc.constraint_schema
     and kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
     and kcu.table_name = tc.table_name
   where tc.table_schema = ?
     and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
     ${includeTableFilter ? "and tc.table_name = ?" : ""}
   group by tc.table_name, tc.constraint_name, tc.constraint_type
   order by tc.table_name, tc.constraint_name
  `;
}

/**
 * MySQL implementation of the shared database adapter contract.
 */
export class MySqlAdapter implements DatabaseAdapter {
  private readonly pool: mysql.Pool;

  /**
   * Create a small connection pool for the configured MySQL target.
   */
  constructor(private readonly config: DatabaseConfig) {
    // A small pool is enough for a single-user CLI while still reusing connections efficiently.
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? {} : undefined,
      connectionLimit: 5,
      namedPlaceholders: false,
    });
  }

  /**
   * Verify the configured MySQL connection can run a trivial query.
   */
  async testConnection(): Promise<void> {
    await this.pool.query("select 1");
  }

  /**
   * Return the MySQL databases visible to the configured user.
   */
  async listDatabases(): Promise<string[]> {
    const [rows] = await this.pool.query<DatabaseRow[]>("SHOW DATABASES");
    return rows.map((row) => row.Database).sort((left, right) => left.localeCompare(right));
  }

  /**
   * Return a compact summary of base tables in the active database.
   */
  async getSchemaSummary(options?: SchemaSummaryOptions): Promise<SchemaSummary> {
    const includeRowCount = options?.includeRowCount ?? false;
    // Read from information_schema so the assistant can inspect actual table names instead of guessing.
    const [rows] = await this.pool.query<TableNameRow[]>(
      `
        select t.table_name
        from information_schema.tables t
       where t.table_schema = ?
         and t.table_type = 'BASE TABLE'
       order by t.table_name
      `,
      [this.config.database],
    );
    const tableNames = rows.map((row) => row.table_name);

    let rowCountsByTable = new Map<string, number>();
    if (includeRowCount && tableNames.length) {
      const rowCountSql = tableNames
        .map(
          (tableName) =>
            `select ${quoteMySqlLiteral(tableName)} as table_name, count(*) as row_count from ${quoteMySqlIdentifier(this.config.database)}.${quoteMySqlIdentifier(tableName)}`,
        )
        .join("\nunion all\n");
      const [rowCountRows] = await this.pool.query<TableRow[]>(rowCountSql);
      rowCountsByTable = new Map(rowCountRows.map((row) => [row.table_name, Number(row.row_count)]));
    }

    return {
      dialect: "mysql",
      database: this.config.database,
      schema: this.config.database,
      tables: tableNames.map((tableName) => ({
        tableName,
        rowCount: includeRowCount ? rowCountsByTable.get(tableName) ?? 0 : undefined,
      })),
    };
  }

  /**
   * Return ordered column metadata for all MySQL base tables in the active database.
   */
  async getAllTableSchemas(): Promise<TableSchema[]> {
    const [columnRows, constraintRows] = await Promise.all([
      this.pool.query<ColumnRow[]>(buildColumnMetadataQuery(false), [this.config.database]),
      this.pool.query<ConstraintRow[]>(buildConstraintMetadataQuery(false), [this.config.database]),
    ]);

    return groupTableSchemas(columnRows[0], buildConstraintMap(constraintRows[0]));
  }

  /**
   * Return ordered column metadata for one MySQL table.
   */
  async describeTable(tableName: string): Promise<TableSchema> {
    const [columnRows, constraintRows, showCreateRows] = await Promise.all([
      this.pool.query<ColumnRow[]>(buildColumnMetadataQuery(true), [this.config.database, tableName]),
      this.pool.query<ConstraintRow[]>(buildConstraintMetadataQuery(true), [this.config.database, tableName]),
      this.pool.query<ShowCreateTableRow[]>(`SHOW CREATE TABLE \`${tableName.replace(/`/g, "``")}\``),
    ]);

    if (!columnRows[0].length) {
      throw new Error(`Table not found: ${this.config.database}.${tableName}`);
    }

    const showCreateRow = showCreateRows[0][0];
    const nativeDdl =
      showCreateRow && typeof showCreateRow["Create Table"] === "string"
        ? (showCreateRow["Create Table"] as string)
        : showCreateRow && typeof showCreateRow["Create View"] === "string"
          ? (showCreateRow["Create View"] as string)
          : undefined;

    return buildTableSchema(
      tableName,
      columnRows[0].map(toTableColumn),
      buildConstraintMap(constraintRows[0]).get(tableName) ?? [],
      nativeDdl,
      nativeDdl ? "native" : "reconstructed",
    );
  }

  /**
   * Execute one SQL statement and normalize mysql2's return shape.
   */
  async execute(sql: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult> {
    const started = performance.now();
    const [rows, fields] = await this.pool.query(sql);
    const elapsedMs = performance.now() - started;
    const operation = inferSqlOperation(sql);

    // mysql2 returns either row arrays or metadata headers depending on the statement type.
    const normalizedRows = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    const rowCount =
      Array.isArray(rows) ? normalizedRows.length : typeof (rows as ResultSetHeader).affectedRows === "number" ? (rows as ResultSetHeader).affectedRows : 0;
    const normalizedFields = Array.isArray(fields)
      ? fields.map((field) => field.name)
      : normalizedRows[0]
        ? Object.keys(normalizedRows[0])
        : [];

    return applyResultRowLimit(sql, operation, rowCount, normalizedRows, normalizedFields, elapsedMs, options);
  }

  /**
   * Run EXPLAIN FORMAT JSON so the agent receives a structured query plan.
   */
  async explain(sql: string): Promise<QueryPlanResult> {
    const started = performance.now();
    const safety = assessSqlSafety(sql);
    // FORMAT=JSON gives the agent a structured plan that is easier to reason over than tabular EXPLAIN.
    const [rows] = await this.pool.query<RowDataPacket[]>(`EXPLAIN FORMAT=JSON ${sql}`);
    const elapsedMs = performance.now() - started;
    const rawPlan = rows[0]?.EXPLAIN ?? rows;

    return {
      sql,
      operation: safety.operation,
      elapsedMs,
      rawPlan,
      warnings: safety.warnings,
    };
  }

  /**
   * Close the underlying MySQL connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
