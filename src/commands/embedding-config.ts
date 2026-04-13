import { cloneNormalizedStoredConfig, type NormalizedStoredConfig } from "../config/database-hosts.js";
import { loadNormalizedStoredConfig, saveNormalizedStoredConfig } from "../config/store.js";
import type { PromptRuntime } from "../ui/prompts.js";
import { promptEmbeddingConfig } from "./embedding-config-helpers.js";

export interface EmbeddingConfigCommandOutcome {
  message: string;
  previousConfig: NormalizedStoredConfig;
  nextConfig: NormalizedStoredConfig;
}

function buildOutcome(
  previousConfig: NormalizedStoredConfig,
  nextConfig: NormalizedStoredConfig,
  message: string,
): EmbeddingConfigCommandOutcome {
  return {
    message,
    previousConfig: cloneNormalizedStoredConfig(previousConfig),
    nextConfig: cloneNormalizedStoredConfig(nextConfig),
  };
}

/**
 * Apply one prompted embedding configuration to an already-loaded normalized config.
 */
export async function updateEmbeddingConfigInMemory(
  config: NormalizedStoredConfig,
  prompts: PromptRuntime,
): Promise<EmbeddingConfigCommandOutcome> {
  const previousConfig = cloneNormalizedStoredConfig(config);
  config.embedding = await promptEmbeddingConfig(prompts, config.embedding);
  return buildOutcome(previousConfig, config, "Embedding configuration was updated.");
}

/**
 * Load, update, and persist the embedding configuration.
 */
export async function updateEmbeddingConfig(prompts: PromptRuntime): Promise<EmbeddingConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const outcome = await updateEmbeddingConfigInMemory(config, prompts);
  await saveNormalizedStoredConfig(config);
  return outcome;
}
