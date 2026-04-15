import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "../db/adapter.js";
import { embedTexts } from "../embedding/client.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import type { AgentIO, AppConfig, SchemaCatalog, SchemaCatalogSyncResult, SchemaCatalogTable, TableColumn, TableSchema } from "../types/index.js";
import { TABLE_ANALYSIS_BATCH_SIZE, analyzeTableBatchForSearch, buildTableEmbeddingText } from "./catalog-enrichment.js";
import { isSchemaCatalogCompatible } from "./catalog-search.js";
import { getSchemaCatalogPath, loadSchemaCatalog, saveSchemaCatalog, SCHEMA_CATALOG_VERSION } from "./catalog-storage.js";

const MAX_SUMMARY_COLUMNS = 8;
const CATALOG_INDEX_CONCURRENCY = 3;

/**
 * Serialize table schema fields deterministically before hashing them.
 */
function serializeTableForHash(table: TableSchema): string {
  return JSON.stringify({
    tableName: table.tableName,
    columns: table.columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      isNullable: column.isNullable,
      defaultValue: column.defaultValue,
    })),
    ddlPreview: table.ddlPreview ?? null,
  });
}

/**
 * Render one compact column preview for summary text.
 */
function buildColumnPreview(column: TableColumn): string {
  const nullable = column.isNullable ? "nullable" : "not null";
  const defaultValue = column.defaultValue ? ` default=${String(column.defaultValue).replace(/\s+/g, " ").trim()}` : "";
  return `${column.name} ${column.dataType} ${nullable}${defaultValue}`;
}

/**
 * Build the human-readable summary text stored for one table.
 */
function buildTableSummaryText(table: TableSchema): string {
  const preview = table.columns.slice(0, MAX_SUMMARY_COLUMNS).map(buildColumnPreview).join("; ");
  const omitted = table.columns.length > MAX_SUMMARY_COLUMNS ? `; +${table.columns.length - MAX_SUMMARY_COLUMNS} more columns` : "";
  return `${table.tableName}: ${table.columns.length} columns. ${preview}${omitted}`;
}

/**
 * Compute the stable schema hash for one table.
 */
function computeSchemaHash(table: TableSchema): string {
  return createHash("sha256").update(serializeTableForHash(table)).digest("hex");
}

/**
 * Compare the persisted catalog against the live database schema and report why it needs a rebuild.
 */
export async function assessSchemaCatalogFreshness(
  catalog: SchemaCatalog,
  db: DatabaseAdapter,
): Promise<{ fresh: boolean; reason: string }> {
  const liveTables = await db.getAllTableSchemas();
  if (liveTables.length !== catalog.tables.length) {
    return {
      fresh: false,
      reason: `table count changed from ${catalog.tables.length} to ${liveTables.length}`,
    };
  }

  const catalogTables = new Map(catalog.tables.map((table) => [table.tableName, table]));
  for (const table of liveTables) {
    const catalogTable = catalogTables.get(table.tableName);
    if (!catalogTable) {
      return {
        fresh: false,
        reason: `table '${table.tableName}' is missing from the local catalog`,
      };
    }

    if (catalogTable.schemaHash !== computeSchemaHash(table)) {
      return {
        fresh: false,
        reason: `table '${table.tableName}' changed since the local catalog was generated`,
      };
    }
  }

  return {
    fresh: true,
    reason: "The local schema catalog matches the live database schema.",
  };
}

/**
 * Return the already-built local schema catalog when it matches the current embedding configuration.
 */
export async function ensureSchemaCatalogReady(
  appConfig: AppConfig,
  _db: DatabaseAdapter,
  io: Pick<AgentIO, "log" | "withLoading" | "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; refreshed: boolean; result: SchemaCatalogSyncResult | null }> {
  const existingCatalog = await loadSchemaCatalog(appConfig.database);
  if (!existingCatalog) {
    throw new Error(
      "No local schema catalog is available for the current database. Reload the database and approve catalog initialization, or run `dbchat catalog sync`.",
    );
  }

  if (!isSchemaCatalogCompatible(existingCatalog, appConfig.embedding)) {
    throw new Error(
      "The local schema catalog was built with a different embedding configuration. Reload the database and approve catalog initialization, or run `dbchat catalog sync`.",
    );
  }

  io.log(`Using existing local schema catalog: ${existingCatalog.tableCount} tables`);
  return {
    catalog: existingCatalog,
    refreshed: false,
    result: null,
  };
}

/**
 * Build the local schema catalog when the active database is first loaded and no compatible catalog exists yet.
 */
export async function initializeSchemaCatalogOnEntry(
  appConfig: AppConfig,
  db: DatabaseAdapter,
  io: Pick<AgentIO, "log" | "withLoading" | "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; refreshed: boolean; result: SchemaCatalogSyncResult | null }> {
  const existingCatalog = await loadSchemaCatalog(appConfig.database);
  if (existingCatalog && isSchemaCatalogCompatible(existingCatalog, appConfig.embedding)) {
    io.log(`Using existing local schema catalog: ${existingCatalog.tableCount} tables`);
    return {
      catalog: existingCatalog,
      refreshed: false,
      result: null,
    };
  }

  if (existingCatalog) {
    io.log("Local schema catalog is incompatible with the current embedding configuration. Rebuilding it now.");
  } else {
    io.log("Local schema catalog is missing. Building it now.");
  }

  const synced = await io.withLoading("Refreshing schema catalog", () => syncSchemaCatalog(appConfig, db, io));
  io.log(
    `Schema catalog ready: ${synced.result.tableCount} tables, +${synced.result.addedTables.length} added, ~${synced.result.updatedTables.length} updated, -${synced.result.removedTables.length} removed`,
  );
  return {
    catalog: synced.catalog,
    refreshed: true,
    result: synced.result,
  };
}

/**
 * Split a list into fixed-size chunks.
 */
function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error("Chunk size must be greater than zero.");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

/**
 * Map items with a bounded worker pool to avoid overloading remote indexing work.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) {
    return [];
  }

  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: normalizedConcurrency }, () => worker()));
  return results;
}

/**
 * Rebuild one table entry from a previous catalog when its schema hash still matches.
 */
function buildCatalogTableFromPrevious(table: TableSchema, previousTable: SchemaCatalogTable): SchemaCatalogTable {
  const schemaHash = computeSchemaHash(table);
  return {
    ...previousTable,
    tableName: table.tableName,
    summaryText: buildTableSummaryText(table),
    columns: table.columns,
    ddlPreview: table.ddlPreview,
    schemaHash,
  };
}

/**
 * Build new catalog entries for a batch of changed tables.
 */
async function buildCatalogTablesBatch(
  appConfig: AppConfig,
  tables: TableSchema[],
  io?: Pick<AgentIO, "createProgressHandle">,
): Promise<SchemaCatalogTable[]> {
  const metadataByTable = await analyzeTableBatchForSearch(appConfig.llm, tables);
  const embeddingTexts = tables.map((table) => {
    const metadata = metadataByTable.get(table.tableName);
    if (!metadata) {
      throw new Error(`Missing semantic metadata for '${table.tableName}'.`);
    }

    return buildTableEmbeddingText(table, metadata);
  });
  const embeddingVectors = await embedTexts(embeddingTexts, {
    config: appConfig.embedding,
  });

  return tables.map((table, index) => {
    const metadata = metadataByTable.get(table.tableName);
    const embeddingText = embeddingTexts[index];
    const embeddingVector = embeddingVectors[index];
    if (!metadata) {
      throw new Error(`Missing semantic metadata for '${table.tableName}'.`);
    }
    if (!embeddingText || !embeddingVector?.length) {
      throw new Error(`Missing embedding output for '${table.tableName}'.`);
    }

    return {
      tableName: table.tableName,
      schemaHash: computeSchemaHash(table),
      summaryText: buildTableSummaryText(table),
      ddlPreview: table.ddlPreview,
      description: metadata.description,
      tags: metadata.tags,
      embeddingText,
      embeddingVector,
      columns: table.columns,
    };
  });
}

/**
 * Build the next full schema catalog, reusing previous semantic index entries when possible.
 */
async function buildSchemaCatalog(
  appConfig: AppConfig,
  tables: TableSchema[],
  previousCatalog?: SchemaCatalog | null,
  io?: Pick<AgentIO, "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; reindexedTableCount: number; reusedIndexCount: number }> {
  const embeddingModelInfo = getEmbeddingModelInfo(appConfig.embedding);
  const previousTables = new Map(previousCatalog?.tables.map((table) => [table.tableName, table]) ?? []);
  const canReusePreviousIndex = previousCatalog?.embeddingModelId === embeddingModelInfo.modelId;
  const normalizedTables: SchemaCatalogTable[] = [];
  const tablesToIndex: TableSchema[] = [];
  let reindexedTableCount = 0;
  let reusedIndexCount = 0;

  for (const table of tables.sort((left, right) => left.tableName.localeCompare(right.tableName))) {
    const previousTable = canReusePreviousIndex ? previousTables.get(table.tableName) : undefined;
    const schemaHash = computeSchemaHash(table);
    if (
      previousTable &&
      previousTable.schemaHash === schemaHash &&
      previousTable.description &&
      previousTable.tags.length >= 3 &&
      previousTable.embeddingText &&
      previousTable.embeddingVector.length
    ) {
      normalizedTables.push(buildCatalogTableFromPrevious(table, previousTable));
      reusedIndexCount += 1;
      continue;
    }

    tablesToIndex.push(table);
  }

  if (tablesToIndex.length) {
    const indexedBatches = await mapWithConcurrency(
      chunkItems(tablesToIndex, TABLE_ANALYSIS_BATCH_SIZE),
      CATALOG_INDEX_CONCURRENCY,
      (batch) => buildCatalogTablesBatch(appConfig, batch, io),
    );

    for (const batch of indexedBatches) {
      normalizedTables.push(...batch);
      reindexedTableCount += batch.length;
    }
  }

  normalizedTables.sort((left, right) => left.tableName.localeCompare(right.tableName));

  return {
    catalog: {
      version: SCHEMA_CATALOG_VERSION,
      dialect: appConfig.database.dialect,
      host: appConfig.database.host,
      port: appConfig.database.port,
      database: appConfig.database.database,
      schema: appConfig.database.schema,
      generatedAt: new Date().toISOString(),
      tableCount: normalizedTables.length,
      embeddingModelId: embeddingModelInfo.modelId,
      tables: normalizedTables,
    },
    reindexedTableCount,
    reusedIndexCount,
  };
}

/**
 * Sync the local schema catalog against the current database schema.
 */
export async function syncSchemaCatalog(
  appConfig: AppConfig,
  db: DatabaseAdapter,
  io?: Pick<AgentIO, "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; result: SchemaCatalogSyncResult }> {
  const previousCatalog = await loadSchemaCatalog(appConfig.database);
  const builtCatalog = await buildSchemaCatalog(appConfig, await db.getAllTableSchemas(), previousCatalog, io);
  const nextCatalog = builtCatalog.catalog;
  const previousTables = new Map(previousCatalog?.tables.map((table) => [table.tableName, table]) ?? []);
  const nextTables = new Map(nextCatalog.tables.map((table) => [table.tableName, table]));
  const addedTables: string[] = [];
  const updatedTables: string[] = [];
  const removedTables: string[] = [];
  let unchangedTableCount = 0;

  for (const table of nextCatalog.tables) {
    const previous = previousTables.get(table.tableName);
    if (!previous) {
      addedTables.push(table.tableName);
      continue;
    }

    if (previous.schemaHash !== table.schemaHash) {
      updatedTables.push(table.tableName);
      continue;
    }

    unchangedTableCount += 1;
  }

  for (const table of previousTables.values()) {
    if (!nextTables.has(table.tableName)) {
      removedTables.push(table.tableName);
    }
  }

  await saveSchemaCatalog(appConfig.database, nextCatalog);

  return {
    catalog: nextCatalog,
    result: {
      catalogPath: getSchemaCatalogPath(appConfig.database),
      generatedAt: nextCatalog.generatedAt,
      tableCount: nextCatalog.tableCount,
      addedTables,
      updatedTables,
      removedTables,
      unchangedTableCount,
      reindexedTableCount: builtCatalog.reindexedTableCount,
      reusedIndexCount: builtCatalog.reusedIndexCount,
    },
  };
}
