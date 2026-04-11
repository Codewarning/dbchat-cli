import { embedText } from "../embedding/client.js";
import { getEmbeddingModelInfo } from "../embedding/model.js";
import type {
  AgentIO,
  SchemaCatalog,
  SchemaCatalogSearchMatch,
  SchemaCatalogSearchResult,
  SchemaCatalogTable,
  SchemaSummary,
} from "../types/index.js";

/**
 * Tokenize free-form search text while handling camelCase and deduplicating terms.
 */
function tokenize(value: string): string[] {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return Array.from(new Set(normalized.match(/[a-z0-9]+/g) ?? []));
}

function scoreTableNameSimilarity(table: SchemaCatalogTable, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const queryTokens = tokenize(normalizedQuery);
  const tableNameLower = table.tableName.toLowerCase();
  const tableTokens = tokenize(table.tableName);
  let score = 0;

  if (tableNameLower === normalizedQuery) {
    score += 1000;
  } else if (tableNameLower.startsWith(normalizedQuery)) {
    score += 120;
  } else if (tableNameLower.includes(normalizedQuery)) {
    score += 80;
  }

  for (const token of queryTokens) {
    if (tableNameLower.includes(token)) {
      score += 24;
    }

    if (table.columns.some((column) => column.name.toLowerCase().includes(token))) {
      score += 8;
    }
  }

  const lastQueryToken = queryTokens[queryTokens.length - 1];
  if (lastQueryToken && tableTokens.includes(lastQueryToken)) {
    score += 40;
  }

  return score;
}

/**
 * Compute cosine similarity between two embedding vectors.
 */
function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Ensure the persisted catalog was built with the current embedding model.
 */
export function isSchemaCatalogCompatible(catalog: SchemaCatalog): boolean {
  return catalog.embeddingModelUrl === getEmbeddingModelInfo().modelId;
}

/**
 * Ensure the persisted catalog was built with the current embedding model.
 */
function ensureCatalogEmbeddingCompatibility(catalog: SchemaCatalog): void {
  if (!isSchemaCatalogCompatible(catalog)) {
    throw new Error("The local schema catalog was built with a different embedding model. Run 'dbchat catalog sync' to rebuild it.");
  }
}

/**
 * Pick a small set of columns whose names overlap with the query text.
 */
function pickMatchedColumns(table: SchemaCatalogTable, queryLower: string, queryTokens: string[]): string[] {
  const matched = table.columns
    .filter((column) => {
      const columnName = column.name.toLowerCase();
      return columnName === queryLower || columnName.includes(queryLower) || queryTokens.some((token) => columnName.includes(token));
    })
    .slice(0, 5)
    .map((column) => column.name);

  return Array.from(new Set(matched));
}

/**
 * Score one catalog table against the search query using keyword and semantic signals.
 */
function scoreCatalogTable(table: SchemaCatalogTable, query: string, queryVector: readonly number[]): SchemaCatalogSearchMatch | null {
  const queryLower = query.trim().toLowerCase();
  const queryTokens = tokenize(queryLower);
  if (!queryLower || !queryTokens.length) {
    return null;
  }

  const tableNameLower = table.tableName.toLowerCase();
  const tableTokens = tokenize(table.tableName);
  const columnNamesLower = table.columns.map((column) => column.name.toLowerCase());
  const summaryLower = table.summaryText.toLowerCase();
  const descriptionLower = table.description.toLowerCase();
  const tagsLower = table.tags.map((tag) => tag.toLowerCase());
  let keywordScore = 0;
  const matchReasons: string[] = [];

  if (tableNameLower === queryLower) {
    keywordScore += 180;
    matchReasons.push("exact table name");
  } else if (tableNameLower.startsWith(queryLower)) {
    keywordScore += 120;
    matchReasons.push("table name prefix");
  } else if (tableNameLower.includes(queryLower)) {
    keywordScore += 90;
    matchReasons.push("table name contains query");
  }

  for (const token of queryTokens) {
    if (tableTokens.includes(token)) {
      keywordScore += 30;
    }

    if (columnNamesLower.some((name) => name === token)) {
      keywordScore += 25;
    } else if (columnNamesLower.some((name) => name.includes(token))) {
      keywordScore += 12;
    }

    if (tagsLower.includes(token)) {
      keywordScore += 28;
      matchReasons.push("tag match");
    } else if (tagsLower.some((tag) => tag.includes(token))) {
      keywordScore += 14;
      matchReasons.push("partial tag match");
    }

    if (descriptionLower.includes(token)) {
      keywordScore += 10;
      matchReasons.push("description overlap");
    }

    if (summaryLower.includes(token)) {
      keywordScore += 4;
    }
  }

  const matchedColumns = pickMatchedColumns(table, queryLower, queryTokens);
  if (matchedColumns.length) {
    matchReasons.push("column name overlap");
  }

  const semanticScore = cosineSimilarity(queryVector, table.embeddingVector);
  if (semanticScore >= 0.5) {
    matchReasons.push("semantic similarity");
  }

  if (keywordScore === 0 && semanticScore < 0.45) {
    return null;
  }

  const score = Number((semanticScore * 100 + keywordScore).toFixed(4));
  if (score <= 0) {
    return null;
  }

  return {
    tableName: table.tableName,
    summaryText: table.summaryText,
    description: table.description,
    tags: table.tags,
    matchedColumns,
    matchReasons: Array.from(new Set(matchReasons)),
    score,
    semanticScore: Number(semanticScore.toFixed(4)),
    keywordScore,
  };
}

/**
 * Convert a local schema catalog into the compact schema summary used by CLI tools.
 */
export function buildSchemaSummaryFromCatalog(catalog: SchemaCatalog): SchemaSummary {
  return {
    dialect: catalog.dialect,
    database: catalog.database,
    schema: catalog.schema,
    tables: catalog.tables.map((table) => ({
      tableName: table.tableName,
    })),
  };
}

/**
 * Resolve one exact table match inside the local schema catalog.
 */
export function findCatalogTable(catalog: SchemaCatalog, tableName: string): SchemaCatalogTable | null {
  const normalizedName = tableName.trim().toLowerCase();
  if (!normalizedName) {
    return null;
  }

  return catalog.tables.find((table) => table.tableName.toLowerCase() === normalizedName) ?? null;
}

/**
 * Suggest a small set of likely table names when the requested one is not present.
 */
export function suggestCatalogTableNames(catalog: SchemaCatalog, query: string, limit = 5): string[] {
  return catalog.tables
    .map((table) => ({
      tableName: table.tableName,
      score: scoreTableNameSimilarity(table, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.tableName.localeCompare(right.tableName))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.tableName);
}

/**
 * Search the local schema catalog using keyword and semantic ranking.
 */
export async function searchSchemaCatalog(
  catalog: SchemaCatalog,
  query: string,
  limit = 5,
  io?: Pick<AgentIO, "createProgressHandle">,
): Promise<SchemaCatalogSearchResult> {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return {
      query,
      totalMatches: 0,
      matches: [],
    };
  }

  ensureCatalogEmbeddingCompatibility(catalog);
  const queryVector = await embedText(normalizedQuery, {
    createModelDownloadProgressHandle: (message) => io?.createProgressHandle?.(message),
  });
  const rankedMatches = catalog.tables
    .map((table) => scoreCatalogTable(table, normalizedQuery, queryVector))
    .filter((entry): entry is SchemaCatalogSearchMatch => Boolean(entry))
    .sort((left, right) => right.score - left.score || left.tableName.localeCompare(right.tableName));
  const bestScore = rankedMatches[0]?.score ?? 0;
  const minimumScore = Math.max(20, bestScore * 0.55);
  let filteredMatches = rankedMatches.filter((match) => match.score >= minimumScore);
  if (filteredMatches.length > 0 && filteredMatches.every((match) => match.keywordScore === 0)) {
    filteredMatches = filteredMatches.filter((match) => match.semanticScore >= 0.6);
  }

  return {
    query,
    totalMatches: filteredMatches.length,
    matches: filteredMatches.slice(0, normalizedLimit),
  };
}
