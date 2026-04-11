import { z } from "zod";
import { assessSqlSafety } from "../../db/safety.js";
import { executeManagedSql, explainSql } from "../../services/sql.js";
import type { AppRuntimeConfig, QueryExecutionResult, QueryPlanResult, SchemaCatalogSyncResult } from "../../types/index.js";
import {
  buildPlanPreview,
  buildPreviewTable,
  clipMiddle,
  clipText,
  compactRows,
  isRecord,
  stringifyCompact,
} from "../serialize-helpers.js";
import { defineTool } from "../specs.js";

const MAX_MODEL_PREVIEW_ROWS = 5;
const MAX_SQL_CHARS = 800;

const runSqlSchema = z.object({
  sql: z.string().min(1),
  reason: z.string().min(1),
});

const explainSqlSchema = z.object({
  sql: z.string().min(1),
});

function serializeQueryResultForModel(
  result: QueryExecutionResult & {
    status?: string;
    reason?: string;
    previewRows?: Record<string, unknown>[];
    catalogRefresh?: {
      status?: string;
      reason?: string;
      result?: SchemaCatalogSyncResult;
      error?: string;
    };
  },
  appConfig: AppRuntimeConfig,
) {
  const previewLimit = Math.min(appConfig.previewRowLimit, MAX_MODEL_PREVIEW_ROWS);
  const previewSource = Array.isArray(result.previewRows) ? result.previewRows : result.rows;
  const previewRows = compactRows(previewSource, previewLimit);
  const previewTable = buildPreviewTable(previewRows, result.fields);
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
    fields: result.fields,
    elapsedMs: result.elapsedMs,
    previewRows,
    previewTable,
    previewTruncated: result.rowCount > previewRows.length,
    catalogRefresh,
  };

  const fieldSummary = result.fields.length ? ` Fields: ${result.fields.join(", ")}.` : "";
  const truncationSummary = result.rowsTruncated ? ` Cached rows were limited to ${result.rows.length}.` : "";
  const catalogRefreshSummary =
    catalogRefresh?.status === "refreshed"
      ? " Schema catalog refreshed after the schema change."
      : catalogRefresh?.status === "failed"
        ? ` Schema catalog refresh failed: ${catalogRefresh.error ?? "unknown error"}.`
        : "";
  return {
    content: stringifyCompact(payload),
    summary: `SQL ${payload.status}: ${payload.operation} returned ${payload.rowCount} rows in ${payload.elapsedMs.toFixed(2)}ms.${fieldSummary}${truncationSummary}${catalogRefreshSummary}`,
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
    planPreview: buildPlanPreview(result.rawPlan),
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
    context.io.log(`SQL reason: ${args.reason}`);
    context.io.logBlock("SQL to execute", args.sql);

    const safety = assessSqlSafety(args.sql);
    if (safety.warnings.length) {
      context.io.logBlock("SQL warnings", safety.warnings.join("\n"));
    }

    const execution = await executeManagedSql({
      config: context.config,
      db: context.db,
      io: context.io,
      sql: args.sql,
      approvalState: context.mutationApproval,
    });
    if (execution.status === "cancelled") {
      return execution;
    }

    const result = execution.result;
    if (execution.catalogRefresh.status === "refreshed") {
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
  (result, appConfig) => {
    if (isRecord(result) && result.status === "cancelled") {
      return serializeCancelledSqlResult(result);
    }

    return serializeQueryResultForModel(
      result as QueryExecutionResult & {
        status?: string;
        reason?: string;
        previewRows?: Record<string, unknown>[];
      },
      appConfig,
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
    context.io.log(`Explain completed in ${plan.elapsedMs.toFixed(2)}ms`);
    return plan;
  },
  (result) => serializeExplainResult(result as QueryPlanResult),
);
