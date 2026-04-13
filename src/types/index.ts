// Cross-module domain types live here to keep imports stable across layers.
export type DatabaseDialect = "postgres" | "mysql";
export type LlmProvider = "openai" | "anthropic" | "deepseek" | "custom";
export type LlmApiFormat = "openai" | "anthropic";
export type EmbeddingProvider = "aliyun" | "openai" | "custom";
export type SqlExecutionCategory = "read_only" | "dml" | "ddl" | "unknown";
export type SqlApprovalDecision = "approve_once" | "approve_all" | "reject";
export type DatabaseOperationAccess = "read_only" | "select_update" | "select_update_delete" | "select_update_delete_ddl";
export type TableDdlSource = "native" | "reconstructed";

export type PlanStatus = "pending" | "in_progress" | "completed" | "skipped" | "cancelled";

// SQL operations are normalized to this union so safety checks and UI rendering share the same vocabulary.
export type SqlOperation =
  | "SELECT"
  | "SHOW"
  | "DESCRIBE"
  | "EXPLAIN"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "CREATE"
  | "ALTER"
  | "DROP"
  | "TRUNCATE"
  | "RENAME"
  | "UNKNOWN";

/**
 * Resolved LLM connection settings used by the runtime.
 */
export interface LlmConfig {
  provider: LlmProvider;
  apiFormat: LlmApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Resolved embedding API settings used for schema-catalog indexing and search.
 */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Resolved database connection settings used by the runtime.
 */
export interface DatabaseConfig {
  dialect: DatabaseDialect;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  schema?: string;
  ssl?: boolean;
  operationAccess: DatabaseOperationAccess;
}

/**
 * One database entry grouped under a stored host configuration.
 */
export interface StoredDatabaseEntry {
  name: string;
  schema?: string;
}

/**
 * One stored host configuration that can contain multiple database names.
 */
export interface StoredDatabaseHost {
  name: string;
  dialect: DatabaseDialect;
  host: string;
  port: number;
  username: string;
  password: string;
  ssl?: boolean;
  databases: StoredDatabaseEntry[];
}

/**
 * App-level runtime limits that influence result caching and previews.
 */
export interface AppRuntimeConfig {
  resultRowLimit: number;
  previewRowLimit: number;
}

/**
 * Fully resolved runtime configuration shape consumed across the app.
 */
export interface AppConfig {
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  database: DatabaseConfig;
  app: AppRuntimeConfig;
}

/**
 * Partial on-disk configuration shape before defaults and env overrides are applied.
 */
export interface StoredConfig {
  llm?: Partial<LlmConfig>;
  embedding?: Partial<EmbeddingConfig>;
  databaseHosts?: StoredDatabaseHost[];
  activeDatabaseHost?: string;
  activeDatabaseName?: string;
  app?: Partial<AppRuntimeConfig>;
}

/**
 * One plan step tracked across a multi-step agent task.
 */
export interface PlanItem {
  id: string;
  content: string;
  status: PlanStatus;
}

/**
 * One table entry inside a schema summary.
 */
export interface SchemaTableSummary {
  tableName: string;
  rowCount?: number;
}

/**
 * Compact overview of the current database schema.
 */
export interface SchemaSummary {
  dialect: DatabaseDialect;
  database: string;
  schema?: string;
  tables: SchemaTableSummary[];
}

/**
 * Exact live table names fetched directly from the active database connection.
 */
export interface LiveTableListResult {
  dialect: DatabaseDialect;
  database: string;
  schema?: string;
  tableNames: string[];
}

/**
 * Column metadata returned by describe-table operations.
 */
export interface TableColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
}

/**
 * Full schema details for one table.
 */
export interface TableSchema {
  tableName: string;
  columns: TableColumn[];
  ddlPreview?: string;
  ddlSource?: TableDdlSource;
}

/**
 * Full table entry persisted in the local schema catalog.
 */
export interface SchemaCatalogTable {
  tableName: string;
  schemaHash: string;
  summaryText: string;
  ddlPreview?: string;
  ddlSource?: TableDdlSource;
  description: string;
  tags: string[];
  embeddingText: string;
  embeddingVector: number[];
  columns: TableColumn[];
}

/**
 * Persisted schema catalog scoped to one physical database target.
 */
export interface SchemaCatalog {
  version: number;
  dialect: DatabaseDialect;
  host: string;
  port: number;
  database: string;
  schema?: string;
  generatedAt: string;
  tableCount: number;
  embeddingModelId: string;
  tables: SchemaCatalogTable[];
}

/**
 * One ranked schema-catalog search hit returned to the CLI/LLM.
 */
export interface SchemaCatalogSearchMatch {
  tableName: string;
  summaryText: string;
  description: string;
  tags: string[];
  matchedColumns: string[];
  matchReasons: string[];
  score: number;
  semanticScore: number;
  keywordScore: number;
}

/**
 * Ranked search result for one schema-catalog query.
 */
export interface SchemaCatalogSearchResult {
  query: string;
  totalMatches: number;
  matches: SchemaCatalogSearchMatch[];
}

/**
 * Summary of one catalog refresh against the current database schema.
 */
export interface SchemaCatalogSyncResult {
  catalogPath: string;
  generatedAt: string;
  tableCount: number;
  addedTables: string[];
  updatedTables: string[];
  removedTables: string[];
  unchangedTableCount: number;
  reindexedTableCount: number;
  reusedIndexCount: number;
}

/**
 * Normalized SQL execution result returned by adapters and tools.
 */
export interface QueryExecutionResult {
  sql: string;
  operation: SqlOperation;
  rowCount: number;
  rows: Record<string, unknown>[];
  rowsTruncated: boolean;
  fields: string[];
  elapsedMs: number;
}

/**
 * Normalized EXPLAIN output returned by adapters and tools.
 */
export interface QueryPlanResult {
  sql: string;
  operation: SqlOperation;
  elapsedMs: number;
  rawPlan: unknown;
  warnings: string[];
}

/**
 * Safety classification returned by lightweight SQL inspection.
 */
export interface SqlSafetyAssessment {
  operation: SqlOperation;
  executionCategory: SqlExecutionCategory;
  isMutation: boolean;
  warnings: string[];
}

/**
 * Metadata returned after exporting a cached query result.
 */
export interface ExportResult {
  format: "json" | "csv";
  outputPath: string;
  rowCount: number;
  truncated: boolean;
}

export type ProgressUnit = "bytes";

/**
 * One sink for incremental progress updates emitted by long-running background work.
 */
export interface ProgressHandle {
  update(snapshot: { message?: string; completed: number; total?: number | null; unit?: ProgressUnit }): void;
  complete(message?: string): void;
  fail(message: string): void;
}

/**
 * Terminal-facing IO abstraction shared by commands and the agent loop.
 */
export interface AgentIO {
  cwd: string;
  /** Print a titled multi-line block. */
  logBlock(title: string, body: string): void;
  /** Print a single-line log message. */
  log(message: string): void;
  /** Ask the user to approve one risky action. */
  confirm(message: string): Promise<boolean>;
  /** Ask the user to approve one risky SQL statement. */
  approveSql(message: string): Promise<SqlApprovalDecision>;
  /** Optionally create a sink for incremental progress updates such as model downloads. */
  createProgressHandle?(message: string): ProgressHandle | undefined;
  /** Wrap a long-running task with loading output. */
  withLoading<T>(message: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Per-request mutation approval cache reused within a single agent turn.
 */
export interface MutationApprovalState {
  allowAllForCurrentTurn: boolean;
}
