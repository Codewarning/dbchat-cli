import type { DatabaseAdapter } from "../db/adapter.js";
import {
  formatAllowedOperationsForDatabaseOperationAccess,
  formatDatabaseOperationAccess,
  formatSupportedOperationsAcrossDatabaseOperationAccessPresets,
  isSqlOperationSupportedByAnyDatabaseOperationAccessPreset,
  isSqlOperationAllowedForDatabaseOperationAccess,
} from "../db/operation-access.js";
import { assessSqlSafety, ensureSingleStatement } from "../db/safety.js";
import type {
  AgentIO,
  DatabaseOperationAccess,
  MutationApprovalState,
  QueryExecutionResult,
  SqlApprovalDecision,
  SqlExecutionCategory,
  SqlOperation,
  SqlSafetyAssessment,
} from "../types/index.js";

export interface SqlExecutionCancelled {
  status: "cancelled";
  cancelledBy: "database_access" | "user_rejection" | "other";
  accessPolicyScope?: "current_database" | "all_access_presets";
  approvalPromptShown: boolean;
  reason: string;
  sql: string;
  operation: SqlOperation;
  executionCategory: SqlExecutionCategory;
}

export interface SqlExecutionSuccess {
  status: "executed";
  result: QueryExecutionResult;
  safety: SqlSafetyAssessment;
  approvalDecision: SqlApprovalDecision | "not_needed";
}

export type SqlExecutionOutcome = SqlExecutionCancelled | SqlExecutionSuccess;

export interface ExecuteSqlStatementOptions {
  db: DatabaseAdapter;
  io: AgentIO;
  sql: string;
  resultRowLimit: number;
  operationAccess: DatabaseOperationAccess;
  approvalState?: MutationApprovalState;
}

function buildSqlApprovalMessage(safety: SqlSafetyAssessment): string {
  switch (safety.executionCategory) {
    case "dml":
      return `Approval required: ${safety.operation} is a DML statement. Choose Approve Once, Approve All For Turn, or Reject.`;
    case "ddl":
      return `Approval required: ${safety.operation} is a DDL statement. Choose Approve Once, Approve All For Turn, or Reject.`;
    case "unknown":
      return `Approval required: this SQL statement could not be classified as read-only. Choose Approve Once, Approve All For Turn, or Reject.`;
    default:
      return `Approval required: ${safety.operation} needs confirmation. Choose Approve Once, Approve All For Turn, or Reject.`;
  }
}

function buildRejectionReason(safety: SqlSafetyAssessment): string {
  switch (safety.executionCategory) {
    case "dml":
      return "The user rejected the DML statement.";
    case "ddl":
      return "The user rejected the DDL statement.";
    case "unknown":
      return "The user rejected the unclassified SQL statement.";
    default:
      return "The user rejected the SQL statement.";
  }
}

function formatExecutionCategory(category: SqlExecutionCategory): string {
  switch (category) {
    case "read_only":
      return "READ ONLY";
    case "dml":
      return "DML";
    case "ddl":
      return "DDL";
    case "unknown":
      return "UNCLASSIFIED";
  }
}

async function executeSqlViaAdapter(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<QueryExecutionResult> {
  return options.io.withLoading(`Executing ${safety.operation} SQL`, () =>
    options.db.execute(options.sql, { maxRows: options.resultRowLimit }),
  );
}

async function executeReadOnlySql(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<SqlExecutionSuccess> {
  options.io.log(`Execution path: ${formatExecutionCategory(safety.executionCategory)}`);
  return {
    status: "executed",
    result: await executeSqlViaAdapter(options, safety),
    safety,
    approvalDecision: "not_needed",
  };
}

async function requestSqlApproval(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<SqlApprovalDecision> {
  if (options.approvalState?.allowAllForCurrentTurn) {
    options.io.log("Reusing SQL approval for the current request");
    return "approve_all";
  }

  const decision = await options.io.approveSql(buildSqlApprovalMessage(safety));
  switch (decision) {
    case "approve_once":
      options.io.log("SQL approval granted for this statement");
      return decision;
    case "approve_all":
      if (options.approvalState) {
        options.approvalState.allowAllForCurrentTurn = true;
      }
      options.io.log("SQL approval granted for the remaining statements in the current request");
      return decision;
    case "reject":
      options.io.log("SQL execution rejected by user");
      return decision;
  }
}

async function executeApprovedSql(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<SqlExecutionOutcome> {
  options.io.log(`Execution path: ${formatExecutionCategory(safety.executionCategory)}`);
  const approvalDecision = await requestSqlApproval(options, safety);
  if (approvalDecision === "reject") {
    return {
      status: "cancelled",
      cancelledBy: "user_rejection",
      approvalPromptShown: true,
      reason: buildRejectionReason(safety),
      sql: options.sql,
      operation: safety.operation,
      executionCategory: safety.executionCategory,
    };
  }

  return {
    status: "executed",
    result: await executeSqlViaAdapter(options, safety),
    safety,
    approvalDecision,
  };
}

async function executeDmlSql(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<SqlExecutionOutcome> {
  return executeApprovedSql(options, safety);
}

async function executeDdlSql(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<SqlExecutionOutcome> {
  return executeApprovedSql(options, safety);
}

async function executeUnknownSql(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): Promise<SqlExecutionOutcome> {
  options.io.log("SQL operation could not be classified as read-only. Approval is required.");
  return executeApprovedSql(options, safety);
}

function buildOperationAccessDeniedReason(options: ExecuteSqlStatementOptions, safety: SqlSafetyAssessment): string {
  if (!isSqlOperationSupportedByAnyDatabaseOperationAccessPreset(safety.operation)) {
    return `SQL blocked by product access policy: ${safety.operation} is not available in any current database access preset. Supported preset operations: ${formatSupportedOperationsAcrossDatabaseOperationAccessPresets()}.`;
  }

  return `SQL blocked by database access '${formatDatabaseOperationAccess(options.operationAccess)}': ${safety.operation} is not allowed. Allowed operations: ${formatAllowedOperationsForDatabaseOperationAccess(options.operationAccess)}.`;
}

/**
 * Execute one SQL statement through the appropriate runtime path based on its classified category.
 */
export async function executeSqlStatement(options: ExecuteSqlStatementOptions): Promise<SqlExecutionOutcome> {
  ensureSingleStatement(options.sql);
  const safety = assessSqlSafety(options.sql);
  if (!isSqlOperationAllowedForDatabaseOperationAccess(options.operationAccess, safety.operation)) {
    const reason = buildOperationAccessDeniedReason(options, safety);
    options.io.log(reason);
    return {
      status: "cancelled",
      cancelledBy: "database_access",
      accessPolicyScope: isSqlOperationSupportedByAnyDatabaseOperationAccessPreset(safety.operation)
        ? "current_database"
        : "all_access_presets",
      approvalPromptShown: false,
      reason,
      sql: options.sql,
      operation: safety.operation,
      executionCategory: safety.executionCategory,
    };
  }

  switch (safety.executionCategory) {
    case "read_only":
      return executeReadOnlySql(options, safety);
    case "dml":
      return executeDmlSql(options, safety);
    case "ddl":
      return executeDdlSql(options, safety);
    case "unknown":
      return executeUnknownSql(options, safety);
  }
}
