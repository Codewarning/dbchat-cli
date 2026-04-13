import { z } from "zod";
import {
  buildSchemaSummaryFromCatalog,
  findCatalogTable,
  suggestCatalogTableNames,
} from "../../schema/catalog.js";
import { ensureLocalSchemaCatalogReady, searchLocalSchemaCatalog } from "../../services/schema-catalog.js";
import type {
  LiveTableListResult,
  SchemaCatalog,
  SchemaCatalogSearchResult,
  SchemaSummary,
  TableSchema,
} from "../../types/index.js";
import {
  clipMiddle,
  clipText,
  stringifyCompact,
  summarizeCatalogMatches,
  summarizeColumns,
  summarizeTables,
  takeItemsByCharBudget,
} from "../serialize-helpers.js";
import { defineTool, type ToolRuntimeContext } from "../specs.js";

const MAX_PLAN_PREVIEW_CHARS = 2200;

const emptyArgsSchema = z.object({});

const searchSchemaCatalogSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

const describeTableSchema = z.object({
  tableName: z.string().min(1),
});

async function loadReadySchemaCatalog(context: ToolRuntimeContext): Promise<SchemaCatalog> {
  if (context.schemaCatalogCache) {
    return context.schemaCatalogCache;
  }

  const { catalog } = await ensureLocalSchemaCatalogReady(context.config, context.db, context.io);
  context.schemaCatalogCache = catalog;
  return catalog;
}

export const getSchemaSummaryTool = defineTool(
  {
    name: "get_schema_summary",
    description: "Get a compact overview of the current database schema from the local schema catalog.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  emptyArgsSchema,
  async (_args, context) => {
    context.io.log("Loading schema summary");
    const catalog = await loadReadySchemaCatalog(context);
    const summary = buildSchemaSummaryFromCatalog(catalog);
    context.io.log(`Schema summary loaded: ${summary.tables.length} tables`);
    return summary;
  },
  (result) => {
    const summary = result as SchemaSummary;
    const { items, omittedCount } = summarizeTables(summary);
    const payload = {
      dialect: summary.dialect,
      database: summary.database,
      schema: summary.schema,
      tableCount: summary.tables.length,
      tablesPreview: items,
      omittedTableCount: omittedCount,
    };
    const previewSummary = items.length ? ` Preview: ${items.join(", ")}${omittedCount ? ` (+${omittedCount} more)` : ""}` : "";

    return {
      content: stringifyCompact(payload),
      summary: `Schema summary loaded: ${payload.tableCount} tables.${previewSummary}`,
    };
  },
);

export const listLiveTablesTool = defineTool(
  {
    name: "list_live_tables",
    description:
      "Get the current live table names directly from the active database connection. Use this before destructive schema operations such as dropping or truncating all tables.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  emptyArgsSchema,
  async (_args, context) => {
    context.io.log("Loading live table list");
    const summary = await context.io.withLoading("Fetching live table list", () => context.db.getSchemaSummary({ includeRowCount: false }));
    const liveTables: LiveTableListResult = {
      dialect: summary.dialect,
      database: summary.database,
      schema: summary.schema,
      tableNames: summary.tables.map((table) => table.tableName),
    };
    context.io.log(`Live table list loaded: ${liveTables.tableNames.length} tables`);
    return liveTables;
  },
  (result) => {
    const liveTables = result as LiveTableListResult;
    const { items, omittedCount } = takeItemsByCharBudget(liveTables.tableNames, 1800);
    const payload = {
      dialect: liveTables.dialect,
      database: liveTables.database,
      schema: liveTables.schema,
      tableCount: liveTables.tableNames.length,
      tableNamesPreview: items,
      omittedTableCount: omittedCount,
    };
    const previewSummary = items.length ? ` Preview: ${items.join(", ")}${omittedCount ? ` (+${omittedCount} more)` : ""}` : "";

    return {
      content: stringifyCompact(payload),
      summary: `Live table list loaded: ${payload.tableCount} tables.${previewSummary}`,
    };
  },
);

export const searchSchemaCatalogTool = defineTool(
  {
    name: "search_schema_catalog",
    description: "Search the local schema catalog for relevant tables before inspecting a specific table.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Keywords describing the business concept, table name, or columns you are looking for.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of candidate tables to return.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
    },
  },
  searchSchemaCatalogSchema,
  async (args, context) => {
    const catalog = await loadReadySchemaCatalog(context);
    const limit = Math.min(args.limit ?? 5, 10);
    context.io.log(`Searching schema catalog: ${args.query}`);
    const result = await searchLocalSchemaCatalog(context.config, catalog, args.query, limit);
    context.io.log(`Schema catalog search found ${result.totalMatches} matches`);
    return result;
  },
  (result) => {
    const search = result as SchemaCatalogSearchResult;
    const { items, omittedCount } = summarizeCatalogMatches(search);
    const payload = {
      query: search.query,
      totalMatches: search.totalMatches,
      topMatches: search.matches.slice(0, 5).map((match) => ({
        tableName: match.tableName,
        description: clipText(match.description, 120),
        tags: match.tags.slice(0, 5),
        matchedColumns: match.matchedColumns.slice(0, 5),
        matchReasons: match.matchReasons.slice(0, 5),
        score: match.score,
        keywordScore: match.keywordScore,
        semanticScore: match.semanticScore,
      })),
      matchesPreview: items,
      omittedMatchCount: omittedCount,
    };
    const previewSummary = items.length ? ` Top matches: ${items.join(", ")}${omittedCount ? ` (+${omittedCount} more)` : ""}` : "";

    return {
      content: stringifyCompact(payload),
      summary: `Schema catalog search: ${search.totalMatches} matches for "${clipText(search.query, 80)}".${previewSummary}`,
    };
  },
);

export const describeTableTool = defineTool(
  {
    name: "describe_table",
    description: "Inspect the schema of a single table. Use this after searching the schema catalog or when the table name is already known.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        tableName: {
          type: "string",
          description: "The table name to inspect.",
        },
      },
      required: ["tableName"],
    },
  },
  describeTableSchema,
  async (args, context) => {
    context.io.log(`Describing table: ${args.tableName}`);
    const catalog = await loadReadySchemaCatalog(context);
    const catalogTable = findCatalogTable(catalog, args.tableName);
    if (!catalogTable) {
      const suggestions = suggestCatalogTableNames(catalog, args.tableName, 4);
      const suggestionSuffix = suggestions.length ? ` Similar tables in the current schema catalog: ${suggestions.join(", ")}.` : "";
      throw new Error(
        `Table '${args.tableName}' is not present in the current schema catalog. Use an exact table name returned by search_schema_catalog.${suggestionSuffix}`,
      );
    }

    const schema = await context.io.withLoading(`Loading schema for table ${catalogTable.tableName}`, () => context.db.describeTable(catalogTable.tableName));
    context.io.log(`Table loaded: ${catalogTable.tableName}, ${schema.columns.length} columns`);
    return schema;
  },
  (result) => {
    const schema = result as TableSchema;
    const { items, omittedCount } = summarizeColumns(schema.columns);
    const payload = {
      tableName: schema.tableName,
      ddlPreview: schema.ddlPreview ? clipMiddle(schema.ddlPreview, MAX_PLAN_PREVIEW_CHARS) : undefined,
      ddlSource: schema.ddlSource,
      columnsPreview: items,
      omittedColumnCount: omittedCount,
    };
    const previewSummary = schema.ddlPreview
      ? ` ${schema.ddlSource === "native" ? "Native" : "Reconstructed"} DDL preview: ${clipMiddle(schema.ddlPreview, 220)}`
      : items.length
        ? ` Preview: ${items.join(", ")}${omittedCount ? ` (+${omittedCount} more)` : ""}`
        : "";

    return {
      content: stringifyCompact(payload),
      summary: `Table described: ${schema.tableName} with ${schema.columns.length} columns.${previewSummary}`,
    };
  },
);
