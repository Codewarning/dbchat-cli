import type { LlmMessageParam } from "../llm/types.js";
import type { AppConfig, PlanItem, QueryExecutionResult } from "../types/index.js";
import { estimateTurnSize, MAX_RAW_HISTORY_CHARS, type ConversationTurn, type SessionContextMemory } from "./memory.js";
import { buildContextPrompt, buildSystemPrompt } from "./prompts.js";

function getRecentRawMessages(completedTurns: ConversationTurn[], currentTurn: ConversationTurn | null): LlmMessageParam[] {
  const turns = currentTurn ? [...completedTurns, currentTurn] : [...completedTurns];
  const selectedTurns: ConversationTurn[] = [];
  let usedChars = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnSize = estimateTurnSize(turn);
    const mustInclude = selectedTurns.length === 0;
    if (!mustInclude && usedChars + turnSize > MAX_RAW_HISTORY_CHARS) {
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
): LlmMessageParam[] {
  const messages: LlmMessageParam[] = [
    {
      role: "system",
      content: buildSystemPrompt(config),
    },
  ];

  const contextPrompt = buildContextPrompt(plan, lastResult, memory);
  if (contextPrompt) {
    messages.push({
      role: "system",
      content: contextPrompt,
    });
  }

  messages.push(...getRecentRawMessages(completedTurns, currentTurn));
  return messages;
}
