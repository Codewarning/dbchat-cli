import { getActiveDatabaseHost } from "../config/database-hosts.js";
import {
  getDefaultBaseUrlForApiFormat,
  getDefaultModelForApiFormat,
  getLlmProviderPreset,
  DEFAULT_APP_CONFIG,
  DEFAULT_CONTEXT_COMPRESSION_CONFIG,
} from "../config/defaults.js";
import { getConfigPath, loadNormalizedStoredConfig, saveNormalizedStoredConfig } from "../config/store.js";
import type { AppRuntimeConfig, ContextCompressionConfig, LlmApiFormat, LlmProvider } from "../types/index.js";
import { defaultPromptRuntime, type PromptRuntime } from "../ui/prompts.js";
import { promptEmbeddingConfig } from "./embedding-config-helpers.js";
import {
  buildCommonValueChoices,
  ensureUniqueDatabaseName,
  ensureUniqueHostAddress,
  ensureUniqueHostName,
  promptDatabaseEntryConfig,
  promptDatabaseHostConfig,
  requireDatabaseEntry,
  setActiveSelection,
} from "./database-config-helpers.js";

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

/**
 * Prompt for app-level runtime limits.
 */
async function promptAppRuntimeConfig(
  prompts: PromptRuntime,
  existing?: {
    resultRowLimit?: number;
    previewRowLimit?: number;
    contextCompression?: Partial<ContextCompressionConfig>;
  },
): Promise<AppRuntimeConfig> {
  const resultRowLimit = await prompts.selectOrInput(
    "Max cached result rows",
    [
      { label: "100", value: "100" },
      { label: "200", value: "200" },
      { label: "500", value: "500" },
      { label: "1000", value: "1000" },
    ],
    String(existing?.resultRowLimit ?? DEFAULT_APP_CONFIG.resultRowLimit),
    "Enter a custom max cached result rows value",
    "Custom row limit",
  );
  const previewRowLimit = await prompts.selectOrInput(
    "Preview row limit",
    [
      { label: "10", value: "10" },
      { label: "20", value: "20" },
      { label: "50", value: "50" },
      { label: "100", value: "100" },
    ],
    String(existing?.previewRowLimit ?? DEFAULT_APP_CONFIG.previewRowLimit),
    "Enter a custom preview row limit value",
    "Custom preview limit",
  );

  return {
    resultRowLimit: parsePositiveInteger(resultRowLimit, "Max cached result rows"),
    previewRowLimit: parsePositiveInteger(previewRowLimit, "Preview row limit"),
    contextCompression: {
      ...DEFAULT_CONTEXT_COMPRESSION_CONFIG,
      ...existing?.contextCompression,
    },
  };
}

/**
 * Interactive setup that persists LLM settings and one active host/database selection.
 */
export async function handleInitCommand(prompts: PromptRuntime = defaultPromptRuntime): Promise<void> {
  const existing = await loadNormalizedStoredConfig();
  const activeHost = getActiveDatabaseHost(existing);
  const activeDatabase = activeHost ? requireDatabaseEntry(activeHost, existing.activeDatabaseName ?? activeHost.databases[0]?.name ?? "") : undefined;

  const provider = await prompts.select<LlmProvider>(
    "Select an LLM provider",
    [
      { label: "OpenAI GPT", value: "openai" },
      { label: "Claude / Anthropic", value: "anthropic" },
      { label: "DeepSeek", value: "deepseek" },
      { label: "Custom", value: "custom" },
    ],
    existing.llm?.provider ?? "openai",
  );

  const providerPreset = getLlmProviderPreset(provider);
  const apiFormat =
    provider === "custom"
      ? await prompts.select<LlmApiFormat>(
          "Select the API format for the custom provider",
          [
            { label: "OpenAI-compatible", value: "openai" },
            { label: "Anthropic-compatible", value: "anthropic" },
          ],
          existing.llm?.provider === "custom" ? (existing.llm.apiFormat ?? "openai") : providerPreset.apiFormat,
        )
      : providerPreset.apiFormat;

  const reuseExistingLlmDefaults = existing.llm?.provider === provider && existing.llm?.apiFormat === apiFormat;
  const defaultBaseUrl =
    reuseExistingLlmDefaults && existing.llm?.baseUrl
      ? existing.llm.baseUrl
      : provider === "custom"
        ? getDefaultBaseUrlForApiFormat(apiFormat)
        : providerPreset.defaultBaseUrl;
  const defaultModel =
    reuseExistingLlmDefaults && existing.llm?.model
      ? existing.llm.model
      : provider === "custom"
        ? getDefaultModelForApiFormat(apiFormat)
        : providerPreset.defaultModel;

  existing.llm = {
    provider,
    apiFormat,
    baseUrl: await prompts.selectOrInput(
      "LLM base URL",
      buildCommonValueChoices(
        provider === "custom" ? getDefaultBaseUrlForApiFormat(apiFormat) : providerPreset.defaultBaseUrl,
        existing.llm?.baseUrl,
      ),
      defaultBaseUrl,
      "Enter a custom LLM base URL",
      "Custom base URL",
    ),
    apiKey: (await prompts.password("LLM API key")) || existing.llm?.apiKey || "",
    model: await prompts.selectOrInput(
      "LLM model",
      buildCommonValueChoices(
        provider === "custom" ? getDefaultModelForApiFormat(apiFormat) : providerPreset.defaultModel,
        existing.llm?.model,
      ),
      defaultModel,
      "Enter a custom LLM model",
      "Custom model",
    ),
  };
  existing.embedding = await promptEmbeddingConfig(prompts, existing.embedding);

  const hostConfig = await promptDatabaseHostConfig(prompts, activeHost ?? undefined);
  ensureUniqueHostName(existing, hostConfig.name, activeHost?.name);
  ensureUniqueHostAddress(existing, hostConfig, activeHost?.name);

  const databaseEntry = await promptDatabaseEntryConfig(prompts, hostConfig.dialect, activeDatabase ?? undefined);

  let targetHost = activeHost;
  if (!targetHost) {
    targetHost = {
      ...hostConfig,
      databases: [],
    };
    existing.databaseHosts.push(targetHost);
  } else {
    targetHost.name = hostConfig.name;
    targetHost.dialect = hostConfig.dialect;
    targetHost.host = hostConfig.host;
    targetHost.port = hostConfig.port;
    targetHost.username = hostConfig.username;
    targetHost.password = hostConfig.password;
    targetHost.ssl = hostConfig.ssl;
  }

  if (activeDatabase) {
    ensureUniqueDatabaseName(targetHost, databaseEntry.name, activeDatabase.name);
    activeDatabase.name = databaseEntry.name;
    activeDatabase.schema = databaseEntry.schema;
  } else {
    ensureUniqueDatabaseName(targetHost, databaseEntry.name);
    targetHost.databases.push(databaseEntry);
  }

  existing.app = await promptAppRuntimeConfig(prompts, existing.app);
  setActiveSelection(existing, targetHost.name, databaseEntry.name);

  await saveNormalizedStoredConfig(existing);
  console.log(`Configuration saved to: ${getConfigPath()}`);
}
