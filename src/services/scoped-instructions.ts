import type { DatabaseAdapter } from "../db/adapter.js";
import { ensureScopedInstructionFiles } from "../instructions/scoped.js";
import type { DatabaseConfig } from "../types/index.js";

export interface ScopedInstructionBootstrapResult {
  createdPaths: string[];
}

/**
 * Ensure the layered AGENTS.md files and table markdown files exist for the active database target.
 */
export async function initializeScopedInstructionFilesForDatabase(
  config: Pick<DatabaseConfig, "host" | "port" | "database">,
  db: Pick<DatabaseAdapter, "getSchemaSummary">,
): Promise<ScopedInstructionBootstrapResult> {
  const createdPaths = await ensureScopedInstructionFiles(config, []);

  const summary = await db.getSchemaSummary();
  const createdTablePaths = await ensureScopedInstructionFiles(
    config,
    summary.tables.map((table) => table.tableName),
  );

  return {
    createdPaths: Array.from(new Set([...createdPaths, ...createdTablePaths])),
  };
}
