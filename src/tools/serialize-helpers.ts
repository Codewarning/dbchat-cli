import type {
  PlanItem,
  SchemaCatalogSearchResult,
  SchemaSummary,
  TableColumn,
} from "../types/index.js";
import { formatRecordsTable } from "../ui/text-table.js";

const MAX_TABLE_PREVIEW_CHARS = 1800;
const MAX_COLUMN_PREVIEW_CHARS = 1800;
const MAX_PLAN_PREVIEW_CHARS = 2200;

/**
 * Check whether a value is a plain object that can be compacted recursively.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collapse repeated whitespace so summaries consume fewer prompt tokens.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Clip long text to a bounded number of characters.
 */
export function clipText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Clip long text from the middle so both the prefix and suffix remain visible.
 */
export function clipMiddle(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  if (maxChars <= 3) {
    return "...".slice(0, maxChars);
  }

  const available = maxChars - 3;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${normalized.slice(0, head)}...${normalized.slice(-tail)}`;
}

/**
 * Serialize a value without pretty-print whitespace to minimize model-visible payload size.
 */
export function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

/**
 * Keep only as many items as fit within a simple character budget.
 */
export function takeItemsByCharBudget(items: string[], maxChars: number): { items: string[]; omittedCount: number } {
  const selected: string[] = [];
  let usedChars = 0;

  for (const item of items) {
    const nextSize = item.length + (selected.length ? 2 : 0);
    if (selected.length && usedChars + nextSize > maxChars) {
      break;
    }

    if (!selected.length && item.length > maxChars) {
      selected.push(clipText(item, maxChars));
      usedChars = selected[0].length;
      break;
    }

    selected.push(item);
    usedChars += nextSize;
  }

  return {
    items: selected,
    omittedCount: Math.max(0, items.length - selected.length),
  };
}

/**
 * Recursively shrink nested values into a smaller prompt-friendly representation.
 */
export function compactValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return clipText(value, 120);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => compactValue(item, depth + 1));
    if (value.length > items.length) {
      items.push(`... ${value.length - items.length} more items`);
    }
    return items;
  }

  if (isRecord(value)) {
    if (depth >= 2) {
      return clipText(stringifyCompact(value), 180);
    }

    const entries = Object.entries(value);
    const compacted = Object.fromEntries(entries.slice(0, 8).map(([key, entryValue]) => [key, compactValue(entryValue, depth + 1)]));
    if (entries.length > 8) {
      compacted.__truncatedFields = entries.length - 8;
    }
    return compacted;
  }

  return clipText(String(value), 120);
}

/**
 * Compact only the preview rows that will be shown to the model.
 */
export function compactRows(rows: Record<string, unknown>[], previewLimit: number): Record<string, unknown>[] {
  return rows.slice(0, previewLimit).map((row) => compactValue(row) as Record<string, unknown>);
}

/**
 * Render a plain-text table preview for row-oriented query results.
 */
export function buildPreviewTable(rows: Record<string, unknown>[], fields: string[]): string | undefined {
  if (!rows.length) {
    return undefined;
  }

  return formatRecordsTable(rows, fields);
}

/**
 * Collapse plan items into one short memory line.
 */
export function summarizePlanItems(items: PlanItem[]): string {
  return items.map((item) => `${item.id}:${item.status}:${clipText(item.content, 80)}`).join("; ");
}

/**
 * Build a bounded table preview for schema summary payloads.
 */
export function summarizeTables(summary: SchemaSummary): { items: string[]; omittedCount: number } {
  return takeItemsByCharBudget(
    summary.tables.map((table) => (typeof table.rowCount === "number" ? `${table.tableName}(${table.rowCount})` : table.tableName)),
    MAX_TABLE_PREVIEW_CHARS,
  );
}

/**
 * Build a bounded column preview for describe-table payloads.
 */
export function summarizeColumns(columns: TableColumn[]): { items: string[]; omittedCount: number } {
  return takeItemsByCharBudget(
    columns.map((column) => {
      const nullability = column.isNullable ? "nullable" : "not null";
      const defaultValue = column.defaultValue ? ` default=${clipText(String(column.defaultValue), 40)}` : "";
      return `${column.name} ${column.dataType} ${nullability}${defaultValue}`;
    }),
    MAX_COLUMN_PREVIEW_CHARS,
  );
}

/**
 * Build a bounded match preview for schema-catalog searches.
 */
export function summarizeCatalogMatches(result: SchemaCatalogSearchResult): { items: string[]; omittedCount: number } {
  return takeItemsByCharBudget(
    result.matches.map((match) => {
      const matchedColumns = match.matchedColumns.length ? ` columns=${match.matchedColumns.join("|")}` : "";
      const tags = match.tags.length ? ` tags=${match.tags.slice(0, 3).join("|")}` : "";
      return `${match.tableName}${matchedColumns}${tags}`;
    }),
    MAX_TABLE_PREVIEW_CHARS,
  );
}

/**
 * Produce a clipped string preview of an execution plan.
 */
export function buildPlanPreview(rawPlan: unknown): string {
  const serialized = typeof rawPlan === "string" ? rawPlan : stringifyCompact(rawPlan);
  return clipMiddle(serialized, MAX_PLAN_PREVIEW_CHARS);
}
