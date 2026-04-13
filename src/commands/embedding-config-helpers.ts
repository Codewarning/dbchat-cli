import { getEmbeddingProviderPreset } from "../config/defaults.js";
import type { EmbeddingConfig, EmbeddingProvider } from "../types/index.js";
import type { PromptRuntime } from "../ui/prompts.js";
import { buildCommonValueChoices } from "./database-config-helpers.js";

function buildModelPromptChoices(defaultValue: string, modelChoices: readonly string[], currentValue?: string) {
  const choices = buildCommonValueChoices(defaultValue, currentValue);

  for (const model of modelChoices) {
    if (!choices.some((choice) => choice.value === model)) {
      choices.push({
        label: model,
        value: model,
      });
    }
  }

  return choices;
}

/**
 * Prompt for embedding API settings used by schema-catalog indexing and search.
 */
export async function promptEmbeddingConfig(prompts: PromptRuntime, existing?: Partial<EmbeddingConfig>): Promise<EmbeddingConfig> {
  const provider = await prompts.select<EmbeddingProvider>(
    "Select an embedding API provider",
    [
      { label: "Aliyun Bailian", value: "aliyun" },
      { label: "OpenAI", value: "openai" },
      { label: "Custom", value: "custom" },
    ],
    existing?.provider ?? "aliyun",
  );

  const providerPreset = getEmbeddingProviderPreset(provider);
  const reuseExistingDefaults = existing?.provider === provider;
  const defaultBaseUrl = reuseExistingDefaults && existing?.baseUrl ? existing.baseUrl : providerPreset.defaultBaseUrl;
  const defaultModel = reuseExistingDefaults && existing?.model ? existing.model : providerPreset.defaultModel;

  return {
    provider,
    baseUrl: await prompts.selectOrInput(
      "Embedding API base URL",
      buildCommonValueChoices(providerPreset.defaultBaseUrl, existing?.baseUrl),
      defaultBaseUrl,
      "Enter a custom embedding API base URL",
      "Custom base URL",
    ),
    apiKey: (await prompts.password("Embedding API key")) || existing?.apiKey || "",
    model: await prompts.selectOrInput(
      "Embedding model",
      buildModelPromptChoices(providerPreset.defaultModel, providerPreset.modelChoices, existing?.model),
      defaultModel,
      "Enter a custom embedding model",
      "Custom model",
    ),
  };
}
