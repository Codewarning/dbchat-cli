// PostgreSQL adapter backed by node-postgres.
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import type { DatabaseConfig, QueryExecutionResult, QueryPlanResult, SchemaSummary, TableColumn, TableSchema } from "../types/index.js";
import { buildTableSchema, type TableConstraintDefinition } from "./table-schema.js";
import { assessSqlSafety, inferSqlOperation } from "./safety.js";
import type { DatabaseAdapter, SchemaSummaryOptions } from "./adapter.js";
import type { QueryExecutionOptions } from "./query-results.js";
import { applyResultRowLimit } from "./query-results.js";

interface TableRow {
  table_name: string;
  row_count: string;
}

interface DatabaseRow {
  database_name: string;
}

interface TableNameRow {
  table_name: string;
}

interface ColumnRow {
  table_name?: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}

interface ConstraintRow {
  table_name: string;
  constraint_name: string;
  constraint_type: "PRIMARY KEY" | "UNIQUE";
  constraint_columns: string[];
}

interface QueryFieldLike {
  name: string;
}

function toTableColumn(row: ColumnRow): TableColumn {
  return {
    name: row.column_name,
    dataType: row.data_type,
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
      columns: row.constraint_columns,
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
    select
      c.table_name,
      c.column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
      c.is_nullable,
      c.column_default
    from information_schema.columns c
    join information_schema.tables t
      on t.table_name = c.table_name
     and t.table_schema = c.table_schema
    join pg_catalog.pg_namespace ns
      on ns.nspname = c.table_schema
    join pg_catalog.pg_class cls
      on cls.relname = c.table_name
     and cls.relnamespace = ns.oid
    join pg_catalog.pg_attribute a
      on a.attrelid = cls.oid
     and a.attname = c.column_name
     and a.attnum > 0
     and not a.attisdropped
   where c.table_schema = $1
     and t.table_type = 'BASE TABLE'
     ${includeTableFilter ? "and c.table_name = $2" : ""}
   order by c.table_name, c.ordinal_position
  `;
}

function buildConstraintMetadataQuery(includeTableFilter: boolean): string {
  return `
    select
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      array_agg(kcu.column_name order by kcu.ordinal_position)::text[] as constraint_columns
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_schema = tc.constraint_schema
     and kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
     and kcu.table_name = tc.table_name
   where tc.table_schema = $1
     and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
     ${includeTableFilter ? "and tc.table_name = $2" : ""}
   group by tc.table_name, tc.constraint_name, tc.constraint_type
   order by tc.table_name, tc.constraint_name
  `;
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function quotePostgresLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function getPostgresFieldNames(result: {
  rows: Record<string, unknown>[];
  fields?: QueryFieldLike[];
}): string[] {
  if (Array.isArray(result.fields) && result.fields.length) {
    return result.fields.map((field) => field.name);
  }

  return result.rows[0] ? Object.keys(result.rows[0]) : [];
}

/**
 * PostgreSQL implementation of the shared database adapter contract.
 */
export class PostgresAdapter implements DatabaseAdapter {
  private readonly pool: Pool;

  /**
   * Create a small connection pool for the configured PostgreSQL target.
   */
  constructor(private readonly config: DatabaseConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      // Require certificate verification whenever SSL is enabled so the connection is authenticated.
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    });
  }

  /**
   * Verify the configured PostgreSQL connection can run a trivial query.
   */
  async testConnection(): Promise<void> {
    await this.pool.query("select 1");
  }

  /**
   * Return the visible PostgreSQL databases that the current user can connect to.
   */
  async listDatabases(): Promise<string[]> {
    const result = await this.pool.query<DatabaseRow>(
      `
        select datname as database_name
        from pg_database
       where datallowconn = true
         and datistemplate = false
         and has_database_privilege(current_user, datname, 'CONNECT')
       order by datname
      `,
    );

    return result.rows.map((row) => row.database_name);
  }

  /**
   * Return a compact summary of base tables in the active schema.
   */
  async getSchemaSummary(options?: SchemaSummaryOptions): Promise<SchemaSummary> {
    const schema = this.config.schema ?? "public";
    const includeRowCount = options?.includeRowCount ?? false;
    // Use information_schema so schema inspection stays portable across typical Postgres installations.
    const tableNameResult = await this.pool.query<TableNameRow>(
      `
        select t.table_name
        from information_schema.tables t
       where t.table_schema = $1
         and t.table_type = 'BASE TABLE'
       order by t.table_name
      `,
      [schema],
    );
    const tableNames = tableNameResult.rows.map((row) => row.table_name);

    let rowCountsByTable = new Map<string, number>();
    if (includeRowCount && tableNames.length) {
      const rowCountSql = tableNames
        .map(
          (tableName) =>
            `select ${quotePostgresLiteral(tableName)} as table_name, count(*)::text as row_count from ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(tableName)}`,
        )
        .join("\nunion all\n");
      const rowCountResult = await this.pool.query<TableRow>(rowCountSql);
      rowCountsByTable = new Map(rowCountResult.rows.map((row) => [row.table_name, Number(row.row_count)]));
    }

    return {
      dialect: "postgres",
      database: this.config.database,
      schema,
      tables: tableNames.map((tableName) => ({
        tableName,
        rowCount: includeRowCount ? rowCountsByTable.get(tableName) ?? 0 : undefined,
      })),
    };
  }

  /**
   * Return ordered column metadata for all PostgreSQL base tables in the active schema.
   */
  async getAllTableSchemas(): Promise<TableSchema[]> {
    const schema = this.config.schema ?? "public";
    const [columnResult, constraintResult] = await Promise.all([
      this.pool.query<ColumnRow>(buildColumnMetadataQuery(false), [schema]),
      this.pool.query<ConstraintRow>(buildConstraintMetadataQuery(false), [schema]),
    ]);

    return groupTableSchemas(columnResult.rows, buildConstraintMap(constraintResult.rows));
  }

  /**
   * Return ordered column metadata for one PostgreSQL table.
   */
  async describeTable(tableName: string): Promise<TableSchema> {
    const schema = this.config.schema ?? "public";
    const [columnResult, constraintResult] = await Promise.all([
      this.pool.query<ColumnRow>(buildColumnMetadataQuery(true), [schema, tableName]),
      this.pool.query<ConstraintRow>(buildConstraintMetadataQuery(true), [schema, tableName]),
    ]);

    if (!columnResult.rowCount) {
      throw new Error(`Table not found: ${schema}.${tableName}`);
    }

    return buildTableSchema(
      tableName,
      columnResult.rows.map(toTableColumn),
      buildConstraintMap(constraintResult.rows).get(tableName) ?? [],
      undefined,
      "reconstructed",
    );
  }

  /**
   * Execute one SQL statement and normalize the result into the shared shape.
   */
  async execute(sql: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult> {
    const started = performance.now();
    const result = await this.pool.query(sql);
    const elapsedMs = performance.now() - started;
    const operation = inferSqlOperation(sql);
    const rows = Array.isArray(result.rows) ? (result.rows as Record<string, unknown>[]) : [];
    const fields = getPostgresFieldNames({
      rows,
      fields: result.fields?.map((field) => ({ name: field.name })),
    });

    return applyResultRowLimit(sql, operation, typeof result.rowCount === "number" ? result.rowCount : rows.length, rows, fields, elapsedMs, options);
  }

  /**
   * Run EXPLAIN FORMAT JSON so the agent receives a structured query plan.
   */
  async explain(sql: string): Promise<QueryPlanResult> {
    const started = performance.now();
    const safety = assessSqlSafety(sql);
    // JSON output avoids fragile parsing of text-based query plans.
    const explainSql = `EXPLAIN (FORMAT JSON) ${sql}`;
    const result = await this.pool.query(explainSql);
    const elapsedMs = performance.now() - started;

    return {
      sql,
      operation: safety.operation,
      elapsedMs,
      rawPlan: result.rows[0]?.["QUERY PLAN"] ?? result.rows,
      warnings: safety.warnings,
    };
  }

  /**
   * Close the underlying PostgreSQL connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
