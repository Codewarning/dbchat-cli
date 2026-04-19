import type { LlmMessageParam } from "../llm/types.js";
import type { AppConfig, PlanItem, QueryExecutionResult } from "../types/index.js";
import { estimateTurnSize, type ConversationTurn, type SessionContextMemory } from "./memory.js";
import { buildContextPrompt, buildSystemPrompt } from "./prompts.js";
import { buildContextPromptProfile } from "./session-policy.js";

function getRecentRawMessages(
  completedTurns: ConversationTurn[],
  currentTurn: ConversationTurn | null,
  includePreviousTurns: boolean,
  rawHistoryChars: number,
): LlmMessageParam[] {
  const turns = includePreviousTurns
    ? currentTurn
      ? [...completedTurns, currentTurn]
      : [...completedTurns]
    : currentTurn
      ? [currentTurn]
      : [];
  const selectedTurns: ConversationTurn[] = [];
  let usedChars = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnSize = estimateTurnSize(turn);
    const mustInclude = selectedTurns.length === 0;
    if (!mustInclude && usedChars + turnSize > rawHistoryChars) {
      break;
    }

    selectedTurns.unshift(turn);
    usedChars += turnSize;
  }

  return selectedTurns.flatMap((turn) => turn.messages);
}

/**
 * Build the next LLM message list from policy, dynamic context, and the bounded raw history window.
 */
export function buildSessionMessages(
  config: AppConfig,
  plan: PlanItem[],
  lastResult: QueryExecutionResult | null,
  memory: SessionContextMemory,
  completedTurns: ConversationTurn[],
  currentTurn: ConversationTurn | null,
  currentInput: string,
  scopedInstructionText?: string | null,
): LlmMessageParam[] {
  const contextProfile = buildContextPromptProfile(currentInput, {
    hasPlan: plan.length > 0,
    hasLastResult: Boolean(lastResult),
    hasSchemaMemory: Boolean(memory.lastSchemaSummary || memory.describedTables.length),
    hasRecentQueryMemory: Boolean(memory.recentQueries.length),
    hasLastExplainSummary: Boolean(memory.lastExplainSummary),
    hasLastExportSummary: Boolean(memory.lastExportSummary),
  });
  const messages: LlmMessageParam[] = [
    {
      role: "system",
      content: buildSystemPrompt(config),
    },
  ];

  if (scopedInstructionText?.trim()) {
    messages.push({
      role: "system",
      content: scopedInstructionText,
    });
  }

  const contextPrompt = buildContextPrompt(plan, lastResult, memory, contextProfile);
  if (contextPrompt) {
    messages.push({
      role: "system",
      content: contextPrompt,
    });
  }

  messages.push(
    ...getRecentRawMessages(
      completedTurns,
      currentTurn,
      contextProfile.includePriorRawTurns,
      config.app.contextCompression.rawHistoryChars,
    ),
  );
  return messages;
}
