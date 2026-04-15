import type { LlmMessageParam, LlmToolCall } from "../llm/types.js";

/**
 * One user turn plus the raw messages and summary lines collected during execution.
 */
export interface ConversationTurn {
  id: string;
  messages: LlmMessageParam[];
  summaryLines: string[];
}

/**
 * One large tool payload kept out of active prompt history but still available for later inspection.
 */
export interface PersistedToolOutput {
  id: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  content: string;
}

/**
 * A keyed summary entry reused for schema and other named memory items.
 */
export interface NamedSummary {
  key: string;
  summary: string;
}

/**
 * Long-lived compressed session state that survives raw-history trimming.
 */
export interface SessionContextMemory {
  rollingSummary: string;
  archivedTurnSummaries: string[];
  lastSchemaSummary: string | null;
  describedTables: NamedSummary[];
  recentQueries: string[];
  lastExplainSummary: string | null;
  lastExportSummary: string | null;
}

export const MAX_ARCHIVED_TURN_SUMMARIES = 6;

const MAX_ROLLING_SUMMARY_CHARS = 2400;
const MAX_TURN_SUMMARY_CHARS = 480;
const MAX_MEMORY_ENTRY_CHARS = 320;
const MAX_ARCHIVED_DETAIL_LINES = 4;

/**
 * Collapse repeated whitespace to reduce prompt noise.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Clip a string to a bounded number of characters.
 */
export function clipText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Clip a string from the middle so both its prefix and suffix remain visible.
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
 * Start a new conversation turn seeded with the user's raw request.
 */
export function createConversationTurn(input: string, turnId = "turn-0"): ConversationTurn {
  return {
    id: turnId,
    messages: [
      {
        role: "user",
        content: input,
      },
    ],
    summaryLines: [`Turn ID: ${turnId}`, `User request: ${clipText(input, 240)}`],
  };
}

/**
 * Create an empty compressed session memory object.
 */
export function createSessionContextMemory(): SessionContextMemory {
  return {
    rollingSummary: "",
    archivedTurnSummaries: [],
    lastSchemaSummary: null,
    describedTables: [],
    recentQueries: [],
    lastExplainSummary: null,
    lastExportSummary: null,
  };
}

/**
 * Append one bounded summary line to the current turn.
 */
export function appendSummaryLine(turn: ConversationTurn, line: string): void {
  const normalized = clipText(line, MAX_MEMORY_ENTRY_CHARS);
  if (normalized) {
    turn.summaryLines.push(normalized);
  }
}

/**
 * Summarize one tool invocation for turn-level memory.
 */
export function summarizeToolCall(toolCall: LlmToolCall): string {
  const args = clipMiddle(toolCall.function.arguments ?? "{}", 180);
  return `Tool call: ${toolCall.function.name} ${args}`;
}

function takeTailEntriesByCharBudget(items: string[], maxChars: number): string[] {
  const selected: string[] = [];
  let usedChars = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const nextSize = item.length + (selected.length ? 2 : 0);
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

function pushUniqueLine(lines: string[], line: string | undefined): void {
  if (!line || lines.includes(line)) {
    return;
  }

  lines.push(line);
}

function buildCondensedTurnSummaryLines(lines: string[]): string[] {
  const normalizedLines = lines.map((line) => line.trim()).filter(Boolean);
  const turnIdLine = normalizedLines.find((line) => line.startsWith("Turn ID:"));
  const userRequest = normalizedLines.find((line) => line.startsWith("User request:"));
  const finalAnswer = [...normalizedLines].reverse().find((line) => line.startsWith("Final answer:"));
  const toolCallCount = normalizedLines.filter((line) => line.startsWith("Tool call:")).length;
  const persistedToolOutputLines = normalizedLines.filter((line) => line.startsWith("Persisted tool output:"));
  const detailedOutcomeLines = normalizedLines.filter(
    (line) =>
      !line.startsWith("Turn ID:") &&
      !line.startsWith("User request:") &&
      !line.startsWith("Final answer:") &&
      !line.startsWith("Tool call:") &&
      !line.startsWith("Request intent:"),
  );
  const selectedLines: string[] = [];

  pushUniqueLine(selectedLines, turnIdLine);
  pushUniqueLine(selectedLines, userRequest);
  for (const line of persistedToolOutputLines) {
    pushUniqueLine(selectedLines, line);
  }
  for (const line of detailedOutcomeLines.slice(-MAX_ARCHIVED_DETAIL_LINES)) {
    pushUniqueLine(selectedLines, line);
  }

  if (!detailedOutcomeLines.length) {
    for (const line of normalizedLines.slice(-2)) {
      pushUniqueLine(selectedLines, line);
    }
  }

  if (toolCallCount > 0) {
    pushUniqueLine(selectedLines, `Tool steps executed: ${toolCallCount}.`);
  }
  pushUniqueLine(selectedLines, finalAnswer);
  return selectedLines;
}

/**
 * Collapse one completed turn into a single archived summary string.
 */
export function buildArchivedTurnSummary(turn: ConversationTurn): string {
  return clipText(buildCondensedTurnSummaryLines(turn.summaryLines).join("\n"), MAX_TURN_SUMMARY_CHARS);
}

/**
 * Merge older archived summaries into the rolling summary window.
 */
export function mergeRollingSummary(existing: string, additions: string[]): string {
  const mergedEntries = [...existing.split(/\n{2,}/), ...additions]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selectedEntries = takeTailEntriesByCharBudget(mergedEntries, MAX_ROLLING_SUMMARY_CHARS - 31);
  const merged = selectedEntries.join("\n\n");

  if (mergedEntries.length === selectedEntries.length && merged.length <= MAX_ROLLING_SUMMARY_CHARS) {
    return merged;
  }

  return `Older context was truncated.\n${merged}`;
}

/**
 * Replace or append one keyed summary while preserving only the newest entries.
 */
export function upsertNamedSummary(entries: NamedSummary[], key: string, summary: string, limit: number): void {
  const normalized = clipText(summary, MAX_MEMORY_ENTRY_CHARS);
  const existingIndex = entries.findIndex((entry) => entry.key === key);
  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1);
  }

  entries.push({
    key,
    summary: normalized,
  });

  if (entries.length > limit) {
    entries.splice(0, entries.length - limit);
  }
}

/**
 * Push one summary entry into a fixed-size recent-memory list.
 */
export function pushRecentSummary(entries: string[], summary: string, limit: number): void {
  entries.push(clipText(summary, MAX_MEMORY_ENTRY_CHARS));
  if (entries.length > limit) {
    entries.splice(0, entries.length - limit);
  }
}

/**
 * Estimate how much prompt space one normalized message will consume.
 */
function estimateMessageSize(message: LlmMessageParam): number {
  switch (message.role) {
    case "system":
    case "user":
      return message.content.length;

    case "assistant":
      return (
        (message.content?.length ?? 0) +
        (message.tool_calls ?? []).reduce(
          (total, toolCall) => total + toolCall.id.length + toolCall.function.name.length + toolCall.function.arguments.length + 16,
          0,
        )
      );

    case "tool":
      return message.tool_call_id.length + message.content.length + (message.is_error ? 8 : 0);
  }
}

/**
 * Estimate the total prompt size of one turn by summing message sizes.
 */
export function estimateTurnSize(turn: ConversationTurn): number {
  return turn.messages.reduce((total, message) => total + estimateMessageSize(message), 0);
}
