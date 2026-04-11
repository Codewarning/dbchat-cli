import type { AppRuntimeConfig } from "../types/index.js";
import { BUILTIN_TOOL_SPECS } from "./builtins/index.js";
import type { SerializedToolResult, ToolRuntimeContext } from "./specs.js";

const TOOL_SPECS_BY_NAME = new Map(BUILTIN_TOOL_SPECS.map((spec) => [spec.definition.function.name, spec]));

/**
 * Validate and execute one tool call while enforcing runtime safety invariants.
 */
export async function executeTool(name: string, rawArgs: unknown, context: ToolRuntimeContext): Promise<unknown> {
  const spec = TOOL_SPECS_BY_NAME.get(name);
  if (!spec) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return spec.execute(rawArgs, context);
}

/**
 * Convert one raw tool result into the bounded payload the model should see.
 */
export function serializeToolResultForModel(name: string, result: unknown, appConfig: AppRuntimeConfig): SerializedToolResult {
  const spec = TOOL_SPECS_BY_NAME.get(name);
  if (!spec) {
    return {
      content: JSON.stringify(result),
      summary: `${name} completed.`,
    };
  }

  return spec.serialize(result, appConfig);
}
