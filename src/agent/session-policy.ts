import { normalizeCliText } from "../ui/plain-text.js";

export const MAX_AGENT_ITERATIONS = 24;

export type UserRequestExecutionIntent = "sql_only" | "read_only_results" | "neutral";

const SQL_ONLY_REQUEST_PATTERN =
  /\bonly\s+sql\b|\bjust\s+sql\b|\bsql\s+only\b|\bquery\s+statement\b|\bsql\s+statement\b|\bdo\s+not\s+execute\b|\bdon't\s+execute\b|\bwithout\s+executing\b|\bno\s+execution\b|\u53ea\u8981\s*sql|\u4ec5\u751f\u6210\s*sql|\u53ea\u751f\u6210\s*sql|\u4e0d\u8981\u6267\u884c|\u4e0d\u8981\u8fd0\u884c|\u522b\u6267\u884c|\u67e5\u8be2\u8bed\u53e5|sql\u8bed\u53e5/iu;
const READ_ONLY_RESULTS_REQUEST_PATTERN =
  /\bquery\b|\bshow\b|\blist\b|\bcount\b|\bdisplay\b|\bfind\b|\bget\b|\bretrieve\b|\u67e5\u8be2|\u67e5\u4e00\u4e0b|\u7edf\u8ba1|\u5217\u51fa|\u663e\u793a|\u67e5\u770b|\u83b7\u53d6|\u67e5\u627e|\u770b\u770b/iu;

/**
 * Infer whether the user wants SQL only or actual read-only query results.
 */
export function classifyUserRequestExecutionIntent(input: string): UserRequestExecutionIntent {
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return "neutral";
  }

  if (SQL_ONLY_REQUEST_PATTERN.test(normalizedInput)) {
    return "sql_only";
  }

  if (READ_ONLY_RESULTS_REQUEST_PATTERN.test(normalizedInput)) {
    return "read_only_results";
  }

  return "neutral";
}

export function buildExecutionIntentGuidance(intent: UserRequestExecutionIntent): string | null {
  switch (intent) {
    case "sql_only":
      return "The latest user request asks for SQL only. Do not call run_sql unless the user later explicitly asks to execute it.";
    case "read_only_results":
      return "The latest user request asks for actual query results, not just a SQL draft. Unless the user explicitly says not to run SQL, inspect schema as needed and execute an appropriate read-only SELECT.";
    case "neutral":
    default:
      return null;
  }
}

/**
 * Normalize the final assistant answer into plain terminal-safe text.
 */
export function normalizeAssistantContent(content: string | null | undefined): string {
  return normalizeCliText(content?.trim() || "The LLM returned no text output.");
}

/**
 * Detect confirmation wording that should be routed back through the SQL tool gate.
 */
export function looksLikeConfirmationPrompt(content: string | null | undefined): boolean {
  if (!content) {
    return false;
  }

  return /(please confirm|confirm execution|whether to execute|do you want to execute|\u662f\u5426\u786e\u8ba4|\u786e\u8ba4\u6267\u884c)/i.test(content);
}

export function looksLikeSqlDraftInsteadOfExecutedResult(content: string | null | undefined): boolean {
  if (!content) {
    return false;
  }

  return /\bnot executed\b|\bwas not executed\b|\bhere(?: is|'s)? the sql\b|\bsql statement\b|\u672a\u6267\u884c|\u6ca1\u6709\u6267\u884c|\u4ee5\u4e0b\u662f\s*sql|sql\u8bed\u53e5/iu.test(content);
}

export function buildFinalAgentContent(options: {
  responseContent: string | null | undefined;
  lastToolFailure: { toolName: string; message: string } | null;
  toolCallsThisTurn: number;
}): string {
  const trimmedContent = options.responseContent?.trim() ?? "";
  if (trimmedContent) {
    return normalizeAssistantContent(trimmedContent);
  }

  if (options.lastToolFailure) {
    return normalizeCliText(`The assistant stopped after a tool failure: ${options.lastToolFailure.message}`);
  }

  if (options.toolCallsThisTurn > 0) {
    return normalizeCliText("The assistant stopped without a final conclusion after using tools. The schema may be missing part of the requested concepts.");
  }

  return normalizeAssistantContent(options.responseContent);
}
