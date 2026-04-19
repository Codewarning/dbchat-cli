// AgentSession owns the conversational loop between the terminal, tools, and the LLM.
import type { DatabaseAdapter } from "../db/adapter.js";
import { LlmClient } from "../llm/client.js";
import type { LlmMessageParam, LlmToolCall, LlmToolDefinition } from "../llm/types.js";
import { buildToolDefinitions } from "../tools/definitions.js";
import type { ToolRuntimeContext } from "../tools/specs.js";
import type {
  AgentIO,
  AppConfig,
  MutationApprovalState,
  PlanItem,
  QueryExecutionResult,
  QueryPlanResult,
  SchemaCatalog,
  TurnDisplayBlock,
} from "../types/index.js";
import { SessionHistoryStore } from "./history-store.js";
import { buildSessionMessages } from "./message-builder.js";
import { summarizeToolCall } from "./memory.js";
import { isPlanResolved } from "./plan.js";
import { stripArtifactReferenceLines } from "../ui/result-artifacts.js";
import { buildQueryResultPreview } from "../ui/query-result-preview.js";
import { loadScopedInstructionBundle } from "../instructions/scoped.js";
import {
  buildExecutionIntentGuidance,
  buildFinalAgentContent,
  compactAssistantContentForHistory,
  classifyUserRequestExecutionIntent,
  looksLikeConfirmationPrompt,
  looksLikeSqlDraftInsteadOfExecutedResult,
} from "./session-policy.js";
import { executeAgentToolCall } from "./tool-execution.js";

export { classifyUserRequestExecutionIntent, type UserRequestExecutionIntent } from "./session-policy.js";

/**
 * Final agent output returned to CLI callers after one user turn completes.
 */
export interface AgentTurnResult {
  content: string;
  plan: PlanItem[];
  lastResult: QueryExecutionResult | null;
  displayBlocks: TurnDisplayBlock[];
}

function safeParseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function buildRenderLastResultSignature(toolCall: LlmToolCall, lastResult: QueryExecutionResult | null): string | null {
  if (toolCall.function.name !== "render_last_result" || !lastResult) {
    return null;
  }

  const args = safeParseToolArguments(toolCall.function.arguments);
  const columns = Array.isArray(args.columns) ? args.columns.filter((value): value is string => typeof value === "string") : [];
  return JSON.stringify({
    sql: lastResult.sql,
    offset: typeof args.offset === "number" ? args.offset : 0,
    limit: typeof args.limit === "number" ? args.limit : null,
    columns,
    expandPreview: args.expandPreview === true,
  });
}

function buildInspectLastResultSignature(toolCall: LlmToolCall, lastResult: QueryExecutionResult | null): string | null {
  if (toolCall.function.name !== "inspect_last_result" || !lastResult) {
    return null;
  }

  const args = safeParseToolArguments(toolCall.function.arguments);
  const columns = Array.isArray(args.columns) ? args.columns.filter((value): value is string => typeof value === "string") : [];
  return JSON.stringify({
    sql: lastResult.sql,
    offset: typeof args.offset === "number" ? args.offset : 0,
    limit: typeof args.limit === "number" ? args.limit : null,
    columns,
  });
}

/**
 * Own the tool-calling loop plus compressed conversation state for one session.
 */
export class AgentSession {
  private readonly llm: LlmClient;
  private readonly tools: LlmToolDefinition[];
  private readonly history: SessionHistoryStore;
  private config: AppConfig;
  private db: DatabaseAdapter;
  private plan: PlanItem[] = [];
  private lastResult: QueryExecutionResult | null = null;
  private lastExplain: QueryPlanResult | null = null;
  private schemaCatalogCache: SchemaCatalog | null = null;
  private displayBlocks: TurnDisplayBlock[] = [];
  private scopedInstructionText: string | null = null;

  /**
   * Create a new session bound to one config, database adapter, and IO implementation.
   */
  constructor(
    config: AppConfig,
    db: DatabaseAdapter,
    private readonly io: AgentIO,
  ) {
    this.config = config;
    this.db = db;
    this.llm = new LlmClient(config.llm);
    this.tools = buildToolDefinitions();
    this.history = new SessionHistoryStore(() => this.config.app.contextCompression.recentRawTurns);
  }

  /**
   * Swap the active runtime database connection while keeping the same session instance.
   */
  replaceRuntime(config: AppConfig, db: DatabaseAdapter): void {
    this.config = config;
    this.db = db;
    this.schemaCatalogCache = null;
    this.scopedInstructionText = null;
  }

  /**
   * Reset all in-memory conversation state for the active session.
   */
  clearConversation(): void {
    this.history.clear();
    this.plan = [];
    this.lastResult = null;
    this.lastExplain = null;
    this.schemaCatalogCache = null;
    this.displayBlocks = [];
  }

  /**
   * Return the current execution plan for slash commands and callers.
   */
  getPlan(): PlanItem[] {
    return this.plan;
  }

  /**
   * Return the latest full SQL result kept in session state.
   */
  getLastResult(): QueryExecutionResult | null {
    return this.lastResult;
  }

  /**
   * Run one user request until the model either finishes or exceeds the safety loop limit.
   */
  async run(input: string): Promise<AgentTurnResult> {
    if (this.history.getCurrentTurn()) {
      this.history.abortCurrentTurn();
    }

    this.scopedInstructionText = (await loadScopedInstructionBundle(this.config.database, "runtime")).mergedText;
    this.history.startTurn(input);
    this.displayBlocks = [];

    try {
      const requestIntent = classifyUserRequestExecutionIntent(input);
      const executionIntentGuidance = buildExecutionIntentGuidance(requestIntent);
      if (executionIntentGuidance) {
        this.history.prependCurrentTurnMessage({
          role: "system",
          content: executionIntentGuidance,
        });
        this.history.appendCurrentTurnSummary(`Request intent: ${requestIntent}`);
      }

      const mutationApproval: MutationApprovalState = {
        allowAllForCurrentTurn: false,
      };
      let redirectedConfirmationPrompt = false;
      let redirectedEmptyReplyAfterToolFailure = false;
      let redirectedSqlDraftForReadOnlyResults = false;
      let redirectedEmptyReplyAfterToolUse = false;
      let lastToolFailure: { toolName: string; message: string } | null = null;
      let consecutiveSchemaSearches = 0;
      let redirectedRepeatedSchemaSearch = false;
      let redirectedRepeatedRenderedResult = false;
      let redirectedRepeatedInspectedResult = false;
      let redirectedToolCallLimit = false;
      let toolCallsThisTurn = 0;
      const renderedResultSignatures = new Set<string>();
      const inspectedResultSignatures = new Set<string>();
      const maxAgentIterations = this.config.app.contextCompression.maxAgentIterations;

      const runtime: ToolRuntimeContext = {
        config: this.config,
        db: this.db,
        io: this.io,
        schemaCatalogCache: this.schemaCatalogCache,
        getPlan: () => this.plan,
        setPlan: (plan) => {
          this.plan = plan;
        },
        getLastResult: () => this.lastResult,
        setLastResult: (result) => {
          // A new SQL result supersedes earlier result previews from exploratory queries in the same turn.
          this.displayBlocks = this.displayBlocks.filter((block) => block.kind !== "result_table");
          this.lastResult = result;
        },
        getLastExplain: () => this.lastExplain,
        setLastExplain: (result) => {
          this.lastExplain = result;
        },
        pushDisplayBlock: (block) => {
          this.displayBlocks.push(block);
        },
        history: this.history.createToolHistoryInspector(),
        mutationApproval,
      };

      for (let iteration = 0; iteration < maxAgentIterations; iteration += 1) {
        const messages = this.buildMessages();
        const response = await this.io.withLoading("Waiting for LLM response", () => this.llm.complete(messages, this.tools));

        const assistantMessage: LlmMessageParam = {
          role: "assistant",
          content: response.content ?? "",
          tool_calls: response.tool_calls,
        };
        this.history.appendCurrentTurnMessage(assistantMessage);

        if (!response.tool_calls?.length) {
          if (!redirectedConfirmationPrompt && looksLikeConfirmationPrompt(response.content)) {
            redirectedConfirmationPrompt = true;
            this.history.appendCurrentTurnMessage({
              role: "system",
              content: "Do not ask the user for confirmation in assistant text. If execution is needed, call run_sql now and let the CLI handle confirmation.",
            });
            continue;
          }

          const trimmedContent = response.content?.trim() ?? "";
          if (!trimmedContent && lastToolFailure && !redirectedEmptyReplyAfterToolFailure) {
            redirectedEmptyReplyAfterToolFailure = true;
            this.history.appendCurrentTurnMessage({
              role: "system",
              content: `Your last tool call failed (${lastToolFailure.toolName}): ${lastToolFailure.message}. Do not stop with an empty reply. Recover by using another tool, choosing an exact table name from schema search results, or explaining the failure and next step clearly.`,
            });
            continue;
          }

          if (!trimmedContent && toolCallsThisTurn > 0 && !redirectedEmptyReplyAfterToolUse) {
            redirectedEmptyReplyAfterToolUse = true;
            this.history.appendCurrentTurnMessage({
              role: "system",
              content:
                "You already gathered tool results in this turn. Do not return an empty reply. Summarize clearly what the schema contains, what concepts are missing, and any executed read-only query results.",
            });
            continue;
          }

          if (
            requestIntent === "read_only_results" &&
            !this.lastResult &&
            !redirectedSqlDraftForReadOnlyResults &&
            looksLikeSqlDraftInsteadOfExecutedResult(response.content)
          ) {
            redirectedSqlDraftForReadOnlyResults = true;
            this.history.appendCurrentTurnMessage({
              role: "system",
              content:
                "The user asked for actual query results. Do not stop after drafting SQL. If the query is a safe read-only SELECT, call run_sql now and return the results.",
            });
            continue;
          }

          let fallbackDisplayBlock: TurnDisplayBlock | null = null;
          if (!this.displayBlocks.length && this.lastResult && requestIntent === "read_only_results") {
            const preview = buildQueryResultPreview(this.lastResult, {
              tableRendering: this.config.app.tableRendering,
            });
            fallbackDisplayBlock = {
              kind: "result_table",
              title: "Result Preview",
              body: stripArtifactReferenceLines(preview.renderedText),
              table: {
                fields: preview.fields,
                rows: preview.rows,
              },
            };
          }

          const finalContent = buildFinalAgentContent({
            responseContent: response.content,
            lastToolFailure,
            toolCallsThisTurn,
            currentTurnMessages: this.history.getCurrentTurn()?.messages ?? [],
            lastResult: this.lastResult,
            appConfig: this.config.app,
            displayBlocks: fallbackDisplayBlock ? [...this.displayBlocks, fallbackDisplayBlock] : this.displayBlocks,
          });
          if (fallbackDisplayBlock) {
            this.displayBlocks.push(fallbackDisplayBlock);
          }
          this.history.replaceLatestAssistantMessageContent(compactAssistantContentForHistory(finalContent));
          this.history.finalizeCurrentTurn(finalContent);
          if (isPlanResolved(this.plan)) {
            this.plan = [];
          }
          return {
            content: finalContent,
            plan: this.plan,
            lastResult: this.lastResult,
            displayBlocks: [...this.displayBlocks],
          };
        }

        for (const toolCall of response.tool_calls) {
          if (toolCallsThisTurn >= this.config.app.contextCompression.maxToolCallsPerTurn) {
            const limitMessage = `The tool call limit for this turn (${this.config.app.contextCompression.maxToolCallsPerTurn}) has been reached. Stop calling tools and answer with the information already collected.`;
            this.history.appendCurrentTurnMessage({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                error: limitMessage,
                limit: this.config.app.contextCompression.maxToolCallsPerTurn,
              }),
              is_error: true,
            });
            this.history.appendCurrentTurnSummary(`Tool call limit reached: ${this.config.app.contextCompression.maxToolCallsPerTurn}.`);
            if (!redirectedToolCallLimit) {
              redirectedToolCallLimit = true;
              this.history.appendCurrentTurnMessage({
                role: "system",
                content: limitMessage,
              });
            }
            lastToolFailure = {
              toolName: toolCall.function.name,
              message: limitMessage,
            };
            redirectedEmptyReplyAfterToolFailure = false;
            continue;
          }

          toolCallsThisTurn += 1;
          const renderSignature = buildRenderLastResultSignature(toolCall, this.lastResult);
          const inspectSignature = buildInspectLastResultSignature(toolCall, this.lastResult);
          if (renderSignature && renderedResultSignatures.has(renderSignature)) {
            const duplicateRenderMessage =
              "The same cached result slice was already rendered in the terminal earlier in this turn. Do not call render_last_result again for the same offset, limit, columns, and expandPreview settings. The user can already see that preview. Answer now unless you need a different slice or exact values from inspect_last_result or search_last_result.";
            this.history.appendCurrentTurnMessage({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: "already_rendered",
                reason: duplicateRenderMessage,
              }),
            });
            this.history.appendCurrentTurnSummary("Skipped duplicate render_last_result for an already-rendered cached slice.");
            if (!redirectedRepeatedRenderedResult) {
              redirectedRepeatedRenderedResult = true;
              this.history.appendCurrentTurnMessage({
                role: "system",
                content: duplicateRenderMessage,
              });
            }
            lastToolFailure = null;
            redirectedEmptyReplyAfterToolFailure = false;
            continue;
          }
          if (inspectSignature && inspectedResultSignatures.has(inspectSignature)) {
            const duplicateInspectMessage =
              "The same cached result slice was already inspected earlier in this turn. Do not call inspect_last_result again for the same offset, limit, and columns. Answer now unless you need a different slice or a narrower column subset.";
            this.history.appendCurrentTurnMessage({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                status: "already_inspected",
                reason: duplicateInspectMessage,
              }),
            });
            this.history.appendCurrentTurnSummary("Skipped duplicate inspect_last_result for an already-inspected cached slice.");
            if (!redirectedRepeatedInspectedResult) {
              redirectedRepeatedInspectedResult = true;
              this.history.appendCurrentTurnMessage({
                role: "system",
                content: duplicateInspectMessage,
              });
            }
            lastToolFailure = null;
            redirectedEmptyReplyAfterToolFailure = false;
            continue;
          }

          this.history.appendCurrentTurnSummary(summarizeToolCall(toolCall));
          const toolFailure = await this.handleToolCall(toolCall, runtime);
          this.schemaCatalogCache = runtime.schemaCatalogCache;
          if (toolCall.function.name === "search_schema_catalog") {
            consecutiveSchemaSearches += 1;
            if (consecutiveSchemaSearches >= 3 && !redirectedRepeatedSchemaSearch) {
              redirectedRepeatedSchemaSearch = true;
              this.history.appendCurrentTurnMessage({
                role: "system",
                content:
                  "You have already searched the schema catalog several times in this turn. If the current schema still does not show tables for part of the request, stop searching and explain clearly which concepts appear present and which appear absent.",
              });
            }
          } else if (toolCall.function.name === "describe_table" || toolCall.function.name === "run_sql" || toolCall.function.name === "get_schema_summary") {
            consecutiveSchemaSearches = 0;
            redirectedRepeatedSchemaSearch = false;
          }

          if (toolFailure) {
            lastToolFailure = {
              toolName: toolCall.function.name,
              message: toolFailure,
            };
            redirectedEmptyReplyAfterToolFailure = false;
          } else {
            if (renderSignature) {
              renderedResultSignatures.add(renderSignature);
            }
            if (inspectSignature) {
              inspectedResultSignatures.add(inspectSignature);
            }
            lastToolFailure = null;
            redirectedEmptyReplyAfterToolFailure = false;
          }
        }
      }

      throw new Error(
        `The agent exceeded the loop limit after ${maxAgentIterations} LLM rounds. The model likely kept revising the plan or calling tools without finishing.`,
      );
    } catch (error) {
      this.history.abortCurrentTurn();
      throw error;
    }
  }

  /**
   * Build the next prompt from fixed policy, compressed memory, and a bounded raw history window.
   */
  private buildMessages(): LlmMessageParam[] {
    return buildSessionMessages(
      this.config,
      this.plan,
      this.lastResult,
      this.history.getSessionMemory(),
      this.history.getRecentCompletedTurns(),
      this.history.getCurrentTurn(),
      this.history.getCurrentInput(),
      this.scopedInstructionText,
    );
  }

  /**
   * Execute one tool call, then store both the compact tool payload and its memory summary.
   */
  private async handleToolCall(toolCall: LlmToolCall, runtime: ToolRuntimeContext): Promise<string | null> {
    return executeAgentToolCall({
      toolCall,
      runtime,
      io: this.io,
      config: this.config,
      memory: this.history.getSessionMemory(),
      currentTurnId: this.history.requireCurrentTurnId(),
      persistToolOutput: (entry) => this.history.persistToolOutput(entry),
      pushCurrentTurnMessage: (message) => this.history.appendCurrentTurnMessage(message),
      pushCurrentTurnSummary: (line) => this.history.appendCurrentTurnSummary(line),
    });
  }
}
