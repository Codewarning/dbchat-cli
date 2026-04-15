import { z } from "zod";
import type { QueryExecutionResult, QueryPlanResult } from "../../types/index.js";
import {
  buildPreviewTable,
  buildPlanPreview,
  clipMiddle,
  compactRows,
  stringifyCompact,
} from "../serialize-helpers.js";
import { defineTool } from "../specs.js";
import { formatRecordsTable } from "../../ui/text-table.js";

const DEFAULT_INSPECT_LIMIT = 8;
const MAX_INSPECT_LIMIT = 20;
const MAX_RESULT_SQL_CHARS = 800;
const DEFAULT_EXPLAIN_PREVIEW_CHARS = 2200;
const MAX_EXPLAIN_PREVIEW_CHARS = 4000;
const DEFAULT_RENDER_LIMIT = 10;
const MAX_RENDER_LIMIT = 100;

const inspectLastResultSchema = z.object({
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(MAX_INSPECT_LIMIT).optional(),
  columns: z.array(z.string().min(1)).max(20).optional(),
});

const renderLastResultSchema = z.object({
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().optional(),
  columns: z.array(z.string().min(1)).max(20).optional(),
});

const inspectLastExplainSchema = z.object({
  focus: z.string().min(1).max(120).optional(),
  maxChars: z.number().int().positive().max(MAX_EXPLAIN_PREVIEW_CHARS).optional(),
});

interface CachedResultInspection {
  sql: string;
  operation: QueryExecutionResult["operation"];
  rowCount: number;
  cachedRowCount: number;
  rowsTruncated: boolean;
  fields: string[];
  offset: number;
  limit: number;
  rows: Record<string, unknown>[];
}

interface CachedExplainInspection {
  sql: string;
  operation: QueryPlanResult["operation"];
  elapsedMs: number;
  warnings: string[];
  focus?: string;
  preview: string;
}

interface RenderedCachedResult {
  sql: string;
  operation: QueryExecutionResult["operation"];
  rowCount: number;
  cachedRowCount: number;
  rowsTruncated: boolean;
  fields: string[];
  offset: number;
  limit: number;
  rows: Record<string, unknown>[];
  renderedText: string;
  hasMoreRows: boolean;
}

function buildFocusedPlanPreview(rawPlan: unknown, maxChars: number, focus?: string): string {
  const serialized = typeof rawPlan === "string" ? rawPlan : stringifyCompact(rawPlan);
  const normalizedFocus = focus?.trim().toLowerCase();
  if (!normalizedFocus) {
    return buildPlanPreview(serialized.length <= maxChars ? serialized : clipMiddle(serialized, maxChars));
  }

  const normalizedPlan = serialized.toLowerCase();
  const matchIndex = normalizedPlan.indexOf(normalizedFocus);
  if (matchIndex < 0) {
    return clipMiddle(serialized, maxChars);
  }

  const halfWindow = Math.max(0, Math.floor((maxChars - 3) / 2));
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(serialized.length, matchIndex + normalizedFocus.length + halfWindow);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < serialized.length ? "..." : "";
  return `${prefix}${serialized.slice(start, end)}${suffix}`;
}

export const inspectLastResultTool = defineTool(
  {
    name: "inspect_last_result",
    description:
      "Inspect a cached slice of the most recent query result without rerunning SQL. Use this when the latest result summary is too small and you need more rows or a subset of columns.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        offset: {
          type: "integer",
          minimum: 0,
          description: "Zero-based row offset into the cached result rows.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_INSPECT_LIMIT,
          description: `Maximum number of cached rows to inspect, up to ${MAX_INSPECT_LIMIT}.`,
        },
        columns: {
          type: "array",
          description: "Optional exact column names to include from the cached rows.",
          items: {
            type: "string",
          },
        },
      },
    },
  },
  inspectLastResultSchema,
  async (args, context) => {
    const lastResult = context.getLastResult();
    if (!lastResult) {
      throw new Error("There is no cached query result to inspect.");
    }

    const offset = args.offset ?? 0;
    const limit = Math.min(args.limit ?? DEFAULT_INSPECT_LIMIT, MAX_INSPECT_LIMIT);
    const requestedColumns = Array.from(new Set(args.columns ?? []));
    const missingColumns = requestedColumns.filter((column) => !lastResult.fields.includes(column));
    if (missingColumns.length) {
      throw new Error(`Unknown cached result columns: ${missingColumns.join(", ")}.`);
    }

    const fields = requestedColumns.length
      ? lastResult.fields.filter((field) => requestedColumns.includes(field))
      : [...lastResult.fields];
    const rows = lastResult.rows.slice(offset, offset + limit).map((row) =>
      Object.fromEntries(fields.map((field) => [field, row[field]])),
    );
    const endRow = rows.length ? offset + rows.length : offset;
    context.io.log(`Inspecting cached result rows ${offset + 1}-${endRow}`);
    return {
      sql: lastResult.sql,
      operation: lastResult.operation,
      rowCount: lastResult.rowCount,
      cachedRowCount: lastResult.rows.length,
      rowsTruncated: lastResult.rowsTruncated,
      fields,
      offset,
      limit,
      rows,
    } satisfies CachedResultInspection;
  },
  (result) => {
    const inspected = result as CachedResultInspection;
    const previewRows = compactRows(inspected.rows, inspected.limit);
    const previewTable = buildPreviewTable(previewRows, inspected.fields);
    const payload = {
      sql: clipMiddle(inspected.sql, MAX_RESULT_SQL_CHARS),
      operation: inspected.operation,
      rowCount: inspected.rowCount,
      cachedRowCount: inspected.cachedRowCount,
      rowsTruncated: inspected.rowsTruncated,
      fields: inspected.fields,
      offset: inspected.offset,
      limit: inspected.limit,
      returnedRowCount: inspected.rows.length,
      previewRows,
      previewTable,
      previewTruncated: inspected.rows.length > previewRows.length,
    };

    const fieldSummary = inspected.fields.length ? ` Fields: ${inspected.fields.join(", ")}.` : "";
    return {
      content: stringifyCompact(payload),
      summary: `Cached result inspected: ${payload.returnedRowCount} rows from offset ${payload.offset}.${fieldSummary}`,
    };
  },
);

export const renderLastResultTool = defineTool(
  {
    name: "render_last_result",
    description:
      "Render a cached slice of the most recent query result into ready-to-display plain text. Use this when the user wants visible rows and you should not manually format the SQL result yourself. This tool renders up to 100 rows per call, so only paginate when the user needs more than 100 visible rows.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        offset: {
          type: "integer",
          minimum: 0,
          description: "Zero-based row offset into the cached result rows.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RENDER_LIMIT,
          description: `Maximum number of cached rows to render in one page, up to ${MAX_RENDER_LIMIT}. If the user wants more than ${MAX_RENDER_LIMIT} visible rows, call this tool multiple times with different offsets.`,
        },
        columns: {
          type: "array",
          description: "Optional exact column names to include in the rendered rows.",
          items: {
            type: "string",
          },
        },
      },
    },
  },
  renderLastResultSchema,
  async (args, context) => {
    const lastResult = context.getLastResult();
    if (!lastResult) {
      throw new Error("There is no cached query result to render.");
    }

    const offset = args.offset ?? 0;
    const requestedLimit = args.limit ?? DEFAULT_RENDER_LIMIT;
    const limit = Math.min(requestedLimit, MAX_RENDER_LIMIT);
    const requestedColumns = Array.from(new Set(args.columns ?? []));
    const missingColumns = requestedColumns.filter((column) => !lastResult.fields.includes(column));
    if (missingColumns.length) {
      throw new Error(`Unknown cached result columns: ${missingColumns.join(", ")}.`);
    }

    const fields = requestedColumns.length
      ? lastResult.fields.filter((field) => requestedColumns.includes(field))
      : [...lastResult.fields];
    const rows = compactRows(
      lastResult.rows.slice(offset, offset + limit).map((row) =>
        Object.fromEntries(fields.map((field) => [field, row[field]])),
      ),
      limit,
    );
    const endRow = rows.length ? offset + rows.length : offset;
    const table = rows.length ? formatRecordsTable(rows, fields) : "(none)";
    const hasMoreRows = offset + rows.length < lastResult.rows.length;
    const lines = [
      `SQL result rows ${rows.length ? offset + 1 : 0}-${endRow} of ${lastResult.rowCount}:`,
      table,
    ];

    if (requestedLimit > MAX_RENDER_LIMIT) {
      lines.push(`Requested limit ${requestedLimit} exceeded the per-call maximum, so this page was capped at ${MAX_RENDER_LIMIT} rows.`);
    }

    if (hasMoreRows) {
      lines.push(`More cached rows are available. Call render_last_result with offset=${offset + rows.length} to continue.`);
    } else if (lastResult.rowsTruncated && lastResult.rowCount > lastResult.rows.length) {
      lines.push(`The in-memory cache contains ${lastResult.rows.length} rows, but the query returned ${lastResult.rowCount} rows in total.`);
    }

    context.io.log(`Rendering cached result rows ${rows.length ? offset + 1 : 0}-${endRow}`);
    return {
      sql: lastResult.sql,
      operation: lastResult.operation,
      rowCount: lastResult.rowCount,
      cachedRowCount: lastResult.rows.length,
      rowsTruncated: lastResult.rowsTruncated,
      fields,
      offset,
      limit,
      rows,
      renderedText: lines.join("\n"),
      hasMoreRows,
    } satisfies RenderedCachedResult;
  },
  (result) => {
    const rendered = result as RenderedCachedResult;
    return {
      content: rendered.renderedText,
      summary: `Cached result rendered: ${rendered.rows.length} rows from offset ${rendered.offset}.`,
    };
  },
);

export const inspectLastExplainTool = defineTool(
  {
    name: "inspect_last_explain",
    description:
      "Inspect the cached raw EXPLAIN output from the most recent explain_sql call without rerunning EXPLAIN. Use this when you need more plan detail or want to focus on one keyword such as a table, index, or scan node.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus: {
          type: "string",
          description: "Optional keyword to center the preview around, such as a table name, index name, or plan node.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_EXPLAIN_PREVIEW_CHARS,
          description: `Maximum number of characters to return from the cached plan preview, up to ${MAX_EXPLAIN_PREVIEW_CHARS}.`,
        },
      },
    },
  },
  inspectLastExplainSchema,
  async (args, context) => {
    const lastExplain = context.getLastExplain();
    if (!lastExplain) {
      throw new Error("There is no cached EXPLAIN result to inspect.");
    }

    const maxChars = Math.min(args.maxChars ?? DEFAULT_EXPLAIN_PREVIEW_CHARS, MAX_EXPLAIN_PREVIEW_CHARS);
    const preview = buildFocusedPlanPreview(lastExplain.rawPlan, maxChars, args.focus);
    context.io.log(`Inspecting cached EXPLAIN preview${args.focus ? ` around '${args.focus}'` : ""}`);
    return {
      sql: lastExplain.sql,
      operation: lastExplain.operation,
      elapsedMs: lastExplain.elapsedMs,
      warnings: lastExplain.warnings,
      focus: args.focus,
      preview,
    } satisfies CachedExplainInspection;
  },
  (result) => {
    const inspected = result as CachedExplainInspection;
    const payload = {
      sql: clipMiddle(inspected.sql, MAX_RESULT_SQL_CHARS),
      operation: inspected.operation,
      elapsedMs: inspected.elapsedMs,
      warnings: inspected.warnings,
      focus: inspected.focus,
      planPreview: inspected.preview,
    };

    const warningSummary = inspected.warnings.length ? ` Warnings: ${inspected.warnings.join("; ")}.` : "";
    const focusSummary = inspected.focus ? ` Focus: ${inspected.focus}.` : "";
    return {
      content: stringifyCompact(payload),
      summary: `Cached EXPLAIN inspected for ${inspected.operation}.${focusSummary}${warningSummary}`,
    };
  },
);
