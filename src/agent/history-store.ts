import type { LlmMessageParam } from "../llm/types.js";
import type { HistoryMessageSnapshot, HistoryTurnSnapshot, PersistedToolOutputSnapshot } from "../types/index.js";
import type { ToolHistoryInspector } from "../tools/specs.js";
import {
  appendSummaryLine,
  buildArchivedTurnSummary,
  createConversationTurn,
  createSessionContextMemory,
  MAX_ARCHIVED_TURN_SUMMARIES,
  mergeRollingSummary,
  type ConversationTurn,
  type PersistedToolOutput,
  type SessionContextMemory,
} from "./memory.js";

export interface PersistToolOutputInput {
  toolCallId: string;
  toolName: string;
  summary: string;
  content: string;
}

function serializeHistoryMessage(message: LlmMessageParam): HistoryMessageSnapshot {
  switch (message.role) {
    case "system":
    case "user":
      return {
        role: message.role,
        content: message.content,
      };

    case "assistant":
      return {
        role: message.role,
        content: message.content,
        toolCallNames: message.tool_calls?.map((toolCall) => toolCall.function.name),
      };

    case "tool":
      return {
        role: message.role,
        content: message.content,
        toolCallId: message.tool_call_id,
        isError: message.is_error,
      };
  }
}

/**
 * Own in-memory turn history, compressed session memory, and oversized tool payload storage for one session.
 */
export class SessionHistoryStore {
  private completedTurns: ConversationTurn[] = [];
  private allCompletedTurns: ConversationTurn[] = [];
  private currentTurn: ConversationTurn | null = null;
  private persistedToolOutputs: PersistedToolOutput[] = [];
  private sessionMemory: SessionContextMemory = createSessionContextMemory();
  private turnSequence = 0;
  private persistedToolOutputSequence = 0;

  constructor(private readonly getRecentRawTurnLimit: () => number) {}

  clear(): void {
    this.completedTurns = [];
    this.allCompletedTurns = [];
    this.currentTurn = null;
    this.persistedToolOutputs = [];
    this.sessionMemory = createSessionContextMemory();
    this.turnSequence = 0;
    this.persistedToolOutputSequence = 0;
  }

  startTurn(input: string): ConversationTurn {
    const turn = createConversationTurn(input, this.createNextTurnId());
    this.currentTurn = turn;
    return turn;
  }

  getCurrentTurn(): ConversationTurn | null {
    return this.currentTurn;
  }

  abortCurrentTurn(): void {
    this.currentTurn = null;
  }

  getRecentCompletedTurns(): ConversationTurn[] {
    return this.completedTurns;
  }

  getSessionMemory(): SessionContextMemory {
    return this.sessionMemory;
  }

  appendCurrentTurnMessage(message: LlmMessageParam): void {
    this.requireCurrentTurn().messages.push(message);
  }

  prependCurrentTurnMessage(message: LlmMessageParam): void {
    this.requireCurrentTurn().messages.unshift(message);
  }

  appendCurrentTurnSummary(line: string): void {
    appendSummaryLine(this.requireCurrentTurn(), line);
  }

  getCurrentInput(): string {
    if (!this.currentTurn) {
      return "";
    }

    for (const message of this.currentTurn.messages) {
      if (message.role === "user") {
        return message.content;
      }
    }

    return "";
  }

  replaceLatestAssistantMessageContent(content: string): void {
    if (!this.currentTurn) {
      return;
    }

    for (let index = this.currentTurn.messages.length - 1; index >= 0; index -= 1) {
      const message = this.currentTurn.messages[index];
      if (message.role !== "assistant") {
        continue;
      }

      this.currentTurn.messages[index] = {
        ...message,
        content,
      };
      return;
    }
  }

  requireCurrentTurnId(): string {
    return this.requireCurrentTurn().id;
  }

  persistToolOutput(entry: PersistToolOutputInput): PersistedToolOutput {
    const currentTurn = this.requireCurrentTurn();
    this.persistedToolOutputSequence += 1;
    const persistedOutput: PersistedToolOutput = {
      id: `tool-output-${this.persistedToolOutputSequence}`,
      turnId: currentTurn.id,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      summary: entry.summary,
      content: entry.content,
    };
    this.persistedToolOutputs.push(persistedOutput);
    return persistedOutput;
  }

  finalizeCurrentTurn(finalContent: string): void {
    if (!this.currentTurn) {
      return;
    }

    appendSummaryLine(this.currentTurn, `Final answer: ${finalContent}`);
    this.completedTurns.push(this.currentTurn);
    this.allCompletedTurns.push(this.currentTurn);
    this.currentTurn = null;
    this.compressCompletedTurns();
  }

  inspectTurn(turnId: string): HistoryTurnSnapshot | null {
    const turn = this.allCompletedTurns.find((entry) => entry.id === turnId);
    if (!turn) {
      return null;
    }

    return {
      turnId: turn.id,
      summaryLines: [...turn.summaryLines],
      messages: turn.messages.map(serializeHistoryMessage),
    };
  }

  inspectPersistedOutput(id: string): PersistedToolOutputSnapshot | null {
    const persistedOutput = this.persistedToolOutputs.find((entry) => entry.id === id);
    if (!persistedOutput) {
      return null;
    }

    return {
      persistedOutputId: persistedOutput.id,
      turnId: persistedOutput.turnId,
      toolName: persistedOutput.toolName,
      summary: persistedOutput.summary,
      content: persistedOutput.content,
    };
  }

  createToolHistoryInspector(): ToolHistoryInspector {
    return {
      inspectTurn: (turnId) => this.inspectTurn(turnId),
      inspectPersistedOutput: (id) => this.inspectPersistedOutput(id),
    };
  }

  private createNextTurnId(): string {
    this.turnSequence += 1;
    return `turn-${this.turnSequence}`;
  }

  private requireCurrentTurn(): ConversationTurn {
    if (!this.currentTurn) {
      throw new Error("Cannot access the current turn without an active turn.");
    }

    return this.currentTurn;
  }

  private compressCompletedTurns(): void {
    while (this.completedTurns.length > this.getRecentRawTurnLimit()) {
      const archivedTurn = this.completedTurns.shift();
      if (!archivedTurn) {
        continue;
      }

      this.sessionMemory.archivedTurnSummaries.push(buildArchivedTurnSummary(archivedTurn));
      if (this.sessionMemory.archivedTurnSummaries.length > MAX_ARCHIVED_TURN_SUMMARIES) {
        const overflow = this.sessionMemory.archivedTurnSummaries.splice(
          0,
          this.sessionMemory.archivedTurnSummaries.length - MAX_ARCHIVED_TURN_SUMMARIES,
        );
        this.sessionMemory.rollingSummary = mergeRollingSummary(this.sessionMemory.rollingSummary, overflow);
      }
    }
  }
}
