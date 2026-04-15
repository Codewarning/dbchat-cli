import type { DatabaseAdapter } from "../db/adapter.js";
import { ensureSingleStatement } from "../db/safety.js";
import { refreshSchemaCatalogAfterSqlIfNeeded, type SchemaCatalogRefreshOutcome } from "../schema/catalog.js";
import { executeSqlStatement, type ExecuteSqlStatementOptions, type SqlExecutionCancelled, type SqlExecutionSuccess } from "../sql/execution.js";
import type { AgentIO, AppConfig, MutationApprovalState, QueryPlanResult } from "../types/index.js";

export interface ExecuteManagedSqlOptions {
  config: AppConfig;
  db: DatabaseAdapter;
  io: AgentIO;
  sql: string;
  approvalState?: MutationApprovalState;
}

export interface ManagedSqlExecutionSuccess extends SqlExecutionSuccess {
  catalogRefresh: SchemaCatalogRefreshOutcome;
}

export type ManagedSqlExecutionOutcome = SqlExecutionCancelled | ManagedSqlExecutionSuccess;

function buildSqlExecutionOptions(options: ExecuteManagedSqlOptions): ExecuteSqlStatementOptions {
  return {
    db: options.db,
    io: options.io,
    sql: options.sql,
    resultRowLimit: options.config.app.resultRowLimit,
    operationAccess: options.config.database.operationAccess,
    approvalState: options.approvalState,
  };
}

/**
 * Execute one SQL statement through the shared safety gate and then report whether manual schema-catalog refresh is needed.
 */
export async function executeManagedSql(options: ExecuteManagedSqlOptions): Promise<ManagedSqlExecutionOutcome> {
  const execution = await executeSqlStatement(buildSqlExecutionOptions(options));
  if (execution.status === "cancelled") {
    return execution;
  }

  return {
    ...execution,
    catalogRefresh: await refreshSchemaCatalogAfterSqlIfNeeded(
      options.config,
      options.db,
      options.io,
      options.sql,
      execution.safety.operation,
    ),
  };
}

export interface ExplainSqlOptions {
  db: DatabaseAdapter;
  io: AgentIO;
  sql: string;
}

/**
 * Run EXPLAIN for one SQL statement without executing the underlying mutation itself.
 */
export async function explainSql(options: ExplainSqlOptions): Promise<QueryPlanResult> {
  ensureSingleStatement(options.sql);
  return options.io.withLoading("Running EXPLAIN", () => options.db.explain(options.sql));
}
