import type { QueryExecutionResult, TableRenderingConfig } from "../types/index.js";
import { formatRecordsTable, selectCompactColumnOrder } from "./text-table.js";

export interface QueryResultPreview {
  renderedText: string;
  fields: string[];
  rows: Record<string, unknown>[];
  hasMoreRows: boolean;
}

function projectRows(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
}

/**
 * Build the terminal-facing preview text for a cached query result slice.
 */
export function buildQueryResultPreview(
  result: QueryExecutionResult,
  options: {
    tableRendering: TableRenderingConfig;
    offset?: number;
    limit?: number;
    columns?: string[];
  },
): QueryResultPreview {
  const offset = options.offset ?? 0;
  const availableRows = result.rows.slice(offset);
  const requestedLimit = options.limit ?? availableRows.length;
  const requestedColumns = Array.from(new Set(options.columns ?? []));
  const requestedFieldOrder = requestedColumns.length
    ? result.fields.filter((field) => requestedColumns.includes(field))
    : [...result.fields];
  const requestedRows = projectRows(availableRows.slice(0, requestedLimit), requestedFieldOrder);
  const shouldInline =
    requestedRows.length <= options.tableRendering.inlineRowLimit &&
    requestedFieldOrder.length <= options.tableRendering.inlineColumnLimit;
  const compactSelection =
    requestedColumns.length || requestedFieldOrder.length <= options.tableRendering.inlineColumnLimit
      ? {
          columns: requestedFieldOrder,
          omittedColumnCount: 0,
        }
      : selectCompactColumnOrder(requestedFieldOrder, options.tableRendering.inlineColumnLimit);
  const fields = shouldInline ? requestedFieldOrder : compactSelection.columns;
  const displayRows = projectRows(
    shouldInline ? requestedRows : requestedRows.slice(0, options.tableRendering.previewRowLimit),
    fields,
  );
  const displayedStartRow = displayRows.length ? offset + 1 : 0;
  const displayedEndRow = displayRows.length ? offset + displayRows.length : 0;
  const hasMoreRows = offset + displayRows.length < result.rows.length;
  const lines = [`SQL result rows ${displayedStartRow}-${displayedEndRow} of ${result.rowCount}:`];

  if (typeof result.autoAppliedReadOnlyLimit === "number") {
    lines.push(
      `This read-only preview was auto-limited to ${result.autoAppliedReadOnlyLimit} rows because the query had no explicit row bound.`,
    );
  }

  if (!shouldInline && compactSelection.omittedColumnCount > 0) {
    lines.push(
      result.htmlArtifact
        ? `Showing ${fields.length} of ${requestedFieldOrder.length} columns in the terminal preview. Open the HTML view for all columns.`
        : `Showing ${fields.length} of ${requestedFieldOrder.length} columns in the terminal preview.`,
    );
  }

  if (!shouldInline && requestedRows.length > displayRows.length) {
    lines.push(
      result.htmlArtifact
        ? `Showing the first ${displayRows.length} rows in the terminal preview. Open the HTML view for the full cached result.`
        : `Showing the first ${displayRows.length} rows in the terminal preview.`,
    );
  }

  lines.push(displayRows.length ? formatRecordsTable(displayRows, fields) : "(none)");

  if (result.htmlArtifact) {
    lines.push(`Open full table in a browser: ${result.htmlArtifact.fileUrl}`);
    lines.push(`HTML file: ${result.htmlArtifact.outputPath}`);
    lines.push(`Open the same cached rows as CSV: ${result.htmlArtifact.csvFileUrl}`);
    lines.push(`CSV file: ${result.htmlArtifact.csvOutputPath}`);
  }

  if (hasMoreRows) {
    const continuation = `render_last_result with offset=${offset + displayRows.length}`;
    if (result.htmlArtifact) {
      lines.push(`More cached rows are available. Open the HTML view for the full cached result or call ${continuation} to continue.`);
    } else {
      lines.push(`More cached rows are available. Call ${continuation} to continue.`);
    }
  } else if (result.rowsTruncated && result.rowCount > result.rows.length) {
    if (result.htmlArtifact) {
      lines.push(`The HTML file contains ${result.rows.length} cached rows, but the query returned ${result.rowCount} rows in total.`);
    } else {
      lines.push(`The in-memory cache contains ${result.rows.length} rows, but the query returned ${result.rowCount} rows in total.`);
    }
  }

  return {
    renderedText: lines.join("\n"),
    fields,
    rows: displayRows,
    hasMoreRows,
  };
}
