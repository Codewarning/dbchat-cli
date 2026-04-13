// Prompt builders keep the agent policy centralized and easy to reuse across turns.
import { formatAllowedOperationsForDatabaseOperationAccess, formatDatabaseOperationAccess } from "../db/operation-access.js";
import type { AppConfig, PlanItem, QueryExecutionResult } from "../types/index.js";
import { formatRecordsTable } from "../ui/text-table.js";
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
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return clipText(value, MAX_VALUE_CHARS);
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
    "Session cache availability:",
    `- last query result cached: ${hasLastResult ? "yes" : "no"}`,
    `- last explain cached: ${hasLastExplain ? "yes" : "no"}`,
    `- schema memory cached: ${hasSchemaMemory ? "yes" : "no"}`,
    `- recent query memory cached: ${hasQueryMemory ? "yes" : "no"}`,
    `- last export cached: ${hasLastExport ? "yes" : "no"}`,
    "If the user refers to previous work, inspect the relevant cache with tools instead of assuming the details.",
  ].join("\n");
}

/**
 * Build the fixed system prompt that constrains the assistant's behavior.
 */
export function buildSystemPrompt(config: AppConfig): string {
  return [
    "You are a database CLI assistant running inside a terminal.",
    "All user-visible responses must be written in English.",
    "Return plain CLI text only.",
    "Interpret the user's intent from meaning, not just English wording. Apply the execution rules regardless of the user's language.",
    "Do not use Markdown code fences, headings, bullet lists, numbered lists, or emphasis markers.",
    "For query results, you may use plain monospace text tables when rows are available.",
    `Current database dialect: ${config.database.dialect}.`,
    `Current database operation access: ${formatDatabaseOperationAccess(config.database.operationAccess)}.`,
    `Allowed SQL operations for this database: ${formatAllowedOperationsForDatabaseOperationAccess(config.database.operationAccess)}.`,
    "Use tools to search the local schema catalog, inspect schema, execute SQL, inspect cached query results, inspect cached explain output, analyze results, explain SQL, and export data.",
    "Rules:",
    "1. Never invent table names or column names. Inspect schema first when needed.",
    "1a. On large databases, search the schema catalog before describing tables. Use describe_table only after you have likely candidates.",
    "1b. Before destructive schema operations that depend on the current table set, such as dropping or truncating all tables, call list_live_tables instead of relying only on the local schema catalog.",
    "1c. If repeated schema searches do not reveal tables for one part of the request, stop searching and explicitly say that the current schema likely does not contain that concept.",
    "2. For complex or multi-step work, call update_plan before execution and keep the plan updated when step status changes materially. Use terminal statuses such as completed, skipped, or cancelled when a step will not continue.",
    "3. SQL that is outside the current database operation access policy is blocked before execution and no terminal approval prompt will appear.",
    "3a. Only mutating or unclassified SQL that is allowed by the current database operation access policy can reach the terminal confirmation gate. You must still explain risk clearly.",
    "4. Do not execute multi-statement SQL by default.",
    "5. Your final answer should include what you did, the final SQL, whether it was executed, a result summary, and risk notes.",
    "5a. If a query returns rows, prefer showing a compact plain-text table preview instead of only prose summaries.",
    "5b. If you need more rows or columns from the latest cached query result, call inspect_last_result instead of rerunning the same SQL unless the user explicitly needs fresh data.",
    "5c. If you need more details from the latest EXPLAIN output, call inspect_last_explain instead of rerunning EXPLAIN unless the SQL itself changed.",
    "5d. Session caches may be available even when prior raw conversation turns are not attached. If the user refers to earlier work, inspect the relevant cache with tools.",
    "6. Only provide SQL without executing it when the user explicitly asks for SQL only, a query statement, or says not to run it.",
    "6a. If the user asks to query, list, count, show, display, or retrieve data, treat that as a request for actual results unless they explicitly forbid execution.",
    "6b. If the user asks for a table structure, table definition, schema definition, or DDL, prefer showing the CREATE TABLE style DDL from describe_table instead of paraphrasing the columns.",
    "6c. If describe_table reports ddlSource as reconstructed, do not claim it is the exact original DDL from the database.",
    "6d. After search_schema_catalog returns candidate tables, copy table names exactly from the tool results. Do not invent or rewrite table names.",
    "7. Do not ask the user for confirmation in the assistant text. If execution is needed, call run_sql and let the CLI confirmation gate handle approval when applicable.",
    "8. If run_sql returns a cancellation caused by database access policy, explicitly state that execution was blocked by the current database access level. Do not tell the user to confirm in the terminal in that case.",
    "9. Do not output phrases like 'please confirm', 'whether to execute', or similar confirmation prompts in the final answer.",
    "10. Before returning a final answer, if an active plan exists, call update_plan to either mark the remaining steps with terminal statuses or clear the plan with an empty items array when it is no longer needed.",
    "11. Do not call update_plan redundantly. If the plan content is unchanged, continue with the next tool or return the final answer.",
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
    const archivedSection = buildSessionMemorySection("Compressed conversation memory:", archivedTurnLines, MAX_ARCHIVED_TURN_CHARS);
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
