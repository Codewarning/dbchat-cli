import type { SchemaCatalogDocument, SchemaCatalogTable } from "../types/index.js";
import { tokenizeCatalogText } from "./catalog-tokens.js";

function createDocument(
  id: string,
  tableName: string,
  kind: SchemaCatalogDocument["kind"],
  title: string,
  content: string,
  source: SchemaCatalogDocument["source"],
  fieldName?: string,
): SchemaCatalogDocument {
  return {
    id,
    tableName,
    kind,
    title,
    content,
    source,
    fieldName,
    tokens: tokenizeCatalogText([title, content].join("\n")),
  };
}

function buildTableDocument(table: SchemaCatalogTable): SchemaCatalogDocument {
  const lines = [
    `table_name: ${table.tableName}`,
    table.businessName ? `business_name: ${table.businessName}` : "",
    table.dbComment ? `db_comment: ${table.dbComment}` : "",
    table.instructionContext ? `scoped_instructions: ${table.instructionContext}` : "",
    `description: ${table.description}`,
    table.aliases.length ? `aliases: ${table.aliases.join(" ")}` : "",
    table.tags.length ? `tags: ${table.tags.join(" ")}` : "",
    table.columns.length ? `columns: ${table.columns.map((column) => column.name).join(" ")}` : "",
    table.columns.some((column) => column.comment || column.description)
      ? `column_notes: ${table.columns
          .flatMap((column) => [column.comment ?? "", column.description ?? "", ...(column.aliases ?? [])])
          .filter(Boolean)
          .join(" ")}`
      : "",
    table.relations.length
      ? `relations: ${table.relations
          .map((relation) => `${relation.type} ${relation.fromColumns.join(",")} -> ${relation.toTable}${relation.toColumns?.length ? `(${relation.toColumns.join(",")})` : ""}`)
          .join("; ")}`
      : "",
    table.examples.length ? `examples: ${table.examples.join("; ")}` : "",
  ].filter(Boolean);

  return createDocument(`table:${table.tableName}`, table.tableName, "table", table.tableName, lines.join("\n"), "generated");
}

function buildColumnDocuments(table: SchemaCatalogTable): SchemaCatalogDocument[] {
  return table.columns
    .filter((column) => column.comment || column.description || (column.aliases?.length ?? 0) > 0)
    .map((column) =>
      createDocument(
        `column:${table.tableName}:${column.name}`,
        table.tableName,
        "column",
        `${table.tableName}.${column.name}`,
        [
          `table_name: ${table.tableName}`,
          `column_name: ${column.name}`,
          `data_type: ${column.dataType}`,
          table.aliases.length ? `table_aliases: ${table.aliases.join(" ")}` : "",
          column.comment ? `db_comment: ${column.comment}` : "",
          column.description ? `description: ${column.description}` : "",
          column.aliases?.length ? `aliases: ${column.aliases.join(" ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "database",
        column.name,
      ),
    );
}

function buildRelationDocuments(table: SchemaCatalogTable): SchemaCatalogDocument[] {
  return table.relations.map((relation) =>
    createDocument(
      `relation:${table.tableName}:${relation.toTable}:${relation.fromColumns.join(",")}`,
      table.tableName,
      "relation",
      `${table.tableName} -> ${relation.toTable}`,
      [
        `from_table: ${table.tableName}`,
        `to_table: ${relation.toTable}`,
        `type: ${relation.type}`,
        relation.fromColumns.length ? `via: ${relation.fromColumns.join(" ")}` : "",
        relation.toColumns?.length ? `to_columns: ${relation.toColumns.join(" ")}` : "",
        relation.description ? `description: ${relation.description}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "database",
    ),
  );
}

/**
 * Build search documents from merged table entries so recall can happen below the table granularity.
 */
export function buildCatalogDocuments(tables: SchemaCatalogTable[]): SchemaCatalogDocument[] {
  const documents: SchemaCatalogDocument[] = [];

  for (const table of tables) {
    documents.push(buildTableDocument(table));
    documents.push(...buildColumnDocuments(table));
    documents.push(...buildRelationDocuments(table));
  }

  return documents;
}
