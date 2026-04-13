import type { DatabaseAdapter } from "../db/adapter.js";
import { ensureSchemaCatalogReady as ensureRuntimeSchemaCatalogReady, searchSchemaCatalog, syncSchemaCatalog } from "../schema/catalog.js";
import type { AgentIO, AppConfig, SchemaCatalog, SchemaCatalogSearchResult, SchemaCatalogSyncResult } from "../types/index.js";

export interface ReadySchemaCatalogResult {
  catalog: SchemaCatalog;
  refreshed: boolean;
  result: SchemaCatalogSyncResult | null;
}

/**
 * Refresh the on-disk schema catalog for the current database target and log one concise summary.
 */
export async function refreshLocalSchemaCatalog(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
): Promise<{ catalog: SchemaCatalog; result: SchemaCatalogSyncResult }> {
  io.log("Refreshing local schema catalog");
  const synced = await io.withLoading("Refreshing schema catalog", () => syncSchemaCatalog(config, db, io));
  io.log(
    `Schema catalog ready: ${synced.result.tableCount} tables, +${synced.result.addedTables.length} added, ~${synced.result.updatedTables.length} updated, -${synced.result.removedTables.length} removed`,
  );
  return synced;
}

/**
 * Load a compatible local schema catalog or rebuild it when it is missing or stale.
 */
export async function ensureLocalSchemaCatalogReady(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
): Promise<ReadySchemaCatalogResult> {
  return ensureRuntimeSchemaCatalogReady(config, db, io);
}

/**
 * Search one already-loaded schema catalog with the same ranking used by tools.
 */
export async function searchLocalSchemaCatalog(
  config: AppConfig,
  catalog: SchemaCatalog,
  query: string,
  limit: number,
): Promise<SchemaCatalogSearchResult> {
  return searchSchemaCatalog(catalog, config.embedding, query, limit);
}

/**
 * Ensure the local schema catalog is ready first, then run one search over it.
 */
export async function searchReadyLocalSchemaCatalog(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
  query: string,
  limit: number,
): Promise<ReadySchemaCatalogResult & { search: SchemaCatalogSearchResult }> {
  const ready = await ensureLocalSchemaCatalogReady(config, db, io);
  return {
    ...ready,
    search: await searchLocalSchemaCatalog(config, ready.catalog, query, limit),
  };
}
