import type { DatabaseAdapter } from "../db/adapter.js";
import { ensureSchemaCatalogReady as ensureRuntimeSchemaCatalogReady, initializeSchemaCatalogOnEntry, searchSchemaCatalog, syncSchemaCatalog } from "../schema/catalog.js";
import type { AgentIO, AppConfig, SchemaCatalog, SchemaCatalogSearchResult, SchemaCatalogSyncResult } from "../types/index.js";
import { confirmRemoteDataTransfer } from "./remote-data-consent.js";

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
 * Load the already-initialized compatible local schema catalog for the current database.
 */
export async function ensureLocalSchemaCatalogReady(
  config: AppConfig,
  db: DatabaseAdapter,
  io: AgentIO,
): Promise<ReadySchemaCatalogResult> {
  return ensureRuntimeSchemaCatalogReady(config, db, io);
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
    return await ensureRuntimeSchemaCatalogReady(config, db, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.log(message);
  }

  const approved = await confirmRemoteDataTransfer(io, "catalog_sync");
  if (!approved) {
    io.log("Skipped local schema catalog initialization. Run `dbchat catalog sync` later if you need schema search tools.");
    return null;
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
  config: AppConfig,
  catalog: SchemaCatalog,
  query: string,
  limit: number,
): Promise<SchemaCatalogSearchResult> {
  return searchSchemaCatalog(catalog, config.embedding, query, limit);
}

/**
 * Load the existing local schema catalog first, then run one search over it.
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
