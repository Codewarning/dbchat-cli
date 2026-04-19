import type { LlmMessageParam, LlmToolCall } from "../llm/types.js";
import { executeTool, serializeToolResultForModel } from "../tools/registry.js";
import type { ToolRuntimeContext } from "../tools/specs.js";
import type { AgentIO, AppConfig } from "../types/index.js";
import { pushRecentSummary, type PersistedToolOutput, type SessionContextMemory, upsertNamedSummary } from "./memory.js";

const MAX_DESCRIBED_TABLE_MEMORY = 4;
const MAX_RECENT_QUERY_MEMORY = 4;

function safeParseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rememberToolSummary(memory: SessionContextMemory, toolName: string, result: unknown, summary: string): void {
  switch (toolName) {
    case "get_schema_summary":
    case "list_live_tables":
      memory.lastSchemaSummary = summary;
      break;

    case "describe_table": {
      const tableName = typeof (result as { tableName?: unknown })?.tableName === "string" ? (result as { tableName: string }).tableName : "unknown";
      upsertNamedSummary(memory.describedTables, tableName, summary, MAX_DESCRIBED_TABLE_MEMORY);
      break;
    }

    case "run_sql":
      pushRecentSummary(memory.recentQueries, summary, MAX_RECENT_QUERY_MEMORY);
      break;

    case "explain_sql":
      memory.lastExplainSummary = summary;
      break;

    case "export_last_result":
      memory.lastExportSummary = summary;
      break;
  }
}

function clipStructuredText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 3) {
    return "...".slice(0, maxChars);
  }

  return `${value.slice(0, maxChars - 3)}...`;
}

function shouldAlwaysInlineToolResult(toolName: string): boolean {
  return toolName === "render_last_result" || toolName === "inspect_last_result";
}

function buildModelVisibleToolContent(options: {
  serialized: { content: string; summary: string };
  toolCall: LlmToolCall;
  config: AppConfig;
  turnId: string;
  persistToolOutput(entry: { toolCallId: string; toolName: string; summary: string; content: string }): PersistedToolOutput;
}): { content: string; persistedOutput: PersistedToolOutput | null } {
  if (shouldAlwaysInlineToolResult(options.toolCall.function.name)) {
    return {
      content: options.serialized.content,
      persistedOutput: null,
    };
  }

  const threshold = options.config.app.contextCompression.largeToolOutputChars;
  if (options.serialized.content.length <= threshold) {
    return {
      content: options.serialized.content,
      persistedOutput: null,
    };
  }

  const persistedOutput = options.persistToolOutput({
    toolCallId: options.toolCall.id,
    toolName: options.toolCall.function.name,
    summary: options.serialized.summary,
    content: options.serialized.content,
  });
  const preview = clipStructuredText(
    options.serialized.content,
    Math.min(options.config.app.contextCompression.persistedToolPreviewChars, threshold),
  );

  return {
    content: JSON.stringify({
      persistedOutputId: persistedOutput.id,
      turnId: options.turnId,
      toolName: options.toolCall.function.name,
      summary: options.serialized.summary,
      fullContentChars: options.serialized.content.length,
      note: `Full tool output was omitted from active conversation context because it exceeded ${threshold} characters.`,
      preview,
      previewTruncated: preview.length < options.serialized.content.length,
    }),
    persistedOutput,
  };
}

export interface AgentToolExecutionOptions {
  toolCall: LlmToolCall;
  runtime: ToolRuntimeContext;
  io: AgentIO;
  config: AppConfig;
  memory: SessionContextMemory;
  currentTurnId: string;
  persistToolOutput(entry: { toolCallId: string; toolName: string; summary: string; content: string }): PersistedToolOutput;
  pushCurrentTurnMessage(message: LlmMessageParam): void;
  pushCurrentTurnSummary(line: string): void;
}

/**
 * Execute one tool call and fold both raw tool output and structured tool memory back into the current turn.
 */
export async function executeAgentToolCall(options: AgentToolExecutionOptions): Promise<string | null> {
  const args = safeParseToolArguments(options.toolCall.function.arguments ?? "{}");
  options.io.log(`Tool call: ${options.toolCall.function.name}`);
  try {
    const result = await executeTool(options.toolCall.function.name, args, options.runtime);
    const serialized = serializeToolResultForModel(options.toolCall.function.name, result, options.config.app);
    const modelVisible = buildModelVisibleToolContent({
      serialized,
      toolCall: options.toolCall,
      config: options.config,
      turnId: options.currentTurnId,
      persistToolOutput: options.persistToolOutput,
    });
    options.pushCurrentTurnMessage({
      role: "tool",
      tool_call_id: options.toolCall.id,
      content: modelVisible.content,
    });
    options.pushCurrentTurnSummary(serialized.summary);
    if (modelVisible.persistedOutput) {
      options.io.log(`Persisted large tool output: ${modelVisible.persistedOutput.id}`);
      options.pushCurrentTurnSummary(
        `Persisted tool output: ${modelVisible.persistedOutput.id} from ${modelVisible.persistedOutput.toolName} (${modelVisible.persistedOutput.content.length} chars).`,
      );
    }
    rememberToolSummary(options.memory, options.toolCall.function.name, result, serialized.summary);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.io.log(`Tool failed: ${message}`);
    options.pushCurrentTurnMessage({
      role: "tool",
      tool_call_id: options.toolCall.id,
      content: JSON.stringify({ error: message }),
      is_error: true,
    });
    if (options.toolCall.function.name === "describe_table") {
      options.pushCurrentTurnMessage({
        role: "system",
        content: "describe_table must use an exact table name from the current schema catalog. Do not invent or rewrite table names. Reuse a table name returned by search_schema_catalog exactly.",
      });
    }
    options.pushCurrentTurnSummary(`Tool failed: ${options.toolCall.function.name} ${message}`);
    return message;
  }
}
