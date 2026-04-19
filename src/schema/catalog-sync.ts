import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "../db/adapter.js";
import { embedTexts } from "../embedding/client.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import type { AgentIO, AppConfig, SchemaCatalog, SchemaCatalogSyncResult, SchemaCatalogTable, TableColumn, TableSchema } from "../types/index.js";
import { buildCatalogDocuments } from "./catalog-documents.js";
import { buildTableEmbeddingText } from "./catalog-enrichment.js";
import { applyMergedCatalogMetadata, mergeCatalogTableMetadata } from "./catalog-merge.js";
import { archiveStaleTableInstructionFiles, ensureScopedInstructionFiles, loadScopedInstructionBundle } from "../instructions/scoped.js";
import {
  getSchemaCatalogPath,
  loadSchemaCatalog,
  saveSchemaCatalog,
  SCHEMA_CATALOG_VERSION,
} from "./catalog-storage.js";

const MAX_SUMMARY_COLUMNS = 8;
const MAX_TABLE_INSTRUCTION_CONTEXT_CHARS = 1200;

/**
 * Serialize table schema fields deterministically before hashing them.
 */
function serializeTableForHash(table: TableSchema): string {
  return JSON.stringify({
    tableName: table.tableName,
    comment: table.comment ?? null,
    columns: table.columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      isNullable: column.isNullable,
      defaultValue: column.defaultValue,
      comment: column.comment ?? null,
    })),
    relations: (table.relations ?? []).map((relation) => ({
      toTable: relation.toTable,
      fromColumns: relation.fromColumns,
      toColumns: relation.toColumns ?? [],
      type: relation.type,
      description: relation.description ?? null,
      source: relation.source,
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
  const comment = column.comment ? ` comment=${column.comment.replace(/\s+/g, " ").trim()}` : "";
  return `${column.name} ${column.dataType} ${nullable}${defaultValue}${comment}`;
}

/**
 * Build the human-readable summary text stored for one table.
 */
function buildTableSummaryText(table: TableSchema): string {
  const preview = table.columns.slice(0, MAX_SUMMARY_COLUMNS).map(buildColumnPreview).join("; ");
  const omitted = table.columns.length > MAX_SUMMARY_COLUMNS ? `; +${table.columns.length - MAX_SUMMARY_COLUMNS} more columns` : "";
  const comment = table.comment ? ` comment=${table.comment.replace(/\s+/g, " ").trim()}` : "";
  return `${table.tableName}: ${table.columns.length} columns.${comment ? ` ${comment}.` : ""} ${preview}${omitted}`.trim();
}

/**
 * Compute the stable schema hash for one table.
 */
function computeSchemaHash(table: TableSchema): string {
  return createHash("sha256").update(serializeTableForHash(table)).digest("hex");
}

function clipInstructionContext(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= MAX_TABLE_INSTRUCTION_CONTEXT_CHARS
    ? normalized
    : `${normalized.slice(0, Math.max(0, MAX_TABLE_INSTRUCTION_CONTEXT_CHARS - 3))}...`;
}

function buildBaseCatalogTable(
  table: TableSchema,
  metadata: ReturnType<typeof mergeCatalogTableMetadata>,
  instructionContext?: string,
): SchemaCatalogTable {
  return applyMergedCatalogMetadata(
    {
      tableName: table.tableName,
      schemaHash: computeSchemaHash(table),
      summaryText: buildTableSummaryText(table),
      ddlPreview: table.ddlPreview,
      ddlSource: table.ddlSource,
      instructionContext,
    },
    metadata,
  );
}

async function addEmbeddingsToCatalogTables(
  appConfig: AppConfig,
  tables: SchemaCatalogTable[],
  previousCatalog: SchemaCatalog | null,
): Promise<{ tables: SchemaCatalogTable[]; embeddingModelId: string | null; reindexedTableCount: number; reusedIndexCount: number }> {
  const embeddingEnabled = Boolean(appConfig.embedding.apiKey.trim());
  if (!embeddingEnabled) {
    return {
      tables,
      embeddingModelId: null,
      reindexedTableCount: 0,
      reusedIndexCount: 0,
    };
  }

  const embeddingModelInfo = getEmbeddingModelInfo(appConfig.embedding);
  const previousTables = new Map(previousCatalog?.tables.map((table) => [table.tableName, table]) ?? []);
  const canReusePreviousVectors = previousCatalog?.embeddingModelId === embeddingModelInfo.modelId;
  const textsToEmbed: string[] = [];
  const tableIndexesToEmbed: number[] = [];
  let reusedIndexCount = 0;

  const nextTables = tables.map((table, index) => {
    const embeddingText = buildTableEmbeddingText({
      tableName: table.tableName,
      description: table.description,
      tags: table.tags,
      instructionContext: table.instructionContext,
      columns: table.columns,
      dbComment: table.dbComment,
      businessName: table.businessName,
      aliases: table.aliases,
      examples: table.examples,
      relations: table.relations,
    });
    const previousTable = canReusePreviousVectors ? previousTables.get(table.tableName) : undefined;

    if (
      previousTable &&
      previousTable.schemaHash === table.schemaHash &&
      previousTable.embeddingText === embeddingText &&
      previousTable.embeddingVector?.length
    ) {
      reusedIndexCount += 1;
      return {
        ...table,
        embeddingText,
        embeddingVector: previousTable.embeddingVector,
      };
    }

    textsToEmbed.push(embeddingText);
    tableIndexesToEmbed.push(index);
    return {
      ...table,
      embeddingText,
    };
  });

  if (!textsToEmbed.length) {
    return {
      tables: nextTables,
      embeddingModelId: embeddingModelInfo.modelId,
      reindexedTableCount: 0,
      reusedIndexCount,
    };
  }

  const embeddingVectors = await embedTexts(textsToEmbed, {
    config: appConfig.embedding,
  });

  for (let index = 0; index < tableIndexesToEmbed.length; index += 1) {
    const tableIndex = tableIndexesToEmbed[index];
    nextTables[tableIndex] = {
      ...nextTables[tableIndex],
      embeddingVector: embeddingVectors[index],
    };
  }

  return {
    tables: nextTables,
    embeddingModelId: embeddingModelInfo.modelId,
    reindexedTableCount: textsToEmbed.length,
    reusedIndexCount,
  };
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
 * Return the already-built local schema catalog when present.
 */
export async function ensureSchemaCatalogReady(
  appConfig: AppConfig,
  io: Pick<AgentIO, "log" | "withLoading" | "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; refreshed: boolean; result: SchemaCatalogSyncResult | null }> {
  const existingCatalog = await loadSchemaCatalog(appConfig.database);
  if (!existingCatalog) {
    throw new Error(
      "No local schema catalog is available for the current database. Reload the database to initialize it automatically, or run `dbchat catalog sync`.",
    );
  }

  io.log(`Using existing local schema catalog: ${existingCatalog.tableCount} tables, ${existingCatalog.documentCount} documents`);
  return {
    catalog: existingCatalog,
    refreshed: false,
    result: null,
  };
}

/**
 * Build the local schema catalog when the active database is first loaded and no stored snapshot exists yet.
 */
export async function initializeSchemaCatalogOnEntry(
  appConfig: AppConfig,
  db: DatabaseAdapter,
  io: Pick<AgentIO, "log" | "withLoading" | "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; refreshed: boolean; result: SchemaCatalogSyncResult | null }> {
  const existingCatalog = await loadSchemaCatalog(appConfig.database);
  if (existingCatalog) {
    io.log(`Using existing local schema catalog: ${existingCatalog.tableCount} tables, ${existingCatalog.documentCount} documents`);
    return {
      catalog: existingCatalog,
      refreshed: false,
      result: null,
    };
  }

  io.log("Local schema catalog is missing. Building it now.");
  const synced = await io.withLoading("Refreshing schema catalog", () => syncSchemaCatalog(appConfig, db, io));
  io.log(
    `Schema catalog ready: ${synced.result.tableCount} tables, ${synced.result.documentCount} documents, +${synced.result.addedTables.length} added, ~${synced.result.updatedTables.length} updated, -${synced.result.removedTables.length} removed`,
  );
  return {
    catalog: synced.catalog,
    refreshed: true,
    result: synced.result,
  };
}

async function buildSchemaCatalog(
  appConfig: AppConfig,
  tables: TableSchema[],
  previousCatalog?: SchemaCatalog | null,
): Promise<{ catalog: SchemaCatalog; reindexedTableCount: number; reusedIndexCount: number }> {
  const instructionBundle = await loadScopedInstructionBundle(appConfig.database, "catalog");
  const instructionContext = clipInstructionContext(instructionBundle.mergedText);
  const baseTables = tables
    .sort((left, right) => left.tableName.localeCompare(right.tableName))
    .map((table) => buildBaseCatalogTable(table, mergeCatalogTableMetadata(table), instructionContext));

  const enriched = await addEmbeddingsToCatalogTables(appConfig, baseTables, previousCatalog ?? null);
  const documents = buildCatalogDocuments(enriched.tables);

  return {
    catalog: {
      version: SCHEMA_CATALOG_VERSION,
      dialect: appConfig.database.dialect,
      host: appConfig.database.host,
      port: appConfig.database.port,
      database: appConfig.database.database,
      schema: appConfig.database.schema,
      generatedAt: new Date().toISOString(),
      tableCount: enriched.tables.length,
      documentCount: documents.length,
      instructionFingerprint: instructionBundle.fingerprint,
      embeddingModelId: enriched.embeddingModelId,
      tables: enriched.tables,
      documents,
    },
    reindexedTableCount: enriched.reindexedTableCount,
    reusedIndexCount: enriched.reusedIndexCount,
  };
}

/**
 * Sync the local schema catalog against the current database schema.
 */
export async function syncSchemaCatalog(
  appConfig: AppConfig,
  db: DatabaseAdapter,
  _io?: Pick<AgentIO, "createProgressHandle">,
): Promise<{ catalog: SchemaCatalog; result: SchemaCatalogSyncResult }> {
  const previousCatalog = await loadSchemaCatalog(appConfig.database);
  const liveTables = await db.getAllTableSchemas();
  await archiveStaleTableInstructionFiles(
    appConfig.database,
    liveTables.map((table) => table.tableName),
  );
  await ensureScopedInstructionFiles(
    appConfig.database,
    liveTables.map((table) => table.tableName),
  );
  const builtCatalog = await buildSchemaCatalog(appConfig, liveTables, previousCatalog);
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

    if (
      previous.schemaHash !== table.schemaHash ||
      previous.description !== table.description ||
      previous.tags.join("|") !== table.tags.join("|") ||
      previous.aliases.join("|") !== table.aliases.join("|") ||
      (previous.instructionContext ?? "") !== (table.instructionContext ?? "")
    ) {
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
      documentCount: nextCatalog.documentCount,
      addedTables,
      updatedTables,
      removedTables,
      unchangedTableCount,
      reindexedTableCount: builtCatalog.reindexedTableCount,
      reusedIndexCount: builtCatalog.reusedIndexCount,
      semanticIndexEnabled: Boolean(nextCatalog.embeddingModelId),
    },
  };
}
