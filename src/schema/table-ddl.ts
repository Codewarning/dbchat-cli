import type { TableColumn } from "../types/index.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildColumnDdl(column: TableColumn): string {
  const parts = [column.name, normalizeWhitespace(column.dataType)];
  parts.push(column.isNullable ? "NULL" : "NOT NULL");
  if (column.defaultValue != null && String(column.defaultValue).trim()) {
    parts.push(`DEFAULT ${normalizeWhitespace(String(column.defaultValue))}`);
  }

  return parts.join(" ");
}

export function buildCreateTableDdl(tableName: string, columns: TableColumn[], constraintLines: string[] = []): string {
  const bodyLines = [
    ...columns.map((column) => `  ${buildColumnDdl(column)}`),
    ...constraintLines.map((line) => `  ${normalizeWhitespace(line)}`),
  ];

  return [`CREATE TABLE ${tableName} (`, bodyLines.join(",\n"), ");"].join("\n");
}
