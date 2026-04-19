// Shared helpers for building runtime dependencies and formatting terminal output.
import type { DatabaseAdapter } from "../db/adapter.js";
import { ZodError } from "zod";
import { createDatabaseAdapter } from "../db/factory.js";
import type {
  AppConfig,
  AgentIO,
  QueryExecutionResult,
  SchemaCatalogSearchResult,
  SchemaCatalogSyncResult,
  SchemaSummary,
  TableRenderingConfig,
  TableSchema,
} from "../types/index.js";
import { resolveAppConfig } from "../config/store.js";
import type { LoggerProfile } from "../ui/logger.js";
import { promptConfirm, promptSqlApproval } from "../ui/prompts.js";
import { TerminalLogger } from "../ui/logger.js";
import { buildSchemaSummaryRows, buildTableSchemaRows } from "../ui/rows.js";
import { buildQueryResultPreview } from "../ui/query-result-preview.js";
import { formatArtifactTextForTerminal } from "../ui/terminal-links.js";

/**
 * Resolved runtime dependencies shared by individual CLI handlers.
 */
export interface RuntimeContext {
  config: AppConfig;
  db: DatabaseAdapter;
  io: AgentIO;
}

export interface ResolvedConfigContext {
  config: AppConfig;
  io: AgentIO;
}

export interface ManagedRuntimeContext extends RuntimeContext {
  close(): Promise<void>;
}

interface RuntimeOptions {
  loggerProfile?: LoggerProfile;
  showLifecycleLogs?: boolean;
}

const REQUIRED_DATABASE_CONFIG_PATHS = new Set([
  "database.host",
  "database.database",
  "database.username",
  "database.password",
]);

function normalizeResolvedConfigError(error: unknown): Error {
  if (!(error instanceof ZodError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const issuePaths = error.issues.map((issue) => issue.path.join("."));
  const missingDatabasePaths = issuePaths.filter((path) => REQUIRED_DATABASE_CONFIG_PATHS.has(path));

  if (missingDatabasePaths.length === REQUIRED_DATABASE_CONFIG_PATHS.size) {
    return new Error(
      "Database configuration is incomplete. Run `dbchat init` or select an active database with `dbchat config db ...` before using database commands.",
    );
  }

  if (issuePaths.some((path) => path.startsWith("database."))) {
    return new Error(`Database configuration is invalid. Use \`dbchat config show\` to inspect the resolved runtime config.`);
  }

  return new Error(`Resolved runtime config is invalid. Use \`dbchat config show\` to inspect the resolved runtime config.`);
}

/**
 * Create the terminal-facing IO abstraction used by commands and the agent runtime.
 */
export function createAgentIo(cwd = process.cwd(), profile: LoggerProfile = "compact"): AgentIO {
  const logger = new TerminalLogger(profile);
  return {
    cwd,
    // Delegate to the shared terminal logger so commands and the agent render consistently.
    log(message: string) {
      logger.log(message);
    },
    logBlock(title: string, body: string) {
      logger.logBlock(title, body);
    },
    async confirm(message: string) {
      return promptConfirm(message, false);
    },
    async approveSql(message: string) {
      return promptSqlApproval(message);
    },
    async withLoading<T>(message: string, task: () => Promise<T>) {
      return logger.withLoading(message, task);
    },
  };
}

/**
 * Resolve config and create the shared terminal-facing IO context.
 */
export async function createResolvedConfigContext(options?: RuntimeOptions): Promise<ResolvedConfigContext> {
  const loggerProfile = options?.loggerProfile ?? "compact";
  const io = createAgentIo(process.cwd(), loggerProfile);
  let config: AppConfig;
  try {
    config = await resolveAppConfig();
  } catch (error) {
    throw normalizeResolvedConfigError(error);
  }
  return {
    config,
    io,
  };
}

/**
 * Resolve config and connect to the database, returning a managed runtime handle.
 */
export async function createRuntimeContext(options?: RuntimeOptions): Promise<ManagedRuntimeContext> {
  const showLifecycleLogs = options?.showLifecycleLogs ?? false;
  const { config, io } = await createResolvedConfigContext(options);
  if (showLifecycleLogs) {
    io.log("Loading runtime configuration");
  }
  if (showLifecycleLogs) {
    io.log(`LLM provider: ${config.llm.provider}`);
    io.log(`LLM model: ${config.llm.model}`);
    io.log(`Database target: ${config.database.dialect} ${config.database.host}:${config.database.port}/${config.database.database}`);
    io.log("Creating database adapter");
  }
  const db = await createDatabaseAdapter(config.database);
  if (showLifecycleLogs) {
    await io.withLoading("Testing database connection", () => db.testConnection());
    io.log("Database connection is ready");
  } else {
    await db.testConnection();
  }

  let closed = false;

  return {
    config,
    db,
    io,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (showLifecycleLogs) {
        await io.withLoading("Closing database connection", () => db.close());
      } else {
        await db.close();
      }
    },
  };
}

/**
 * Resolve config, connect to the database, run the action, and always close the adapter.
 */
export async function withRuntime<T>(action: (context: RuntimeContext) => Promise<T>, options?: RuntimeOptions): Promise<T> {
  const runtime = await createRuntimeContext(options);
  try {
    return await action(runtime);
  } finally {
    await runtime.close();
  }
}

/**
 * Resolve config without creating a database connection.
 */
export async function withResolvedConfig<T>(
  action: (context: ResolvedConfigContext) => Promise<T>,
  options?: RuntimeOptions,
): Promise<T> {
  return action(await createResolvedConfigContext(options));
}

/**
 * Render a high-level schema summary in a table-friendly format.
 */
export function printSchemaSummary(summary: SchemaSummary): void {
  console.log(`Database: ${summary.database}`);
  if (summary.schema) {
    console.log(`Schema: ${summary.schema}`);
  }
  console.table(buildSchemaSummaryRows(summary));
}

/**
 * Render the column list for a single table.
 */
export function printTableSchema(schema: TableSchema): void {
  if (schema.ddlPreview) {
    const sourceLabel = schema.ddlSource === "native" ? "native database DDL" : "reconstructed DDL";
    console.log(`-- DDL source: ${sourceLabel}`);
    console.log(schema.ddlPreview);
    return;
  }

  console.log(`Table: ${schema.tableName}`);
  console.table(buildTableSchemaRows(schema));
}

/**
 * Print a human-facing summary of one schema catalog sync.
 */
export function printSchemaCatalogSyncResult(result: SchemaCatalogSyncResult): void {
  console.log(`Catalog path: ${result.catalogPath}`);
  console.log(`Generated at: ${result.generatedAt}`);
  console.log(`Tables: ${result.tableCount}`);
  console.log(`Documents: ${result.documentCount}`);
  console.log(`Added: ${result.addedTables.length}`);
  console.log(`Updated: ${result.updatedTables.length}`);
  console.log(`Removed: ${result.removedTables.length}`);
  console.log(`Unchanged: ${result.unchangedTableCount}`);
  console.log(`Reindexed: ${result.reindexedTableCount}`);
  console.log(`Reused vectors: ${result.reusedIndexCount}`);
  console.log(`Semantic index enabled: ${result.semanticIndexEnabled ? "yes" : "no"}`);
}

/**
 * Run a local schema-catalog search and print the ranked matches.
 */
export function printSchemaCatalogSearch(result: SchemaCatalogSearchResult): void {
  console.log(`Query: ${result.query}`);
  console.log(`Matches: ${result.totalMatches}`);
  if (result.isAmbiguous) {
    console.log(`Ambiguous: yes`);
    if (result.ambiguityReason) {
      console.log(`Ambiguity note: ${result.ambiguityReason}`);
    }
    if (result.clarificationCandidates.length) {
      console.log(`Clarify between: ${result.clarificationCandidates.join(", ")}`);
    }
  }

  if (!result.matches.length) {
    console.log("No catalog matches found.");
    return;
  }

  console.table(
    result.matches.map((match) => ({
      tableName: match.tableName,
      description: match.description,
      matchedAliases: match.matchedAliases.join(", "),
      tags: match.tags.join(", "),
      matchedColumns: match.matchedColumns.join(", "),
      documentKinds: match.documentKinds.join(", "),
      matchedSources: match.matchedSources.join(", "),
      matchReasons: match.matchReasons.join(", "),
      semanticScore: match.semanticScore,
      keywordScore: match.keywordScore,
      score: match.score,
    })),
  );
}

/**
 * Print a compact execution summary plus a bounded preview of result rows.
 */
export function printQueryResult(result: QueryExecutionResult, tableRendering: TableRenderingConfig): void {
  console.log(`Operation: ${result.operation}`);
  console.log(`Rows affected/returned: ${result.rowCount}`);
  if (result.rowsTruncated) {
    console.log(`Cached rows: ${result.rows.length} (limited by app.resultRowLimit)`);
  }
  console.log(`Elapsed: ${result.elapsedMs.toFixed(2)}ms`);
  console.log("SQL:");
  console.log(result.sql);

  if (result.rows.length || result.fields.length) {
    console.log(
      formatArtifactTextForTerminal(
        buildQueryResultPreview(result, {
          tableRendering,
        }).renderedText,
      ),
    );
  }
}
