import type { QueryExecutionResult } from "../types/index.js";

export interface QueryExecutionOptions {
  maxRows?: number;
}

/**
 * Clamp cached result rows so large SELECT queries do not stay resident in memory forever.
 */
export function applyResultRowLimit(
  sql: string,
  operation: QueryExecutionResult["operation"],
  rowCount: number,
  rows: Record<string, unknown>[],
  fields: string[],
  elapsedMs: number,
  options?: QueryExecutionOptions,
): QueryExecutionResult {
  const normalizedLimit =
    typeof options?.maxRows === "number" && Number.isFinite(options.maxRows) && options.maxRows > 0
      ? Math.floor(options.maxRows)
      : null;
  const rowsTruncated = normalizedLimit !== null && rows.length > normalizedLimit;

  return {
    sql,
    operation,
    rowCount,
    rows: rowsTruncated ? rows.slice(0, normalizedLimit) : rows,
    rowsTruncated,
    fields,
    elapsedMs,
  };
}
