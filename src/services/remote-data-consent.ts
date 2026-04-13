import type { AgentIO } from "../types/index.js";

export type RemoteDataTransferPurpose = "agent_session" | "catalog_sync" | "catalog_search" | "schema_catalog_refresh";

/**
 * Build one explicit confirmation prompt for workflows that send database-derived data to remote APIs.
 */
export function buildRemoteDataTransferApprovalMessage(purpose: RemoteDataTransferPurpose): string {
  switch (purpose) {
    case "agent_session":
      return [
        "This command will send your prompt and relevant database-derived context to the configured external LLM or embedding APIs.",
        "That may include schema metadata, executed SQL text, and bounded query-result previews.",
        "Continue?",
      ].join(" ");

    case "catalog_sync":
      return [
        "Refreshing the local schema catalog will send table and column metadata to the configured external LLM and embedding APIs.",
        "Continue?",
      ].join(" ");

    case "catalog_search":
      return [
        "Catalog search sends your search text to the configured external embedding API.",
        "If the local catalog is missing or stale, it may also send table and column metadata to rebuild the catalog.",
        "Continue?",
      ].join(" ");

    case "schema_catalog_refresh":
      return [
        "Refreshing the local schema catalog after this schema change will send table and column metadata to the configured external LLM and embedding APIs.",
        "Continue?",
      ].join(" ");
  }
}

/**
 * Prompt for approval before a workflow sends database-derived data to remote APIs.
 */
export async function confirmRemoteDataTransfer(
  io: Pick<AgentIO, "confirm">,
  purpose: RemoteDataTransferPurpose,
): Promise<boolean> {
  return io.confirm(buildRemoteDataTransferApprovalMessage(purpose));
}

/**
 * Require explicit approval before a workflow sends database-derived data to remote APIs.
 */
export async function requireRemoteDataTransferApproval(
  io: Pick<AgentIO, "confirm">,
  purpose: RemoteDataTransferPurpose,
): Promise<void> {
  if (await confirmRemoteDataTransfer(io, purpose)) {
    return;
  }

  throw new Error("Remote data transfer was not approved. The command was cancelled before any external API call was made.");
}
