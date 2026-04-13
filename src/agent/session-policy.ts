import { normalizeCliText } from "../ui/plain-text.js";

export const MAX_AGENT_ITERATIONS = 24;
const MAX_ASSISTANT_HISTORY_CHARS = 560;

export type UserRequestExecutionIntent = "sql_only" | "read_only_results" | "neutral";
export type ContextRequestKind =
  | "fresh_query"
  | "fresh_schema"
  | "fresh_explain"
  | "result_follow_up"
  | "schema_follow_up"
  | "explain_follow_up"
  | "export_follow_up"
  | "general_follow_up"
  | "general";

export interface ContextPromptProfile {
  kind: ContextRequestKind;
  includePriorRawTurns: boolean;
  includeArchivedConversation: boolean;
  includeLastSchemaSummary: boolean;
  includeDescribedTables: boolean;
  includeRecentQueryMemory: boolean;
  includeLastExplainSummary: boolean;
  includeLastExportSummary: boolean;
  includeLastResultSummary: boolean;
  includeLastResultTablePreview: boolean;
}

const SQL_ONLY_REQUEST_PATTERN =
  /\bonly\s+sql\b|\bjust\s+sql\b|\bsql\s+only\b|\bquery\s+statement\b|\bsql\s+statement\b|\bdo\s+not\s+execute\b|\bdon't\s+execute\b|\bwithout\s+executing\b|\bno\s+execution\b|\u53ea\u8981\s*sql|\u4ec5\u751f\u6210\s*sql|\u53ea\u751f\u6210\s*sql|\u4e0d\u8981\u6267\u884c|\u4e0d\u8981\u8fd0\u884c|\u522b\u6267\u884c|\u67e5\u8be2\u8bed\u53e5|sql\u8bed\u53e5/iu;
const READ_ONLY_RESULTS_REQUEST_PATTERN =
  /\bquery\b|\bshow\b|\blist\b|\bcount\b|\bdisplay\b|\bfind\b|\bget\b|\bretrieve\b|\u67e5\u8be2|\u67e5\u4e00\u4e0b|\u7edf\u8ba1|\u5217\u51fa|\u663e\u793a|\u67e5\u770b|\u83b7\u53d6|\u67e5\u627e|\u770b\u770b/iu;
const FOLLOW_UP_REFERENCE_PATTERN =
  /\b(previous|earlier|before|prior|follow[\s-]?up|continue|again|same|instead|compare|also|then|next|how about|what about|using that|based on that|that result|that query|those results)\b|\u521a\u624d|\u4e0a\u4e00\u6b21|\u4e0a\u6587|\u4e4b\u524d|\u7ee7\u7eed|\u63a5\u7740|\u7136\u540e|\u90a3\u4e2a\u7ed3\u679c|\u90a3\u6b21\u67e5\u8be2/iu;
const EXPORT_REFERENCE_PATTERN =
  /\b(export|csv|json|download|save)\b|\u5bfc\u51fa|\u4e0b\u8f7d|\u4fdd\u5b58/iu;
const SCHEMA_REFERENCE_PATTERN =
  /\b(schema|schemas|table|tables|column|columns|field|fields|ddl|structure)\b|\u8868\u7ed3\u6784|\u8868|\u5b57\u6bb5|\u5217|\u8868\u540d|\u5217\u540d|ddl/iu;
const EXPLAIN_REFERENCE_PATTERN =
  /\b(explain|plan|execution plan|scan|cost|index|indexes|optimi[sz]e|performance)\b|\u6267\u884c\u8ba1\u5212|\u7d22\u5f15|\u626b\u63cf|\u4f18\u5316|\u6027\u80fd/iu;

function clipText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function hasLexicalFollowUpHint(input: string): boolean {
  const normalizedInput = input.trim();
  if (!normalizedInput) {
    return false;
  }

  if (FOLLOW_UP_REFERENCE_PATTERN.test(normalizedInput)) {
    return true;
  }

  return normalizedInput.length <= 72 && /^(why|how|and|also|then|next|again|instead|continue|export|download)\b/i.test(normalizedInput);
}

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

export function buildContextPromptProfile(
  input: string,
  options: {
    hasPlan: boolean;
    hasLastResult: boolean;
    hasSchemaMemory: boolean;
    hasRecentQueryMemory: boolean;
    hasLastExplainSummary: boolean;
    hasLastExportSummary: boolean;
  },
): ContextPromptProfile {
  const normalizedInput = input.trim();
  const executionIntent = classifyUserRequestExecutionIntent(normalizedInput);
  const lexicalFollowUpHint = hasLexicalFollowUpHint(normalizedInput);
  const referencesSchema = SCHEMA_REFERENCE_PATTERN.test(normalizedInput);
  const referencesExplain = EXPLAIN_REFERENCE_PATTERN.test(normalizedInput);
  const referencesExport = EXPORT_REFERENCE_PATTERN.test(normalizedInput);
  let kind: ContextRequestKind = "general";

  if (options.hasLastResult && referencesExport) {
    kind = "export_follow_up";
  } else if (
    !lexicalFollowUpHint &&
    executionIntent !== "sql_only" &&
    !referencesSchema &&
    !referencesExplain &&
    !referencesExport
  ) {
    kind = "fresh_query";
  } else if (referencesExplain) {
    kind = lexicalFollowUpHint && options.hasLastExplainSummary ? "explain_follow_up" : "fresh_explain";
  } else if (referencesSchema) {
    kind = lexicalFollowUpHint && options.hasSchemaMemory ? "schema_follow_up" : "fresh_schema";
  } else if (lexicalFollowUpHint) {
    if (options.hasLastResult) {
      kind = "result_follow_up";
    } else {
      kind = "general_follow_up";
    }
  }

  if (options.hasPlan) {
    return {
      kind,
      includePriorRawTurns: true,
      includeArchivedConversation: true,
      includeLastSchemaSummary: true,
      includeDescribedTables: true,
      includeRecentQueryMemory: true,
      includeLastExplainSummary: true,
      includeLastExportSummary: true,
      includeLastResultSummary: options.hasLastResult,
      includeLastResultTablePreview: options.hasLastResult && (kind === "result_follow_up" || kind === "export_follow_up"),
    };
  }

  switch (kind) {
    case "fresh_query":
      return {
        kind,
        includePriorRawTurns: false,
        includeArchivedConversation: false,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      };

    case "fresh_schema":
      return {
        kind,
        includePriorRawTurns: false,
        includeArchivedConversation: false,
        includeLastSchemaSummary: options.hasSchemaMemory,
        includeDescribedTables: options.hasSchemaMemory,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      };

    case "fresh_explain":
      return {
        kind,
        includePriorRawTurns: false,
        includeArchivedConversation: false,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      };

    case "result_follow_up":
      return {
        kind,
        includePriorRawTurns: true,
        includeArchivedConversation: true,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: options.hasRecentQueryMemory,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: options.hasLastResult,
        includeLastResultTablePreview: options.hasLastResult,
      };

    case "schema_follow_up":
      return {
        kind,
        includePriorRawTurns: true,
        includeArchivedConversation: true,
        includeLastSchemaSummary: options.hasSchemaMemory,
        includeDescribedTables: options.hasSchemaMemory,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      };

    case "explain_follow_up":
      return {
        kind,
        includePriorRawTurns: true,
        includeArchivedConversation: true,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: options.hasRecentQueryMemory,
        includeLastExplainSummary: options.hasLastExplainSummary,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      };

    case "export_follow_up":
      return {
        kind,
        includePriorRawTurns: true,
        includeArchivedConversation: true,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: options.hasRecentQueryMemory,
        includeLastExplainSummary: false,
        includeLastExportSummary: options.hasLastExportSummary,
        includeLastResultSummary: options.hasLastResult,
        includeLastResultTablePreview: false,
      };

    case "general_follow_up":
      return {
        kind,
        includePriorRawTurns: true,
        includeArchivedConversation: true,
        includeLastSchemaSummary: options.hasSchemaMemory,
        includeDescribedTables: options.hasSchemaMemory,
        includeRecentQueryMemory: options.hasRecentQueryMemory,
        includeLastExplainSummary: options.hasLastExplainSummary,
        includeLastExportSummary: options.hasLastExportSummary,
        includeLastResultSummary: options.hasLastResult,
        includeLastResultTablePreview: false,
      };

    case "general":
    default:
      return {
        kind,
        includePriorRawTurns: false,
        includeArchivedConversation: false,
        includeLastSchemaSummary: false,
        includeDescribedTables: false,
        includeRecentQueryMemory: false,
        includeLastExplainSummary: false,
        includeLastExportSummary: false,
        includeLastResultSummary: false,
        includeLastResultTablePreview: false,
      };
  }
}

/**
 * Normalize the final assistant answer into plain terminal-safe text.
 */
export function normalizeAssistantContent(content: string | null | undefined): string {
  return normalizeCliText(content?.trim() || "The LLM returned no text output.");
}

export function compactAssistantContentForHistory(content: string | null | undefined): string {
  return clipText(normalizeAssistantContent(content), MAX_ASSISTANT_HISTORY_CHARS);
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
