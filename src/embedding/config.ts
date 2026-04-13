import type { EmbeddingConfig } from "../types/index.js";

export interface EmbeddingModelInfo {
  provider: EmbeddingConfig["provider"];
  baseUrl: string;
  model: string;
  modelId: string;
}

/**
 * Trim whitespace and one trailing slash so API URLs and catalog identities stay stable.
 */
export function normalizeEmbeddingBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, "");
}

/**
 * Build one stable identity for the currently configured remote embedding model.
 */
export function getEmbeddingModelInfo(config: EmbeddingConfig): EmbeddingModelInfo {
  const normalizedBaseUrl = normalizeEmbeddingBaseUrl(config.baseUrl);
  const normalizedModel = config.model.trim();

  return {
    provider: config.provider,
    baseUrl: normalizedBaseUrl,
    model: normalizedModel,
    modelId: `${config.provider}:${normalizedModel}@${normalizedBaseUrl}`,
  };
}
