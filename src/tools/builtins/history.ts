import { z } from "zod";
import type { HistoryTurnSnapshot, PersistedToolOutputSnapshot } from "../../types/index.js";
import { stringifyCompact } from "../serialize-helpers.js";
import { defineTool } from "../specs.js";

const DEFAULT_PERSISTED_OUTPUT_CHARS = 8000;
const MAX_PERSISTED_OUTPUT_CHARS = 20000;

const inspectHistoryEntrySchema = z
  .object({
    turnId: z.string().min(1).optional(),
    persistedOutputId: z.string().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    maxChars: z.number().int().positive().max(MAX_PERSISTED_OUTPUT_CHARS).optional(),
  })
  .refine((args) => Boolean(args.turnId || args.persistedOutputId), {
    message: "Provide either turnId or persistedOutputId.",
  })
  .refine((args) => !(args.turnId && args.persistedOutputId), {
    message: "Provide only one of turnId or persistedOutputId.",
  });

interface HistoryTurnInspectionResult {
  kind: "turn";
  turnId: string;
  summaryLines: HistoryTurnSnapshot["summaryLines"];
  messages: HistoryTurnSnapshot["messages"];
}

interface PersistedToolOutputInspectionResult {
  kind: "persisted_tool_output";
  persistedOutputId: string;
  turnId: string;
  toolName: string;
  summary: string;
  totalChars: number;
  offset: number;
  returnedChars: number;
  truncated: boolean;
  content: string;
}

function inspectPersistedToolOutput(
  persistedOutput: PersistedToolOutputSnapshot,
  options: {
    offset?: number;
    maxChars?: number;
  },
): PersistedToolOutputInspectionResult {
  const offset = options.offset ?? 0;
  const maxChars = Math.min(options.maxChars ?? DEFAULT_PERSISTED_OUTPUT_CHARS, MAX_PERSISTED_OUTPUT_CHARS);
  const content = persistedOutput.content.slice(offset, offset + maxChars);

  return {
    kind: "persisted_tool_output",
    persistedOutputId: persistedOutput.persistedOutputId,
    turnId: persistedOutput.turnId,
    toolName: persistedOutput.toolName,
    summary: persistedOutput.summary,
    totalChars: persistedOutput.content.length,
    offset,
    returnedChars: content.length,
    truncated: offset + content.length < persistedOutput.content.length,
    content,
  };
}

export const inspectHistoryEntryTool = defineTool(
  {
    name: "inspect_history_entry",
    description:
      "Inspect the full content of one previous turn or one large persisted tool output from the current session. Use this when compressed conversation memory or persisted-output markers omit details that are needed now.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        turnId: {
          type: "string",
          description: "Exact turn ID from compressed conversation memory, such as turn-3.",
        },
        persistedOutputId: {
          type: "string",
          description: "Exact persisted output ID from a tool marker, such as tool-output-2.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Optional character offset when reading a persisted tool output.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PERSISTED_OUTPUT_CHARS,
          description: `Maximum number of characters to read from a persisted tool output, up to ${MAX_PERSISTED_OUTPUT_CHARS}.`,
        },
      },
    },
  },
  inspectHistoryEntrySchema,
  async (args, context) => {
    if (args.turnId) {
      const turn = context.history.inspectTurn(args.turnId);
      if (!turn) {
        throw new Error(`No completed turn was found for '${args.turnId}'.`);
      }

      context.io.log(`Inspecting conversation turn ${turn.turnId}`);
      return {
        kind: "turn",
        turnId: turn.turnId,
        summaryLines: [...turn.summaryLines],
        messages: turn.messages,
      } satisfies HistoryTurnInspectionResult;
    }

    const persistedOutput = context.history.inspectPersistedOutput(args.persistedOutputId!);
    if (!persistedOutput) {
      throw new Error(`No persisted tool output was found for '${args.persistedOutputId}'.`);
    }

    context.io.log(`Inspecting persisted tool output ${persistedOutput.persistedOutputId}`);
    return inspectPersistedToolOutput(persistedOutput, args);
  },
  (result) => {
    const payload = result as HistoryTurnInspectionResult | PersistedToolOutputInspectionResult;
    if (payload.kind === "turn") {
      return {
        content: stringifyCompact(payload),
        summary: `History turn inspected: ${payload.turnId} with ${payload.messages.length} messages.`,
      };
    }

    return {
      content: stringifyCompact(payload),
      summary: `Persisted tool output inspected: ${payload.persistedOutputId} returned ${payload.returnedChars} of ${payload.totalChars} chars.`,
    };
  },
);
