import { z } from "zod";
import type { QueryExecutionResult, QueryPlanResult } from "../../types/index.js";
import { splitSqlStatements } from "../../db/safety.js";
import {
  buildPreviewTable,
  buildPlanPreview,
  clipMiddle,
  compactValue,
  compactRows,
  stringifyCompact,
} from "../serialize-helpers.js";
import { defineTool } from "../specs.js";
import { buildQueryResultPreview } from "../../ui/query-result-preview.js";
import { stripArtifactReferenceLines } from "../../ui/result-artifacts.js";
import { formatSqlDisplayScalar } from "../../ui/value-format.js";

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
  expandPreview: z.boolean().optional(),
});

const searchLastResultSchema = z.object({
  query: z.string().min(1).max(120),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(10).optional(),
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
  autoAppliedReadOnlyLimit?: number;
  fields: string[];
  offset: number;
  limit: number;
  expandPreview: boolean;
  rows: Record<string, unknown>[];
  renderedText: string;
  hasMoreRows: boolean;
}

interface SearchedCachedResult {
  sql: string;
  operation: QueryExecutionResult["operation"];
  rowCount: number;
  cachedRowCount: number;
  rowsTruncated: boolean;
  query: string;
  fields: string[];
  offset: number;
  limit: number;
  matchedRowCount: number;
  rows: Array<Record<string, unknown> & { __rowNumber: number; __matchedFields: string[] }>;
}

function compactInspectedRows(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, compactValue(row[field])])) as Record<string, unknown>);
}

function inferRequestedVisibleLimitFromSql(sql: string): number | undefined {
  const statement = splitSqlStatements(sql)[0] ?? sql.trim();
  const mysqlOffsetLimitMatch = statement.match(/\blimit\s+\d+\s*,\s*(\d+)\b/iu);
  if (mysqlOffsetLimitMatch?.[1]) {
    const parsed = Number(mysqlOffsetLimitMatch[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  const limitMatch = statement.match(/\blimit\s+(\d+)\b/iu);
  if (limitMatch?.[1]) {
    const parsed = Number(limitMatch[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  const fetchMatch = statement.match(/\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\b/iu);
  if (fetchMatch?.[1]) {
    const parsed = Number(fetchMatch[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
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

function stringifySearchableValue(value: unknown): string {
  if (value == null) {
    return "";
  }

  const formattedScalar = formatSqlDisplayScalar(value);
  if (typeof formattedScalar === "string" || typeof formattedScalar === "number" || typeof formattedScalar === "boolean") {
    return String(formattedScalar);
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => stringifySearchableValue(item)).join(" ");
  }

  if (typeof formattedScalar === "object") {
    return stringifyCompact(formattedScalar);
  }

  return String(formattedScalar);
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
    const previewRows = compactInspectedRows(inspected.rows, inspected.fields);
    const previewTable = inspected.fields.length <= 8 ? buildPreviewTable(previewRows, inspected.fields) : undefined;
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
      rows: previewRows,
      previewTable,
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
      "Render a cached slice of the most recent query result into ready-to-display plain text. Use this when the user wants visible rows and you should not manually format the SQL result yourself. Large results automatically include browser-openable HTML and matching CSV artifacts, so only paginate when the user truly needs another slice in the terminal.",
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
          description: `Maximum number of cached rows to render in one page, up to ${MAX_RENDER_LIMIT}. By default the terminal preview still stays compact; use expandPreview=true only when the user explicitly asked to see that many visible rows.`,
        },
        columns: {
          type: "array",
          description: "Optional exact column names to include in the rendered rows.",
          items: {
            type: "string",
          },
        },
        expandPreview: {
          type: "boolean",
          description:
            "When true, expand the terminal preview up to the requested limit instead of keeping the normal compact preview. Only set this when the user explicitly asked to see all rows or another exact visible row count.",
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
    const previewRowLimit = context.config.app.tableRendering.previewRowLimit ?? DEFAULT_RENDER_LIMIT;
    const inferredLimitFromSql = inferRequestedVisibleLimitFromSql(lastResult.sql);
    const requestedLimit =
      args.limit ??
      Math.min(inferredLimitFromSql ?? previewRowLimit, previewRowLimit) ??
      DEFAULT_RENDER_LIMIT;
    const normalizedRequestedLimit = Math.min(requestedLimit, MAX_RENDER_LIMIT);
    const expandPreview = args.expandPreview === true;
    const limit = expandPreview ? normalizedRequestedLimit : Math.min(normalizedRequestedLimit, previewRowLimit);
    const requestedColumns = Array.from(new Set(args.columns ?? []));
    const missingColumns = requestedColumns.filter((column) => !lastResult.fields.includes(column));
    if (missingColumns.length) {
      throw new Error(`Unknown cached result columns: ${missingColumns.join(", ")}.`);
    }

    const requestedFieldOrder = requestedColumns.length
      ? lastResult.fields.filter((field) => requestedColumns.includes(field))
      : [...lastResult.fields];
    const preview = buildQueryResultPreview(lastResult, {
      tableRendering: {
        ...context.config.app.tableRendering,
        inlineRowLimit: Math.max(context.config.app.tableRendering.inlineRowLimit, limit),
        inlineColumnLimit: requestedColumns.length
          ? Math.max(requestedFieldOrder.length, 1)
          : Math.max(context.config.app.tableRendering.inlineColumnLimit, 1),
        previewRowLimit: limit,
      },
      offset,
      limit,
      columns: requestedColumns,
    });
    const renderedLines = [preview.renderedText];

    if (requestedLimit > MAX_RENDER_LIMIT) {
      renderedLines.push(`Requested limit ${requestedLimit} exceeded the per-call maximum, so this page was capped at ${MAX_RENDER_LIMIT} rows.`);
    }
    if (!expandPreview && normalizedRequestedLimit > limit) {
      renderedLines.push(`Requested ${normalizedRequestedLimit} visible rows, but the terminal preview stayed compact at ${limit} rows.`);
    }

    context.pushDisplayBlock({
      kind: "result_table",
      title: "Result Preview",
      body: stripArtifactReferenceLines(preview.renderedText),
      table: {
        fields: preview.fields,
        rows: preview.rows,
      },
    });
    context.io.log(`Rendering cached result rows ${preview.rows.length ? offset + 1 : 0}-${preview.rows.length ? offset + preview.rows.length : 0}`);
    return {
      sql: lastResult.sql,
      operation: lastResult.operation,
      rowCount: lastResult.rowCount,
      cachedRowCount: lastResult.rows.length,
      rowsTruncated: lastResult.rowsTruncated,
      autoAppliedReadOnlyLimit: lastResult.autoAppliedReadOnlyLimit,
      fields: preview.fields,
      offset,
      limit,
      expandPreview,
      rows: compactRows(preview.rows, preview.rows.length),
      renderedText: renderedLines.join("\n"),
      hasMoreRows: preview.hasMoreRows,
    } satisfies RenderedCachedResult;
  },
  (result) => {
    const rendered = result as RenderedCachedResult;
    const payload = {
      sql: clipMiddle(rendered.sql, MAX_RESULT_SQL_CHARS),
      operation: rendered.operation,
      rowCount: rendered.rowCount,
      cachedRowCount: rendered.cachedRowCount,
      rowsTruncated: rendered.rowsTruncated,
      offset: rendered.offset,
      limit: rendered.limit,
      returnedRowCount: rendered.rows.length,
      fields: rendered.fields,
      expandPreview: rendered.expandPreview,
      hasMoreRows: rendered.hasMoreRows,
      renderedInTerminal: true,
    };
    return {
      content: stringifyCompact(payload),
      summary: `Cached result rendered: ${rendered.rows.length} rows from offset ${rendered.offset}.`,
    };
  },
);

export const searchLastResultTool = defineTool(
  {
    name: "search_last_result",
    description:
      "Search the cached rows of the most recent query result without rerunning SQL. Use this when you need to locate a specific record or value from the current result before deciding what to say or do next.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive substring to search for inside cached row values.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Zero-based match offset into the search results.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of matching rows to return, up to 10.",
        },
        columns: {
          type: "array",
          description: "Optional exact column names to search within and return.",
          items: {
            type: "string",
          },
        },
      },
      required: ["query"],
    },
  },
  searchLastResultSchema,
  async (args, context) => {
    const lastResult = context.getLastResult();
    if (!lastResult) {
      throw new Error("There is no cached query result to search.");
    }

    const offset = args.offset ?? 0;
    const limit = Math.min(args.limit ?? 5, 10);
    const requestedColumns = Array.from(new Set(args.columns ?? []));
    const missingColumns = requestedColumns.filter((column) => !lastResult.fields.includes(column));
    if (missingColumns.length) {
      throw new Error(`Unknown cached result columns: ${missingColumns.join(", ")}.`);
    }

    const fields = requestedColumns.length
      ? lastResult.fields.filter((field) => requestedColumns.includes(field))
      : [...lastResult.fields];
    const normalizedQuery = args.query.trim().toLowerCase();
    const matches = lastResult.rows.flatMap((row, index) => {
      const matchedFields = fields.filter((field) => stringifySearchableValue(row[field]).toLowerCase().includes(normalizedQuery));
      if (!matchedFields.length) {
        return [];
      }

      return [
        {
          __rowNumber: index + 1,
          __matchedFields: matchedFields,
          ...Object.fromEntries(fields.map((field) => [field, row[field]])),
        },
      ];
    });
    const rows = matches.slice(offset, offset + limit);
    context.io.log(`Searching cached result for '${args.query}' returned ${matches.length} matches`);
    return {
      sql: lastResult.sql,
      operation: lastResult.operation,
      rowCount: lastResult.rowCount,
      cachedRowCount: lastResult.rows.length,
      rowsTruncated: lastResult.rowsTruncated,
      query: args.query,
      fields,
      offset,
      limit,
      matchedRowCount: matches.length,
      rows,
    } satisfies SearchedCachedResult;
  },
  (result) => {
    const searched = result as SearchedCachedResult;
    const previewRows = compactRows(
      searched.rows.map((row) => ({
        rowNumber: row.__rowNumber,
        matchedFields: row.__matchedFields.join(", "),
        ...Object.fromEntries(searched.fields.map((field) => [field, row[field]])),
      })),
      searched.limit,
    );
    const previewTable = buildPreviewTable(previewRows, ["rowNumber", "matchedFields", ...searched.fields]);
    const payload = {
      sql: clipMiddle(searched.sql, MAX_RESULT_SQL_CHARS),
      operation: searched.operation,
      rowCount: searched.rowCount,
      cachedRowCount: searched.cachedRowCount,
      rowsTruncated: searched.rowsTruncated,
      query: searched.query,
      fields: searched.fields,
      offset: searched.offset,
      limit: searched.limit,
      matchedRowCount: searched.matchedRowCount,
      returnedRowCount: searched.rows.length,
      previewRows,
      previewTable,
      previewTruncated: searched.rows.length > previewRows.length,
    };

    return {
      content: stringifyCompact(payload),
      summary: `Cached result search: ${payload.matchedRowCount} matches for '${searched.query}'.`,
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
