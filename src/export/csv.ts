// Result export helpers keep file-format concerns out of the tool registry.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
 * Resolve an export path and reject targets that escape the active working directory.
 */
function resolveOutputPath(cwd: string, outputPath: string): string {
  const resolved = path.isAbsolute(outputPath) ? outputPath : path.resolve(cwd, outputPath);
  const normalizedCwd = path.resolve(cwd);
  const relativePath = path.relative(normalizedCwd, resolved);

  // Exports are intentionally sandboxed to the current working directory.
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The export path must stay within the current working directory.");
  }

  return resolved;
}

/**
 * Write the current query result to JSON or CSV and return export metadata.
 */
export async function exportQueryResult(
  result: QueryExecutionResult,
  format: "json" | "csv",
  outputPath: string,
  cwd: string,
): Promise<ExportResult> {
  const resolvedPath = resolveOutputPath(cwd, outputPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });

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
    rowCount: result.rows.length,
    truncated: result.rowsTruncated,
  };
}
