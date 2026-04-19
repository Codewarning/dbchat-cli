import type {
  EmbeddingConfig,
  SchemaCatalog,
  SchemaCatalogSearchMatch,
  SchemaCatalogSearchResult,
  SchemaCatalogTable,
  SchemaSummary,
} from "../types/index.js";
import { scoreCatalogDocumentsWithBm25 } from "./catalog-bm25.js";
import { tokenizeCatalogText, uniqueTokens } from "./catalog-tokens.js";

function scoreTableNameSimilarity(table: SchemaCatalogTable, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const queryTokens = tokenizeCatalogText(normalizedQuery);
  const tableNameLower = table.tableName.toLowerCase();
  const tableTokens = uniqueTokens(tokenizeCatalogText(table.tableName));
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

    if (table.aliases.some((alias) => alias.toLowerCase().includes(token))) {
      score += 10;
    }
  }

  const lastQueryToken = [...queryTokens].reverse().find((token) => !/[_\-.]/.test(token));
  if (lastQueryToken && tableTokens.includes(lastQueryToken)) {
    score += 40;
  }

  return score;
}

function computeExactKeywordBoost(table: SchemaCatalogTable, query: string, queryTokens: string[]): {
  score: number;
  matchedAliases: string[];
  matchedColumns: string[];
  reasons: string[];
} {
  const normalizedQuery = query.trim().toLowerCase();
  const tableNameLower = table.tableName.toLowerCase();
  let score = 0;
  const matchedAliases: string[] = [];
  const matchedColumns: string[] = [];
  const reasons: string[] = [];

  if (tableNameLower === normalizedQuery) {
    score += 180;
    reasons.push("exact table name");
  } else if (tableNameLower.startsWith(normalizedQuery)) {
    score += 120;
    reasons.push("table name prefix");
  } else if (tableNameLower.includes(normalizedQuery)) {
    score += 90;
    reasons.push("table name contains query");
  }

  for (const alias of table.aliases) {
    const aliasLower = alias.toLowerCase();
    if (aliasLower === normalizedQuery) {
      score += 150;
      matchedAliases.push(alias);
      reasons.push("exact alias match");
      continue;
    }

    if (queryTokens.some((token) => token && aliasLower.includes(token))) {
      score += 45;
      matchedAliases.push(alias);
      reasons.push("alias overlap");
    }
  }

  for (const column of table.columns) {
    const columnNameLower = column.name.toLowerCase();
    const columnAliases = column.aliases ?? [];
    const columnMatched =
      columnNameLower === normalizedQuery ||
      queryTokens.some(
        (token) =>
          columnNameLower.includes(token) ||
          columnAliases.some((alias) => alias.toLowerCase().includes(token)) ||
          (column.comment?.toLowerCase().includes(token) ?? false) ||
          (column.description?.toLowerCase().includes(token) ?? false),
      );

    if (!columnMatched) {
      continue;
    }

    matchedColumns.push(column.name);
    score += columnNameLower === normalizedQuery ? 30 : 14;
  }

  if (matchedColumns.length) {
    reasons.push("column overlap");
  }

  return {
    score,
    matchedAliases: uniqueTokens(matchedAliases),
    matchedColumns: uniqueTokens(matchedColumns),
    reasons: uniqueTokens(reasons),
  };
}

/**
 * Preserve the old compatibility helper for callers that still want to reason about embedding reuse.
 */
export function isSchemaCatalogCompatible(catalog: SchemaCatalog, embeddingConfig: EmbeddingConfig): boolean {
  if (!catalog.embeddingModelId) {
    return true;
  }

  return catalog.embeddingModelId === `${embeddingConfig.provider}:${embeddingConfig.model.trim()}@${embeddingConfig.baseUrl.trim().replace(/\/$/, "")}`;
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
 * Search the local schema catalog using exact matching plus BM25 document recall.
 */
export async function searchSchemaCatalog(
  catalog: SchemaCatalog,
  query: string,
  limit = 5,
): Promise<SchemaCatalogSearchResult> {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return {
      query,
      totalMatches: 0,
      isAmbiguous: false,
      clarificationCandidates: [],
      matches: [],
    };
  }

  const queryTokens = uniqueTokens(tokenizeCatalogText(normalizedQuery));
  const tableMatches = new Map<
    string,
    {
      table: SchemaCatalogTable;
      keywordScore: number;
      matchedAliases: Set<string>;
      matchedColumns: Set<string>;
      matchReasons: Set<string>;
      documentKinds: Set<string>;
      matchedSources: Set<string>;
    }
  >();

  for (const table of catalog.tables) {
    const exactBoost = computeExactKeywordBoost(table, normalizedQuery, queryTokens);
    if (exactBoost.score <= 0) {
      continue;
    }

    tableMatches.set(table.tableName, {
      table,
      keywordScore: exactBoost.score,
      matchedAliases: new Set(exactBoost.matchedAliases),
      matchedColumns: new Set(exactBoost.matchedColumns),
      matchReasons: new Set(exactBoost.reasons),
      documentKinds: new Set<string>(),
      matchedSources: new Set<string>(),
    });
  }

  const documentScores = scoreCatalogDocumentsWithBm25(catalog.documents, normalizedQuery, Math.max(25, normalizedLimit * 8));
  const kindWeights: Record<string, number> = {
    table: 1.25,
    column: 1.05,
    relation: 0.9,
  };

  for (const docScore of documentScores) {
    const table = catalog.tables.find((entry) => entry.tableName === docScore.document.tableName);
    if (!table) {
      continue;
    }

    const existing =
      tableMatches.get(table.tableName) ??
      {
        table,
        keywordScore: 0,
        matchedAliases: new Set<string>(),
        matchedColumns: new Set<string>(),
        matchReasons: new Set<string>(),
        documentKinds: new Set<string>(),
        matchedSources: new Set<string>(),
      };

    existing.keywordScore += Number((docScore.score * (kindWeights[docScore.document.kind] ?? 1)).toFixed(4));
    existing.documentKinds.add(docScore.document.kind);
    existing.matchedSources.add(docScore.document.source);

    if (docScore.document.kind === "column" && docScore.document.fieldName) {
      existing.matchedColumns.add(docScore.document.fieldName);
      existing.matchReasons.add("column document match");
    } else if (docScore.document.kind === "relation") {
      existing.matchReasons.add("relation match");
    } else {
      existing.matchReasons.add("table document match");
    }
    tableMatches.set(table.tableName, existing);
  }

  const rankedMatches = Array.from(tableMatches.values())
    .map((entry): SchemaCatalogSearchMatch => ({
      tableName: entry.table.tableName,
      summaryText: entry.table.summaryText,
      description: entry.table.description,
      tags: entry.table.tags,
      matchedColumns: Array.from(entry.matchedColumns).slice(0, 5),
      matchedAliases: Array.from(entry.matchedAliases).slice(0, 5),
      matchReasons: Array.from(entry.matchReasons).slice(0, 5),
      documentKinds: Array.from(entry.documentKinds).slice(0, 5),
      matchedSources: Array.from(entry.matchedSources).slice(0, 5),
      keywordScore: Number(entry.keywordScore.toFixed(4)),
      semanticScore: 0,
      score: Number(entry.keywordScore.toFixed(4)),
    }))
    .sort((left, right) => right.score - left.score || left.tableName.localeCompare(right.tableName));

  const bestScore = rankedMatches[0]?.score ?? 0;
  const minimumScore = Math.max(3, bestScore * 0.4);
  const filteredMatches = rankedMatches.filter((match) => match.score >= minimumScore).slice(0, normalizedLimit);
  const bestMatch = filteredMatches[0];
  const secondMatch = filteredMatches[1];
  const isAmbiguous = Boolean(bestMatch && secondMatch && secondMatch.score >= bestMatch.score * 0.9);
  const clarificationCandidates = filteredMatches.slice(0, 3).map((match) => match.tableName);

  return {
    query,
    totalMatches: filteredMatches.length,
    isAmbiguous,
    ambiguityReason: isAmbiguous
      ? `Top table candidates are close in score for "${normalizedQuery}". Clarify which table the user means before assuming one exact table.`
      : undefined,
    clarificationCandidates,
    matches: filteredMatches,
  };
}
