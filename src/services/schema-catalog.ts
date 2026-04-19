import type { DatabaseAdapter } from "../db/adapter.js";
import { ensureSchemaCatalogReady as ensureRuntimeSchemaCatalogReady, initializeSchemaCatalogOnEntry, searchSchemaCatalog, syncSchemaCatalog } from "../schema/catalog.js";
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
    `Schema catalog ready: ${synced.result.tableCount} tables, ${synced.result.documentCount} documents, +${synced.result.addedTables.length} added, ~${synced.result.updatedTables.length} updated, -${synced.result.removedTables.length} removed`,
  );
  return synced;
}

/**
 * Load the already-initialized compatible local schema catalog for the current database.
 */
export async function ensureLocalSchemaCatalogReady(
  config: AppConfig,
  io: AgentIO,
): Promise<ReadySchemaCatalogResult> {
  return ensureRuntimeSchemaCatalogReady(config, io);
}

/**
 * Initialize the local schema catalog when the database runtime is first entered, but never refresh it automatically later.
 */
export async function initializeLocalSchemaCatalogOnEntry(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
): Promise<ReadySchemaCatalogResult | null> {
  try {
    return await ensureRuntimeSchemaCatalogReady(config, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.log(message);
  }

  try {
    return await initializeSchemaCatalogOnEntry(config, db, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.log(`Warning: local schema catalog initialization failed: ${message}`);
    return null;
  }
}

/**
 * Search one already-loaded schema catalog with the same ranking used by tools.
 */
export async function searchLocalSchemaCatalog(
  _config: AppConfig,
  catalog: SchemaCatalog,
  query: string,
  limit: number,
): Promise<SchemaCatalogSearchResult> {
  return searchSchemaCatalog(catalog, query, limit);
}

/**
 * Load the existing local schema catalog first, then run one search over it.
 */
export async function searchReadyLocalSchemaCatalog(
  config: AppConfig,
  io: AgentIO,
  query: string,
  limit: number,
): Promise<ReadySchemaCatalogResult & { search: SchemaCatalogSearchResult }> {
  const ready = await ensureLocalSchemaCatalogReady(config, io);
  return {
    ...ready,
    search: await searchLocalSchemaCatalog(config, ready.catalog, query, limit),
  };
}
