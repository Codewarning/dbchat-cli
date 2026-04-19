// Result export helpers keep file-format concerns out of the tool registry.
import { writeFile } from "node:fs/promises";
import { createWorkspaceTempArtifactPath, toFileUrl } from "../fs/temp-artifacts.js";
import type { ExportResult, QueryExecutionResult } from "../types/index.js";

/**
 * Escape one CSV cell according to RFC-style quoting rules.
 */
function escapeCsvValue(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, "\"\"")}"`;
}

/**
 * Create one export file path under the app temp directory.
 */
export async function resolveTemporaryOutputPathForExport(
  format: "json" | "csv",
  outputPath?: string,
): Promise<string> {
  return createWorkspaceTempArtifactPath({
    prefix: `export-${format}`,
    extension: format === "json" ? ".json" : ".csv",
    suggestedName: outputPath,
  });
}

/**
 * Write the current query result to JSON or CSV and return export metadata.
 */
export async function exportQueryResult(
  result: QueryExecutionResult,
  format: "json" | "csv",
  outputPath: string | undefined,
  _cwd: string,
): Promise<ExportResult> {
  const resolvedPath = await resolveTemporaryOutputPathForExport(format, outputPath);

  if (format === "json") {
    // JSON exports preserve the raw row objects for downstream tooling.
    await writeFile(resolvedPath, `${JSON.stringify(result.rows, null, 2)}\n`, "utf8");
  } else {
    // Preserve field order from the executed query when possible for predictable CSV columns.
    const header = result.fields.length ? result.fields : result.rows[0] ? Object.keys(result.rows[0]) : [];
    const lines = [
      header.map((field) => escapeCsvValue(field)).join(","),
      ...result.rows.map((row) => header.map((field) => escapeCsvValue(row[field])).join(",")),
    ];
    await writeFile(resolvedPath, `${lines.join("\n")}\n`, "utf8");
  }

  return {
    format,
    outputPath: resolvedPath,
    fileUrl: toFileUrl(resolvedPath),
    rowCount: result.rows.length,
    truncated: result.rowsTruncated,
  };
}
