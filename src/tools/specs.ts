import { z } from "zod";
import type { DatabaseAdapter } from "../db/adapter.js";
import type { LlmToolDefinition } from "../llm/types.js";
import type {
  AgentIO,
  AppConfig,
  AppRuntimeConfig,
  MutationApprovalState,
  PlanItem,
  QueryPlanResult,
  QueryExecutionResult,
  SchemaCatalog,
} from "../types/index.js";

/**
 * Compact model-visible tool payload plus a human-readable summary line for memory.
 */
export interface SerializedToolResult {
  content: string;
  summary: string;
}

/**
 * Runtime dependencies and mutable state shared across tool executions.
 */
export interface ToolRuntimeContext {
  config: AppConfig;
  db: DatabaseAdapter;
  io: AgentIO;
  schemaCatalogCache: SchemaCatalog | null;
  getPlan(): PlanItem[];
  setPlan(plan: PlanItem[]): void;
  getLastResult(): QueryExecutionResult | null;
  setLastResult(result: QueryExecutionResult | null): void;
  getLastExplain(): QueryPlanResult | null;
  setLastExplain(result: QueryPlanResult | null): void;
  mutationApproval: MutationApprovalState;
}

export interface ToolSpec {
  definition: LlmToolDefinition;
  execute(rawArgs: unknown, context: ToolRuntimeContext): Promise<unknown>;
  serialize(result: unknown, appConfig: AppRuntimeConfig): SerializedToolResult;
}

/**
 * Build one registered tool from its model-visible schema, runtime implementation, and serializer.
 */
export function defineTool<TSchema extends z.ZodTypeAny, TResult>(
  definition: LlmToolDefinition["function"],
  schema: TSchema,
  execute: (args: z.infer<TSchema>, context: ToolRuntimeContext) => Promise<TResult>,
  serialize: (result: TResult, appConfig: AppRuntimeConfig) => SerializedToolResult,
): ToolSpec {
  return {
    definition: {
      type: "function",
      function: definition,
    },
    async execute(rawArgs, context) {
      return execute(schema.parse(rawArgs), context);
    },
    serialize(result, appConfig) {
      return serialize(result as TResult, appConfig);
    },
  };
}
