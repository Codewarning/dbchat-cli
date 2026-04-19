import { writeFile } from "node:fs/promises";
import { createWorkspaceTempArtifactPath, toFileUrl } from "../fs/temp-artifacts.js";
import type { QueryExecutionResult, QueryResultHtmlArtifact } from "../types/index.js";
import { exportQueryResult } from "../export/csv.js";
import { formatSqlDisplayScalar } from "./value-format.js";
import { HtmlTemplateRenderer } from "./html-template.js";
import { QUERY_RESULT_HTML_TEMPLATE } from "./query-result-html-template.js";

const templateRenderer = new HtmlTemplateRenderer(QUERY_RESULT_HTML_TEMPLATE);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCellValue(value: unknown): string {
  if (value == null) {
    return "";
  }

  const formattedScalar = formatSqlDisplayScalar(value);
  if (typeof formattedScalar === "string" || typeof formattedScalar === "number" || typeof formattedScalar === "boolean") {
    return String(formattedScalar);
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatCellValue(item)).join(", ");
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function buildMetaCard(label: string, value: string): string {
  return `<dl class="meta-card"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></dl>`;
}

function buildNoteBlock(result: QueryExecutionResult): string {
  if (!result.rowsTruncated || result.rowCount <= result.rows.length) {
    return "";
  }

  return `<p class="note">The query returned ${escapeHtml(String(result.rowCount))} rows, but the cached result and this HTML view contain the first ${escapeHtml(String(result.rows.length))} rows because of app.resultRowLimit.</p>`;
}

function buildTableRows(result: QueryExecutionResult, fields: string[]): string {
  if (!result.rows.length) {
    return `<tr><td class="empty" colspan="${Math.max(1, fields.length)}">No rows were returned.</td></tr>`;
  }

  return result.rows
    .map(
      (row) =>
        `<tr>${fields
          .map(
            (field) =>
              `<td><div class="cell-content" data-expandable-cell><div class="cell-content__inner" data-cell-inner>${escapeHtml(formatCellValue(row[field]))}</div><button class="cell-toggle" type="button" hidden aria-expanded="false">Expand</button></div></td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
}

/**
 * Write one HTML artifact for the cached query result and return its metadata.
 */
export async function writeQueryResultHtmlArtifact(result: QueryExecutionResult, cwd: string): Promise<QueryResultHtmlArtifact> {
  const fields = result.fields.length ? result.fields : (result.rows[0] ? Object.keys(result.rows[0]) : []);
  const outputPath = await createWorkspaceTempArtifactPath({
    prefix: "result",
    extension: ".html",
  });
  const generatedAt = new Date().toISOString();
  const csvExport = await exportQueryResult(result, "csv", undefined, cwd);
  const html = templateRenderer.render({
    pageTitle: escapeHtml(`dbchat result - ${result.operation}`),
    title: escapeHtml(`Cached ${result.operation} result`),
    summary: escapeHtml(`Rows cached: ${result.rows.length}. Columns: ${fields.length}. Generated at: ${generatedAt}.`),
    metaCards: [
      buildMetaCard("Operation", result.operation),
      buildMetaCard("Rows Returned", String(result.rowCount)),
      buildMetaCard("Rows Cached", String(result.rows.length)),
      buildMetaCard("Columns", String(fields.length)),
    ].join(""),
    noteBlock: buildNoteBlock(result),
    sqlText: escapeHtml(result.sql),
    tableHead: fields.map((field) => `<th>${escapeHtml(field)}</th>`).join(""),
    tableBody: buildTableRows(result, fields),
  });

  await writeFile(outputPath, html, "utf8");

  return {
    outputPath,
    fileUrl: toFileUrl(outputPath),
    csvOutputPath: csvExport.outputPath,
    csvFileUrl: csvExport.fileUrl,
    generatedAt,
    cachedRowCount: result.rows.length,
    rowCount: result.rowCount,
    fieldCount: fields.length,
  };
}

/**
 * Attach one HTML artifact to the cached query result only when cached data rows are present.
 */
export async function attachQueryResultHtmlArtifact(result: QueryExecutionResult, cwd: string): Promise<QueryExecutionResult> {
  if (result.htmlArtifact || !result.rows.length) {
    return result;
  }

  return {
    ...result,
    htmlArtifact: await writeQueryResultHtmlArtifact(result, cwd),
  };
}
