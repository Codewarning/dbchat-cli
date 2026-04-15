// Prompt builders keep the agent policy centralized and easy to reuse across turns.
import { formatAllowedOperationsForDatabaseOperationAccess, formatDatabaseOperationAccess } from "../db/operation-access.js";
import type { AppConfig, PlanItem, QueryExecutionResult } from "../types/index.js";
import { formatRecordsTable } from "../ui/text-table.js";
import { formatSqlDisplayScalar } from "../ui/value-format.js";
import type { NamedSummary, SessionContextMemory } from "./memory.js";
import { formatPlan } from "./plan.js";
import type { ContextPromptProfile } from "./session-policy.js";

const MAX_ARCHIVED_TURNS_IN_PROMPT = 4;
const MAX_ARCHIVED_TURN_CHARS = 1800;
const MAX_SCHEMA_MEMORY_CHARS = 1600;
const MAX_QUERY_MEMORY_CHARS = 1600;
const MAX_LAST_RESULT_PREVIEW_ROWS = 3;
const MAX_LAST_RESULT_FIELDS = 8;
const MAX_VALUE_CHARS = 80;

/**
 * Collapse repeated whitespace inside prompt snippets.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Clip long text before inserting it into prompt context.
 */
function clipText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Keep the newest lines that fit within a simple character budget.
 */
function takeTailByCharBudget(items: string[], maxChars: number): string[] {
  const selected: string[] = [];
  let usedChars = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const nextSize = item.length + (selected.length ? 1 : 0);
    if (selected.length && usedChars + nextSize > maxChars) {
      break;
    }

    if (!selected.length && item.length > maxChars) {
      selected.unshift(clipText(item, maxChars));
      break;
    }

    selected.unshift(item);
    usedChars += nextSize;
  }

  return selected;
}

/**
 * Convert nested result values into a compact prompt-friendly preview.
 */
function compactValue(value: unknown): unknown {
  if (value == null || typeof value === "boolean") {
    return value;
  }

  const formattedScalar = formatSqlDisplayScalar(value);
  if (typeof formattedScalar === "number" || typeof formattedScalar === "boolean") {
    return formattedScalar;
  }

  if (typeof formattedScalar === "string") {
    return clipText(formattedScalar, MAX_VALUE_CHARS);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => compactValue(item));
    if (value.length > items.length) {
      items.push(`... ${value.length - items.length} more items`);
    }
    return items;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const compacted = Object.fromEntries(entries.slice(0, 8).map(([key, entryValue]) => [key, compactValue(entryValue)]));
    if (entries.length > 8) {
      compacted.__truncatedFields = entries.length - 8;
    }
    return compacted;
  }

  return clipText(String(value), MAX_VALUE_CHARS);
}

/**
 * Build a compact plain-text table preview that the model can reuse in terminal output.
 */
function buildResultPreviewTable(result: QueryExecutionResult, previewLimit: number): string | null {
  const previewFields = result.fields.slice(0, MAX_LAST_RESULT_FIELDS);
  const previewRows = result.rows
    .slice(0, previewLimit)
    .map((row) => Object.fromEntries(previewFields.map((field) => [field, compactValue(row[field])])) as Record<string, unknown>);
  if (!previewRows.length) {
    return null;
  }

  return formatRecordsTable(previewRows, previewFields);
}

/**
 * Render named memory entries into prompt lines.
 */
function buildNamedSummaryLines(entries: NamedSummary[]): string[] {
  return entries.map((entry) => `${entry.key}: ${entry.summary}`);
}

/**
 * Assemble one optional prompt section from preformatted lines.
 */
function buildSessionMemorySection(title: string, lines: string[], maxChars: number): string | null {
  if (!lines.length) {
    return null;
  }

  const selectedLines = takeTailByCharBudget(lines, maxChars);
  if (!selectedLines.length) {
    return null;
  }

  return `${title}\n${selectedLines.join("\n")}`;
}

function buildCacheAvailabilitySection(memory: SessionContextMemory, lastResult: QueryExecutionResult | null): string | null {
  const hasLastResult = Boolean(lastResult);
  const hasLastExplain = Boolean(memory.lastExplainSummary);
  const hasSchemaMemory = Boolean(memory.lastSchemaSummary || memory.describedTables.length);
  const hasQueryMemory = Boolean(memory.recentQueries.length);
  const hasLastExport = Boolean(memory.lastExportSummary);

  if (!hasLastResult && !hasLastExplain && !hasSchemaMemory && !hasQueryMemory && !hasLastExport) {
    return null;
  }

  return [
    `Attached session caches: result=${hasLastResult ? "yes" : "no"}; explain=${hasLastExplain ? "yes" : "no"}; schema=${hasSchemaMemory ? "yes" : "no"}; query=${hasQueryMemory ? "yes" : "no"}; export=${hasLastExport ? "yes" : "no"}.`,
    "Use attached summaries first. Inspect result, explain, or history only when an omitted detail is required for the current request.",
  ].join("\n");
}

/**
 * Build the fixed system prompt that constrains the assistant's behavior.
 */
export function buildSystemPrompt(config: AppConfig): string {
  return [
    "You are a database CLI assistant running inside a terminal.",
    "Write all user-visible output in English plain CLI text.",
    "Interpret the user's intent from meaning, not just English wording. Apply the execution rules regardless of the user's language.",
    "Do not use Markdown code fences, headings, bullet lists, numbered lists, or emphasis markers in user-visible output.",
    "For query results, you may use plain monospace text tables when rows are available.",
    `Database dialect: ${config.database.dialect}.`,
    `Database access level: ${formatDatabaseOperationAccess(config.database.operationAccess)}.`,
    `Allowed SQL operations: ${formatAllowedOperationsForDatabaseOperationAccess(config.database.operationAccess)}.`,
    "Use tools for schema search, schema inspection, SQL execution, cached result inspection, cached result rendering, cached explain inspection, history inspection, planning, and export.",
    "Prefer the current prompt, attached summaries, and cached artifacts. Do not inspect archived history or persisted outputs unless the user refers to earlier work or an exact omitted detail is required. Do not repeatedly inspect the same history item without a new reason.",
    "Never invent table names or column names.",
    "On larger schemas, search the schema catalog before describing tables.",
    "For destructive schema operations that depend on the current table set, call list_live_tables instead of relying only on the schema catalog.",
    "If repeated schema searches still do not reveal the needed concept, stop searching and explicitly say the current schema likely does not contain it.",
    "For complex or multi-step work, keep update_plan accurate. Before the final answer, either mark remaining plan steps with terminal statuses or clear the plan. Do not call update_plan redundantly when nothing changed.",
    "Do not execute multi-statement SQL by default.",
    "SQL outside the current database access policy is blocked before execution and never reaches terminal approval.",
    "Allowed mutating or unclassified SQL still requires CLI approval through run_sql. Never ask the user for confirmation in assistant text.",
    "If run_sql is blocked by database access policy, say that clearly and do not tell the user to confirm in the terminal.",
    "Only provide SQL without executing it when the user explicitly asks for SQL only or says not to run it.",
    "If the user asks to query, list, count, show, display, find, get, or retrieve data, treat that as a request for actual results unless execution is explicitly forbidden.",
    "For follow-ups, prefer inspect_last_result, render_last_result, inspect_last_explain, or inspect_history_entry over rerunning work, but only when the missing detail matters to the current request.",
    "When the user wants visible SQL rows, call render_last_result and reuse its rendered table text instead of manually formatting rows yourself.",
    "Infer the user's requested visible row limit from the request or the SQL LIMIT when it is explicit. If the query returned no more than that requested visible limit, prefer one render_last_result call with that limit instead of splitting the output.",
    "render_last_result renders up to 100 rows per call. Only paginate with multiple render_last_result calls when the user needs more than 100 visible rows or when one response would otherwise become impractically large.",
    "If compressed conversation memory includes Turn ID or persistedOutputId markers, use inspect_history_entry only for the specific item you need.",
    "For table structure or DDL requests, prefer describe_table output. If ddlSource is reconstructed, do not claim it is the exact original DDL.",
    "When query results include date, datetime, timestamp, or time values, preserve them as readable strings instead of opaque objects.",
    "When query results include bigint, decimal, numeric, or scientific-notation values, preserve readable exact strings or expanded decimals instead of opaque objects or unnecessary exponent form.",
    "In the final answer, include what you did, the final SQL, whether it executed, a concise result summary, and any risk notes.",
    "If rows are available, prefer a compact plain-text table preview over prose alone.",
  ].join("\n");
}

/**
 * Build per-turn context from mutable runtime state such as the active plan and last query.
 */
export function buildContextPrompt(
  plan: PlanItem[],
  lastResult: QueryExecutionResult | null,
  memory: SessionContextMemory,
  profile: ContextPromptProfile,
): string {
  const parts: string[] = [];
  const cacheAvailabilitySection = buildCacheAvailabilitySection(memory, lastResult);
  if (cacheAvailabilitySection) {
    parts.push(cacheAvailabilitySection);
  }

  if (plan.length) {
    parts.push("Current plan:");
    parts.push(formatPlan(plan));
  }

  if (profile.includeArchivedConversation) {
    // Conversation memory is split into compressed history plus structured schema/query memory.
    const archivedTurnLines = [
      memory.rollingSummary ? `Older summary: ${memory.rollingSummary}` : "",
      ...takeTailByCharBudget(memory.archivedTurnSummaries, MAX_ARCHIVED_TURN_CHARS).slice(-MAX_ARCHIVED_TURNS_IN_PROMPT),
    ].filter(Boolean);
    const archivedSection = buildSessionMemorySection(
      "Compressed conversation memory:",
      [
        "Use this attached summary first. Inspect a specific Turn ID or persistedOutputId only when exact omitted detail is necessary.",
        ...archivedTurnLines,
      ],
      MAX_ARCHIVED_TURN_CHARS,
    );
    if (archivedSection) {
      parts.push(archivedSection);
    }
  }

  if (profile.includeLastSchemaSummary || profile.includeDescribedTables) {
    const schemaLines = [
      profile.includeLastSchemaSummary && memory.lastSchemaSummary ? `Last schema summary: ${memory.lastSchemaSummary}` : "",
      ...(profile.includeDescribedTables ? buildNamedSummaryLines(memory.describedTables) : []),
    ].filter(Boolean);
    const schemaSection = buildSessionMemorySection("Schema memory:", schemaLines, MAX_SCHEMA_MEMORY_CHARS);
    if (schemaSection) {
      parts.push(schemaSection);
    }
  }

  if (profile.includeRecentQueryMemory || profile.includeLastExplainSummary || profile.includeLastExportSummary) {
    const queryLines = [
      ...(profile.includeRecentQueryMemory ? memory.recentQueries : []),
      profile.includeLastExplainSummary && memory.lastExplainSummary ? `Last explain: ${memory.lastExplainSummary}` : "",
      profile.includeLastExportSummary && memory.lastExportSummary ? `Last export: ${memory.lastExportSummary}` : "",
    ].filter(Boolean);
    const querySection = buildSessionMemorySection("Recent query memory:", queryLines, MAX_QUERY_MEMORY_CHARS);
    if (querySection) {
      parts.push(querySection);
    }
  }

  if (lastResult && profile.includeLastResultSummary) {
    const previewFields = lastResult.fields.slice(0, MAX_LAST_RESULT_FIELDS);
    parts.push("Latest query result summary:");
    parts.push(
      JSON.stringify(
        {
          // Keep the latest result grounded with a very small row preview for follow-up turns.
          sql: clipText(lastResult.sql, 800),
          operation: lastResult.operation,
          rowCount: lastResult.rowCount,
          cachedRowCount: lastResult.rows.length,
          rowsTruncated: lastResult.rowsTruncated,
          fields: previewFields,
          omittedFieldCount: Math.max(0, lastResult.fields.length - previewFields.length),
          previewRows: lastResult.rows.slice(0, MAX_LAST_RESULT_PREVIEW_ROWS).map((row) =>
            Object.fromEntries(previewFields.map((field) => [field, compactValue(row[field])])),
          ),
        },
      ),
    );

    const previewTable = profile.includeLastResultTablePreview ? buildResultPreviewTable(lastResult, MAX_LAST_RESULT_PREVIEW_ROWS) : null;
    if (previewTable) {
      parts.push("Latest query result table preview:");
      parts.push(previewTable);
    }
  }

  return parts.join("\n\n");
}
