import type { SchemaCatalogDocument } from "../types/index.js";
import { tokenizeCatalogText, uniqueTokens } from "./catalog-tokens.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface CatalogDocumentScore {
  document: SchemaCatalogDocument;
  score: number;
  matchedTokens: string[];
}

function buildTermFrequency(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

/**
 * Score local catalog documents with BM25 using the pre-tokenized document payloads.
 */
export function scoreCatalogDocumentsWithBm25(
  documents: readonly SchemaCatalogDocument[],
  query: string,
  limit = 40,
): CatalogDocumentScore[] {
  const queryTokens = uniqueTokens(tokenizeCatalogText(query));
  if (!queryTokens.length || !documents.length) {
    return [];
  }

  const documentCount = documents.length;
  const averageDocumentLength =
    documents.reduce((total, document) => total + document.tokens.length, 0) / Math.max(1, documents.length);
  const documentFrequencies = new Map<string, number>();

  for (const document of documents) {
    for (const token of new Set(document.tokens)) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }

  return documents
    .map((document) => {
      const termFrequency = buildTermFrequency(document.tokens);
      let score = 0;
      const matchedTokens: string[] = [];

      for (const token of queryTokens) {
        const frequency = termFrequency.get(token) ?? 0;
        if (!frequency) {
          continue;
        }

        matchedTokens.push(token);
        const documentFrequency = documentFrequencies.get(token) ?? 0;
        const inverseDocumentFrequency = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const normalizedFrequency =
          (frequency * (BM25_K1 + 1)) /
          (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (document.tokens.length / Math.max(1, averageDocumentLength))));
        score += inverseDocumentFrequency * normalizedFrequency;
      }

      return {
        document,
        score,
        matchedTokens,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
    .slice(0, Math.max(1, limit));
}
