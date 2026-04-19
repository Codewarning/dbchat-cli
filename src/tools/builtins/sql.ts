import { z } from "zod";
import { assessSqlSafety, hasExplicitRowLimit, splitSqlStatements } from "../../db/safety.js";
import { executeManagedSql, explainSql } from "../../services/sql.js";
import type { QueryExecutionResult, QueryPlanResult, SchemaCatalogSyncResult } from "../../types/index.js";
import { buildPlanPreview, clipMiddle, clipText, isRecord, stringifyCompact } from "../serialize-helpers.js";
import { defineTool } from "../specs.js";

const MAX_MODEL_PREVIEW_FIELDS = 8;
const MAX_SQL_CHARS = 800;
const MAX_MODEL_PLAN_PREVIEW_CHARS = 1200;
const FULL_RESULT_REASON_PATTERN =
  /\ball\b|\bevery\b|\bfull\b|\bcomplete\b|\bentire\b|\bexport\b|\bcsv\b|\bjson\b|\u5168\u90e8|\u6240\u6709|\u5168\u91cf|\u5b8c\u6574|\u5bfc\u51fa|\u4e0b\u8f7d/iu;

const runSqlSchema = z.object({
  sql: z.string().min(1),
  reason: z.string().min(1),
});

const explainSqlSchema = z.object({
  sql: z.string().min(1),
});

function shouldSkipAutomaticReadOnlyLimit(reason: string): boolean {
  return FULL_RESULT_REASON_PATTERN.test(reason);
}

function buildSqlWithReadOnlyLimit(sql: string, limit: number): string {
  const statement = splitSqlStatements(sql)[0] ?? sql.trim();
  return `${statement.replace(/;\s*$/u, "").trimEnd()}\nLIMIT ${limit}`;
}

function maybeApplyAutomaticReadOnlyLimit(sql: string, reason: string, previewRowLimit: number): {
  sql: string;
  autoAppliedReadOnlyLimit?: number;
} {
  const normalizedLimit =
    Number.isFinite(previewRowLimit) && previewRowLimit > 0
      ? Math.max(1, Math.floor(previewRowLimit))
      : null;
  if (!normalizedLimit) {
    return { sql };
  }

  const safety = assessSqlSafety(sql);
  if (safety.operation !== "SELECT") {
    return { sql };
  }

  if (hasExplicitRowLimit(sql)) {
    return { sql };
  }

  const normalizedSql = sql.replace(/\s+/g, " ").trim();
  if (/\boffset\b/iu.test(normalizedSql) || /\bfor\s+(?:update|share)\b/iu.test(normalizedSql)) {
    return { sql };
  }

  if (shouldSkipAutomaticReadOnlyLimit(reason)) {
    return { sql };
  }

  return {
    sql: buildSqlWithReadOnlyLimit(sql, normalizedLimit),
    autoAppliedReadOnlyLimit: normalizedLimit,
  };
}

function serializeQueryResultForModel(
  result: QueryExecutionResult & {
    status?: string;
    reason?: string;
    previewRows?: Record<string, unknown>[];
    autoAppliedReadOnlyLimit?: number;
    catalogRefresh?: {
      status?: string;
      reason?: string;
      result?: SchemaCatalogSyncResult;
      error?: string;
      };
  },
) {
  const previewFields = result.fields.slice(0, MAX_MODEL_PREVIEW_FIELDS);
  const omittedFieldCount = Math.max(0, result.fields.length - previewFields.length);
  const catalogRefresh =
    isRecord(result.catalogRefresh) && result.catalogRefresh.status !== "not_needed"
      ? {
          status: typeof result.catalogRefresh.status === "string" ? result.catalogRefresh.status : "unknown",
          reason: typeof result.catalogRefresh.reason === "string" ? clipText(result.catalogRefresh.reason, 120) : undefined,
          tableCount:
            typeof result.catalogRefresh.result?.tableCount === "number" ? result.catalogRefresh.result.tableCount : undefined,
          addedTableCount:
            Array.isArray(result.catalogRefresh.result?.addedTables) ? result.catalogRefresh.result.addedTables.length : undefined,
          updatedTableCount:
            Array.isArray(result.catalogRefresh.result?.updatedTables) ? result.catalogRefresh.result.updatedTables.length : undefined,
          removedTableCount:
            Array.isArray(result.catalogRefresh.result?.removedTables) ? result.catalogRefresh.result.removedTables.length : undefined,
          error: typeof result.catalogRefresh.error === "string" ? clipText(result.catalogRefresh.error, 120) : undefined,
        }
      : undefined;
  const payload = {
    status: result.status ?? "executed",
    reason: result.reason,
    sql: clipMiddle(result.sql, MAX_SQL_CHARS),
    operation: result.operation,
    rowCount: result.rowCount,
    cachedRowCount: result.rows.length,
    rowsTruncated: result.rowsTruncated,
    fields: previewFields,
    omittedFieldCount,
    elapsedMs: result.elapsedMs,
    previewAvailable: result.rowCount > 0,
    autoAppliedReadOnlyLimit: typeof result.autoAppliedReadOnlyLimit === "number" ? result.autoAppliedReadOnlyLimit : undefined,
    catalogRefresh,
  };

  const fieldSummary = previewFields.length
    ? ` Fields: ${previewFields.join(", ")}${omittedFieldCount ? ` (+${omittedFieldCount} more)` : ""}.`
    : "";
  const truncationSummary = result.rowsTruncated ? ` Cached rows were limited to ${result.rows.length}.` : "";
  const automaticLimitSummary =
    typeof result.autoAppliedReadOnlyLimit === "number"
      ? ` A default LIMIT ${result.autoAppliedReadOnlyLimit} was added because the query had no explicit row bound.`
      : "";
  const catalogRefreshSummary =
    catalogRefresh?.status === "manual_required"
      ? " Schema catalog was not refreshed automatically after the schema change. Run `dbchat catalog sync` manually before relying on schema search results."
      : "";
  return {
    content: stringifyCompact(payload),
    summary: `SQL ${payload.status}: ${payload.operation} returned ${payload.rowCount} rows in ${payload.elapsedMs.toFixed(2)}ms.${fieldSummary}${truncationSummary}${automaticLimitSummary}${catalogRefreshSummary}`,
  };
}

function serializeCancelledSqlResult(result: Record<string, unknown>) {
  const sql = typeof result.sql === "string" ? clipMiddle(result.sql, MAX_SQL_CHARS) : "";
  const operation = typeof result.operation === "string" ? result.operation : "UNKNOWN";
  const executionCategory = typeof result.executionCategory === "string" ? result.executionCategory : "unknown";
  const cancelledBy =
    result.cancelledBy === "database_access" || result.cancelledBy === "user_rejection" || result.cancelledBy === "other"
      ? result.cancelledBy
      : "other";
  const approvalPromptShown = typeof result.approvalPromptShown === "boolean" ? result.approvalPromptShown : false;
  const payload = {
    status: "cancelled",
    cancelledBy,
    approvalPromptShown,
    reason: typeof result.reason === "string" ? result.reason : "The SQL statement was not executed.",
    sql,
    operation,
    executionCategory,
  };

  const summaryPrefix =
    cancelledBy === "database_access"
      ? "SQL blocked by database access policy"
      : cancelledBy === "user_rejection"
        ? "SQL rejected by user"
        : "SQL cancelled";
  return {
    content: stringifyCompact(payload),
    summary: `${summaryPrefix}: ${operation} (${executionCategory}) was not executed.`,
  };
}

function serializeExplainResult(result: QueryPlanResult) {
  const payload = {
    sql: clipMiddle(result.sql, MAX_SQL_CHARS),
    operation: result.operation,
    elapsedMs: result.elapsedMs,
    warnings: result.warnings,
    planPreview: clipMiddle(buildPlanPreview(result.rawPlan), MAX_MODEL_PLAN_PREVIEW_CHARS),
  };

  const warningSummary = result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}.` : "";
  return {
    content: stringifyCompact(payload),
    summary: `Explain completed for ${result.operation} in ${result.elapsedMs.toFixed(2)}ms.${warningSummary}`,
  };
}

export const runSqlTool = defineTool(
  {
    name: "run_sql",
    description:
      "Execute a single SQL statement. If the SQL operation is allowed by the active database access policy, DML, DDL, or unclassified SQL will require user approval in the CLI. If the access policy blocks the operation, the statement will be rejected before any approval prompt is shown.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sql: {
          type: "string",
          description: "The SQL statement to execute.",
        },
        reason: {
          type: "string",
          description: "Why this SQL should be executed.",
        },
      },
      required: ["sql", "reason"],
    },
  },
  runSqlSchema,
  async (args, context) => {
    const normalizedSql = maybeApplyAutomaticReadOnlyLimit(args.sql, args.reason, context.config.app.previewRowLimit);
    context.io.log(`SQL reason: ${args.reason}`);
    if (typeof normalizedSql.autoAppliedReadOnlyLimit === "number") {
      context.io.log(
        `Applied default LIMIT ${normalizedSql.autoAppliedReadOnlyLimit} to this read-only SELECT because it had no explicit row bound.`,
      );
    }
    context.io.logBlock("SQL to execute", normalizedSql.sql);

    const safety = assessSqlSafety(normalizedSql.sql);
    if (safety.warnings.length) {
      context.io.logBlock("SQL warnings", safety.warnings.join("\n"));
    }

    const execution = await executeManagedSql({
      config: context.config,
      db: context.db,
      io: context.io,
      sql: normalizedSql.sql,
      approvalState: context.mutationApproval,
    });
    if (execution.status === "cancelled") {
      return execution;
    }

    const result =
      typeof normalizedSql.autoAppliedReadOnlyLimit === "number"
        ? {
            ...execution.result,
            autoAppliedReadOnlyLimit: normalizedSql.autoAppliedReadOnlyLimit,
          }
        : execution.result;
    if (execution.catalogRefresh.status === "manual_required") {
      context.schemaCatalogCache = null;
    }
    context.setLastResult(result);
    const truncationSuffix = result.rowsTruncated ? `, cached first ${result.rows.length}` : "";
    context.io.log(`SQL execution completed: ${result.rowCount} rows${truncationSuffix}, ${result.elapsedMs.toFixed(2)}ms`);
    return {
      status: "executed",
      reason: args.reason,
      executionCategory: execution.safety.executionCategory,
      approvalDecision: execution.approvalDecision,
      catalogRefresh: execution.catalogRefresh,
      ...result,
      previewRows: result.rows.slice(0, context.config.app.previewRowLimit),
    };
  },
  (result, _appConfig) => {
    if (isRecord(result) && result.status === "cancelled") {
      return serializeCancelledSqlResult(result);
    }

    return serializeQueryResultForModel(
      result as QueryExecutionResult & {
        status?: string;
        reason?: string;
        previewRows?: Record<string, unknown>[];
      },
    );
  },
);

export const explainSqlTool = defineTool(
  {
    name: "explain_sql",
    description: "Get the execution plan for a SQL statement for performance analysis.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sql: {
          type: "string",
          description: "The SQL statement to analyze.",
        },
      },
      required: ["sql"],
    },
  },
  explainSqlSchema,
  async (args, context) => {
    context.io.logBlock("SQL to explain", args.sql);
    const plan = await explainSql({
      db: context.db,
      io: context.io,
      sql: args.sql,
    });
    context.setLastExplain(plan);
    context.io.log(`Explain completed in ${plan.elapsedMs.toFixed(2)}ms`);
    return plan;
  },
  (result) => serializeExplainResult(result as QueryPlanResult),
);
