import type { SchemaCatalogTable, TableColumn, TableRelation, TableSchema } from "../types/index.js";
import { buildLocalSearchTags, uniqueTokens } from "./catalog-tokens.js";

export interface MergedCatalogTableMetadata {
  dbComment?: string | null;
  description: string;
  tags: string[];
  aliases: string[];
  examples: string[];
  columns: TableColumn[];
  relations: TableRelation[];
}

function normalizeColumns(table: TableSchema): TableColumn[] {
  return table.columns.map((column) => ({
    ...column,
    aliases: column.aliases ?? [],
  }));
}

function normalizeRelations(table: TableSchema): TableRelation[] {
  return (table.relations ?? []).map((relation) => ({
    ...relation,
    source: "database",
  }));
}

/**
 * Derive local search metadata directly from database schema facts.
 */
export function mergeCatalogTableMetadata(table: TableSchema): MergedCatalogTableMetadata {
  const columns = normalizeColumns(table);
  const relations = normalizeRelations(table);
  const description = table.comment ?? `Table ${table.tableName} with ${table.columns.length} columns.`;
  const aliases: string[] = [];
  const examples: string[] = [];
  const localTags = buildLocalSearchTags([
    table.tableName,
    table.comment ?? "",
    description,
    ...columns.flatMap((column) => [column.name, column.comment ?? "", column.description ?? "", ...(column.aliases ?? [])]),
    ...relations.flatMap((relation) => [relation.toTable, relation.description ?? "", ...relation.fromColumns, ...(relation.toColumns ?? [])]),
  ]);

  return {
    dbComment: table.comment ?? null,
    description,
    tags: uniqueTokens(localTags).slice(0, 8),
    aliases,
    examples,
    columns,
    relations,
  };
}

/**
 * Apply derived metadata to one persisted catalog table entry.
 */
export function applyMergedCatalogMetadata(
  table: Omit<SchemaCatalogTable, "dbComment" | "businessName" | "description" | "tags" | "aliases" | "examples" | "columns" | "relations">,
  metadata: MergedCatalogTableMetadata,
): SchemaCatalogTable {
  return {
    ...table,
    dbComment: metadata.dbComment,
    description: metadata.description,
    tags: metadata.tags,
    aliases: metadata.aliases,
    examples: metadata.examples,
    columns: metadata.columns,
    relations: metadata.relations,
  };
}
