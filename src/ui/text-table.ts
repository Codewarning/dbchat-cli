import { formatSqlDisplayScalar } from "./value-format.js";

type TableRow = Record<string, unknown>;

export interface FixedWidthTableModel {
  columnWidths: number[];
  headerCells: string[];
  rows: string[][];
  separatorLine: string;
}

interface TableRenderOptions {
  cellWidth?: number;
}

const DEFAULT_MAX_CELL_WIDTH = 36;
const MIN_CELL_WIDTH = 4;
const DEFAULT_COMPACT_COLUMN_LIMIT = 8;
const DEFAULT_COMPACT_TAIL_COLUMNS = 3;

/**
 * Normalize one requested maximum column width into a stable positive integer.
 */
function resolveCellWidth(width: number | undefined): number {
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
    return DEFAULT_MAX_CELL_WIDTH;
  }

  return Math.max(MIN_CELL_WIDTH, Math.floor(width));
}

/**
 * Approximate whether one code point occupies two terminal columns.
 *
 * Based on the common East Asian full-width ranges used by wcwidth-style libraries.
 */
function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
      (codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
      (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1aff0 && codePoint <= 0x1aff3) ||
      (codePoint >= 0x1aff5 && codePoint <= 0x1affb) ||
      (codePoint >= 0x1affd && codePoint <= 0x1affe) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b122) ||
      (codePoint >= 0x1b132 && codePoint <= 0x1b150) ||
      codePoint === 0x1b155 ||
      (codePoint >= 0x1b164 && codePoint <= 0x1b167) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f2ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

/**
 * Estimate how many monospace terminal columns one string occupies.
 */
function getDisplayWidth(value: string): number {
  let width = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }

  return width;
}

/**
 * Clip long cell values so formatted text tables stay readable in narrow terminals.
 */
function clipCell(value: string, maxWidth: number): string {
  if (getDisplayWidth(value) <= maxWidth) {
    return value;
  }

  if (maxWidth <= 1) {
    return "…".slice(0, maxWidth);
  }

  const suffix = "…";
  const availableWidth = Math.max(0, maxWidth - getDisplayWidth(suffix));
  let clipped = "";
  let clippedWidth = 0;

  for (const character of value) {
    const characterWidth = getDisplayWidth(character);
    if (clippedWidth + characterWidth > availableWidth) {
      break;
    }

    clipped += character;
    clippedWidth += characterWidth;
  }

  return `${clipped}${suffix}`;
}

/**
 * Convert one runtime cell value into a compact string form before width calculation.
 */
function formatCellValue(value: unknown): string {
  if (value == null) {
    return "";
  }

  const formattedScalar = formatSqlDisplayScalar(value);
  if (typeof formattedScalar === "string") {
    return formattedScalar.replace(/\s+/g, " ").trim();
  }

  if (typeof formattedScalar === "number" || typeof formattedScalar === "boolean") {
    return String(formattedScalar);
  }

  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatCellValue(item)).join(", ");
  }

  return JSON.stringify(value);
}

/**
 * Pad one cell to a fixed width for monospace table rendering.
 */
function padCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - getDisplayWidth(value)))}`;
}

/**
 * Drop line-ending whitespace because the last padded cell does not need visible trailing spaces.
 */
function trimLineEndings(value: string): string {
  return value.replace(/[ \t]+$/gm, "").trimEnd();
}

/**
 * Convert one row of padded cell text into the shared plain-text table format.
 */
function renderTableRow(cells: string[]): string {
  return cells.join(" | ");
}

/**
 * Build a fixed-width-per-column table model that plain-text and Ink renderers can both reuse.
 */
export function buildFixedWidthTableModel(
  rows: TableRow[],
  columnOrder?: string[],
  options?: TableRenderOptions,
): FixedWidthTableModel {
  const maxCellWidth = resolveCellWidth(options?.cellWidth);
  const columns = columnOrder?.length ? columnOrder : Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const rawHeaderCells = columns.map((column) => column.trim());
  const rawBodyRows = rows.map((row) => columns.map((column) => formatCellValue(row[column])));
  const columnWidths = columns.map((_, index) => {
    const widestContentWidth = Math.max(
      getDisplayWidth(rawHeaderCells[index] ?? ""),
      ...rawBodyRows.map((row) => getDisplayWidth(row[index] ?? "")),
    );
    return Math.max(MIN_CELL_WIDTH, Math.min(maxCellWidth, widestContentWidth));
  });
  const headerCells = rawHeaderCells.map((column, index) => {
    const width = columnWidths[index] ?? maxCellWidth;
    return padCell(clipCell(column, width), width);
  });
  const bodyRows = rawBodyRows.map((row) =>
    row.map((cell, index) => {
      const width = columnWidths[index] ?? maxCellWidth;
      return padCell(clipCell(cell, width), width);
    }),
  );

  return {
    columnWidths,
    headerCells,
    rows: bodyRows,
    separatorLine: columnWidths.map((width) => "-".repeat(width)).join("-+-"),
  };
}

/**
 * Render one fixed-width table model into plain CLI text.
 */
export function renderFixedWidthTable(model: FixedWidthTableModel): string {
  return trimLineEndings(
    [renderTableRow(model.headerCells), model.separatorLine, ...model.rows.map((row) => renderTableRow(row))].join("\n"),
  );
}

export function selectCompactColumnOrder(
  columnOrder: string[],
  maxColumns = DEFAULT_COMPACT_COLUMN_LIMIT,
): {
  columns: string[];
  omittedColumnCount: number;
} {
  if (columnOrder.length <= maxColumns) {
    return {
      columns: [...columnOrder],
      omittedColumnCount: 0,
    };
  }

  const normalizedMaxColumns = Math.max(2, Math.floor(maxColumns));
  const tailCount = Math.min(DEFAULT_COMPACT_TAIL_COLUMNS, normalizedMaxColumns - 1);
  const headCount = Math.max(1, normalizedMaxColumns - tailCount);
  const selectedColumns = Array.from(new Set([...columnOrder.slice(0, headCount), ...columnOrder.slice(-tailCount)]));

  return {
    columns: selectedColumns,
    omittedColumnCount: Math.max(0, columnOrder.length - selectedColumns.length),
  };
}

/**
 * Render a compact monospace table as plain text.
 */
export function formatRecordsTable(rows: TableRow[], columnOrder?: string[], options?: TableRenderOptions): string {
  if (!rows.length) {
    return "(none)";
  }

  return renderFixedWidthTable(buildFixedWidthTableModel(rows, columnOrder, options));
}
