import type { LlmMessageParam, LlmToolCall } from "../llm/types.js";
import { executeTool, serializeToolResultForModel } from "../tools/registry.js";
import type { ToolRuntimeContext } from "../tools/specs.js";
import type { AgentIO, AppConfig } from "../types/index.js";
import { pushRecentSummary, type SessionContextMemory, upsertNamedSummary } from "./memory.js";

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

export interface AgentToolExecutionOptions {
  toolCall: LlmToolCall;
  runtime: ToolRuntimeContext;
  io: AgentIO;
  config: AppConfig;
  memory: SessionContextMemory;
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
    options.pushCurrentTurnMessage({
      role: "tool",
      tool_call_id: options.toolCall.id,
      content: serialized.content,
    });
    options.pushCurrentTurnSummary(serialized.summary);
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
