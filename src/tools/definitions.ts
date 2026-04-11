import type { LlmToolDefinition } from "../llm/types.js";
import { BUILTIN_TOOL_SPECS } from "./builtins/index.js";

/**
 * Return the static tool list exposed to the LLM for one session.
 */
export function buildToolDefinitions(): LlmToolDefinition[] {
  return BUILTIN_TOOL_SPECS.map((spec) => spec.definition);
}
