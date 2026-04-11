type TableRow = Record<string, unknown>;

const MAX_CELL_WIDTH = 36;

/**
 * Clip long cell values so formatted text tables stay readable in narrow terminals.
 */
function clipCell(value: string, maxWidth = MAX_CELL_WIDTH): string {
  if (value.length <= maxWidth) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxWidth - 3))}...`;
}

/**
 * Convert a table cell value into a compact string form.
 */
function formatCell(value: unknown): string {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return clipCell(value.replace(/\s+/g, " ").trim());
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return clipCell(value.map((item) => formatCell(item)).join(", "));
  }

  return clipCell(JSON.stringify(value));
}

/**
 * Pad one cell to a fixed width for monospace table rendering.
 */
function padCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

/**
 * Render a compact monospace table as plain text.
 */
export function formatRecordsTable(rows: TableRow[], columnOrder?: string[]): string {
  if (!rows.length) {
    return "(none)";
  }

  const columns = columnOrder?.length ? columnOrder : Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const widths = new Map<string, number>();

  for (const column of columns) {
    widths.set(column, column.length);
  }

  for (const row of rows) {
    for (const column of columns) {
      const cell = formatCell(row[column]);
      widths.set(column, Math.max(widths.get(column) ?? 0, cell.length));
    }
  }

  const header = columns.map((column) => padCell(column, widths.get(column) ?? column.length)).join(" | ");
  const separator = columns.map((column) => "-".repeat(widths.get(column) ?? column.length)).join("-+-");
  const body = rows.map((row) => columns.map((column) => padCell(formatCell(row[column]), widths.get(column) ?? column.length)).join(" | "));

  return [header, separator, ...body].join("\n");
}
