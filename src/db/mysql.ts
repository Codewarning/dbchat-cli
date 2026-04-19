// MySQL adapter backed by mysql2's promise API.
import { performance } from "node:perf_hooks";
import mysql from "mysql2/promise";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { DatabaseConfig, QueryExecutionResult, QueryPlanResult, SchemaSummary, TableColumn, TableRelation, TableSchema } from "../types/index.js";
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
  table_comment?: string | null;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  extra?: string | null;
  column_comment?: string | null;
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

interface ForeignKeyRow extends RowDataPacket {
  table_name: string;
  referenced_table_name: string;
  fk_columns: string;
  referenced_columns: string;
}

export function readMySqlRowField<T>(row: Partial<Record<string, unknown>>, fieldName: string): T | undefined {
  const direct = row[fieldName];
  if (direct !== undefined) {
    return direct as T;
  }

  const upperCase = row[fieldName.toUpperCase()];
  if (upperCase !== undefined) {
    return upperCase as T;
  }

  return undefined;
}

function quoteMySqlIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function quoteMySqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function normalizeMySqlExplainPlan(rawPlan: unknown): unknown {
  if (typeof rawPlan !== "string") {
    return rawPlan;
  }

  try {
    return JSON.parse(rawPlan) as unknown;
  } catch {
    return rawPlan;
  }
}

function castMySqlField(
  field: { type: string; length: number; buffer: () => Buffer | null },
  next: () => unknown,
): unknown {
  if (field.type === "BIT" && field.length === 1) {
    const value = field.buffer();
    if (!value || !value.length) {
      return false;
    }

    return value[0] !== 0;
  }

  return next();
}

function toTableColumn(row: ColumnRow): TableColumn {
  const dataType = readMySqlRowField<string>(row, "data_type") ?? "";
  const extra = readMySqlRowField<string | null>(row, "extra");
  return {
    name: readMySqlRowField<string>(row, "column_name") ?? "",
    dataType: extra?.toLowerCase().includes("auto_increment") ? `${dataType} AUTO_INCREMENT` : dataType,
    isNullable: readMySqlRowField<string>(row, "is_nullable") === "YES",
    defaultValue: readMySqlRowField<string | null>(row, "column_default") ?? null,
    comment: readMySqlRowField<string | null>(row, "column_comment") ?? null,
  };
}

function buildConstraintMap(rows: ConstraintRow[]): Map<string, TableConstraintDefinition[]> {
  const grouped = new Map<string, TableConstraintDefinition[]>();

  for (const row of rows) {
    const tableName = readMySqlRowField<string>(row, "table_name");
    const constraintName = readMySqlRowField<string>(row, "constraint_name");
    const constraintType = readMySqlRowField<ConstraintRow["constraint_type"]>(row, "constraint_type");
    const constraintColumns = readMySqlRowField<string>(row, "constraint_columns");
    if (!tableName || !constraintName || !constraintType || !constraintColumns) {
      continue;
    }

    const constraints = grouped.get(tableName) ?? [];
    constraints.push({
      constraintName,
      constraintType,
      columns: constraintColumns.split(",").map((column) => column.trim()).filter(Boolean),
    });
    grouped.set(tableName, constraints);
  }

  return grouped;
}

function buildRelationMap(rows: ForeignKeyRow[]): Map<string, TableRelation[]> {
  const grouped = new Map<string, TableRelation[]>();

  for (const row of rows) {
    const tableName = readMySqlRowField<string>(row, "table_name");
    const referencedTableName = readMySqlRowField<string>(row, "referenced_table_name");
    const fkColumns = readMySqlRowField<string>(row, "fk_columns");
    const referencedColumns = readMySqlRowField<string>(row, "referenced_columns");
    if (!tableName || !referencedTableName || !fkColumns || !referencedColumns) {
      continue;
    }

    const relations = grouped.get(tableName) ?? [];
    relations.push({
      toTable: referencedTableName,
      fromColumns: fkColumns.split(",").map((column) => column.trim()).filter(Boolean),
      toColumns: referencedColumns.split(",").map((column) => column.trim()).filter(Boolean),
      type: "foreign_key",
      source: "database",
    });
    grouped.set(tableName, relations);
  }

  return grouped;
}

function groupTableSchemas(
  rows: ColumnRow[],
  constraintMap: Map<string, TableConstraintDefinition[]>,
  relationMap: Map<string, TableRelation[]>,
): TableSchema[] {
  const grouped = new Map<string, TableColumn[]>();
  const comments = new Map<string, string | null>();

  for (const row of rows) {
    const tableName = readMySqlRowField<string>(row, "table_name");
    if (!tableName) {
      continue;
    }

    const columns = grouped.get(tableName) ?? [];
    columns.push(toTableColumn(row));
    grouped.set(tableName, columns);
    if (!comments.has(tableName)) {
      comments.set(tableName, readMySqlRowField<string | null>(row, "table_comment") ?? null);
    }
  }

  return Array.from(grouped.entries())
    .map(([tableName, columns]) =>
      buildTableSchema(
        tableName,
        columns,
        constraintMap.get(tableName) ?? [],
        undefined,
        "reconstructed",
        comments.get(tableName) ?? null,
        relationMap.get(tableName) ?? [],
      ),
    )
    .sort((left, right) => left.tableName.localeCompare(right.tableName));
}

function buildColumnMetadataQuery(includeTableFilter: boolean): string {
  return `
    select c.table_name, t.table_comment, c.column_name, c.column_type as data_type, c.is_nullable, c.column_default, c.extra, c.column_comment
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

function buildForeignKeyMetadataQuery(includeTableFilter: boolean): string {
  return `
    select
      kcu.table_name,
      kcu.referenced_table_name,
      group_concat(kcu.column_name order by kcu.ordinal_position separator ',') as fk_columns,
      group_concat(kcu.referenced_column_name order by kcu.ordinal_position separator ',') as referenced_columns
    from information_schema.key_column_usage kcu
    join information_schema.tables t
      on t.table_schema = kcu.table_schema
     and t.table_name = kcu.table_name
   where kcu.table_schema = ?
     and t.table_type = 'BASE TABLE'
     and kcu.referenced_table_name is not null
     ${includeTableFilter ? "and kcu.table_name = ?" : ""}
   group by kcu.table_name, kcu.constraint_name, kcu.referenced_table_name
   order by kcu.table_name, kcu.constraint_name
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
      typeCast: castMySqlField,
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
    const tableNames = rows
      .map((row) => readMySqlRowField<string>(row, "table_name"))
      .filter((tableName): tableName is string => Boolean(tableName));

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
    const [columnRows, constraintRows, foreignKeyRows] = await Promise.all([
      this.pool.query<ColumnRow[]>(buildColumnMetadataQuery(false), [this.config.database]),
      this.pool.query<ConstraintRow[]>(buildConstraintMetadataQuery(false), [this.config.database]),
      this.pool.query<ForeignKeyRow[]>(buildForeignKeyMetadataQuery(false), [this.config.database]),
    ]);

    return groupTableSchemas(columnRows[0], buildConstraintMap(constraintRows[0]), buildRelationMap(foreignKeyRows[0]));
  }

  /**
   * Return ordered column metadata for one MySQL table.
   */
  async describeTable(tableName: string): Promise<TableSchema> {
    const [columnRows, constraintRows, foreignKeyRows, showCreateRows] = await Promise.all([
      this.pool.query<ColumnRow[]>(buildColumnMetadataQuery(true), [this.config.database, tableName]),
      this.pool.query<ConstraintRow[]>(buildConstraintMetadataQuery(true), [this.config.database, tableName]),
      this.pool.query<ForeignKeyRow[]>(buildForeignKeyMetadataQuery(true), [this.config.database, tableName]),
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
      columnRows[0][0]?.table_comment ?? null,
      buildRelationMap(foreignKeyRows[0]).get(tableName) ?? [],
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
    const rawPlan = normalizeMySqlExplainPlan(rows[0]?.EXPLAIN ?? rows);

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
