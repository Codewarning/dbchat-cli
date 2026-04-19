import { getActiveDatabaseHost } from "../config/database-hosts.js";
import {
  getDefaultBaseUrlForApiFormat,
  getDefaultModelForApiFormat,
  getLlmProviderPreset,
  DEFAULT_APP_CONFIG,
  DEFAULT_CONTEXT_COMPRESSION_CONFIG,
  DEFAULT_TABLE_RENDERING_CONFIG,
} from "../config/defaults.js";
import { loadProjectEnvDefaults } from "../config/env-file.js";
import { getConfigPath, loadNormalizedStoredConfig, saveNormalizedStoredConfig } from "../config/store.js";
import type { AppRuntimeConfig, ContextCompressionConfig, LlmApiFormat, LlmProvider, TableRenderingConfig } from "../types/index.js";
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

function parsePositiveIntegerOverride(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolvePositiveIntegerDefault(
  runtimeValue: string | undefined,
  storedValue: number | undefined,
  projectDefaultValue: string | undefined,
  fallbackValue: number,
): number {
  return parsePositiveIntegerOverride(runtimeValue) ?? storedValue ?? parsePositiveIntegerOverride(projectDefaultValue) ?? fallbackValue;
}

async function resolveAppRuntimePromptDefaults(
  existing?: {
    resultRowLimit?: number;
    previewRowLimit?: number;
    tempArtifactRetentionDays?: number;
    tableRendering?: Partial<TableRenderingConfig>;
    contextCompression?: Partial<ContextCompressionConfig>;
  },
): Promise<AppRuntimeConfig> {
  const projectDefaults = await loadProjectEnvDefaults(process.cwd());

  return {
    resultRowLimit: resolvePositiveIntegerDefault(
      process.env.DBCHAT_RESULT_ROW_LIMIT,
      existing?.resultRowLimit,
      projectDefaults.DBCHAT_RESULT_ROW_LIMIT,
      DEFAULT_APP_CONFIG.resultRowLimit,
    ),
    previewRowLimit: resolvePositiveIntegerDefault(
      process.env.DBCHAT_PREVIEW_ROW_LIMIT,
      existing?.previewRowLimit,
      projectDefaults.DBCHAT_PREVIEW_ROW_LIMIT,
      DEFAULT_APP_CONFIG.previewRowLimit,
    ),
    tempArtifactRetentionDays: resolvePositiveIntegerDefault(
      process.env.DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS,
      existing?.tempArtifactRetentionDays,
      projectDefaults.DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS,
      DEFAULT_APP_CONFIG.tempArtifactRetentionDays,
    ),
    tableRendering: {
      inlineRowLimit: resolvePositiveIntegerDefault(
        process.env.DBCHAT_INLINE_TABLE_ROW_LIMIT,
        existing?.tableRendering?.inlineRowLimit,
        projectDefaults.DBCHAT_INLINE_TABLE_ROW_LIMIT,
        DEFAULT_TABLE_RENDERING_CONFIG.inlineRowLimit,
      ),
      inlineColumnLimit: resolvePositiveIntegerDefault(
        process.env.DBCHAT_INLINE_TABLE_COLUMN_LIMIT,
        existing?.tableRendering?.inlineColumnLimit,
        projectDefaults.DBCHAT_INLINE_TABLE_COLUMN_LIMIT,
        DEFAULT_TABLE_RENDERING_CONFIG.inlineColumnLimit,
      ),
      previewRowLimit: resolvePositiveIntegerDefault(
        process.env.DBCHAT_PREVIEW_TABLE_ROW_LIMIT,
        existing?.tableRendering?.previewRowLimit,
        projectDefaults.DBCHAT_PREVIEW_TABLE_ROW_LIMIT,
        DEFAULT_TABLE_RENDERING_CONFIG.previewRowLimit,
      ),
    },
    contextCompression: {
      recentRawTurns: resolvePositiveIntegerDefault(
        process.env.DBCHAT_CONTEXT_RECENT_RAW_TURNS,
        existing?.contextCompression?.recentRawTurns,
        projectDefaults.DBCHAT_CONTEXT_RECENT_RAW_TURNS,
        DEFAULT_CONTEXT_COMPRESSION_CONFIG.recentRawTurns,
      ),
      rawHistoryChars: resolvePositiveIntegerDefault(
        process.env.DBCHAT_CONTEXT_RAW_HISTORY_CHARS,
        existing?.contextCompression?.rawHistoryChars,
        projectDefaults.DBCHAT_CONTEXT_RAW_HISTORY_CHARS,
        DEFAULT_CONTEXT_COMPRESSION_CONFIG.rawHistoryChars,
      ),
      largeToolOutputChars: resolvePositiveIntegerDefault(
        process.env.DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS,
        existing?.contextCompression?.largeToolOutputChars,
        projectDefaults.DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS,
        DEFAULT_CONTEXT_COMPRESSION_CONFIG.largeToolOutputChars,
      ),
      persistedToolPreviewChars: resolvePositiveIntegerDefault(
        process.env.DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS,
        existing?.contextCompression?.persistedToolPreviewChars,
        projectDefaults.DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS,
        DEFAULT_CONTEXT_COMPRESSION_CONFIG.persistedToolPreviewChars,
      ),
      maxToolCallsPerTurn: resolvePositiveIntegerDefault(
        process.env.DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN,
        existing?.contextCompression?.maxToolCallsPerTurn,
        projectDefaults.DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN,
        DEFAULT_CONTEXT_COMPRESSION_CONFIG.maxToolCallsPerTurn,
      ),
      maxAgentIterations: resolvePositiveIntegerDefault(
        process.env.DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS,
        existing?.contextCompression?.maxAgentIterations,
        projectDefaults.DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS,
        DEFAULT_CONTEXT_COMPRESSION_CONFIG.maxAgentIterations,
      ),
    },
  };
}

/**
 * Prompt for app-level runtime limits.
 */
async function promptAppRuntimeConfig(
  prompts: PromptRuntime,
  existing?: {
    resultRowLimit?: number;
    previewRowLimit?: number;
    tempArtifactRetentionDays?: number;
    tableRendering?: Partial<TableRenderingConfig>;
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
  const inlineTableRowLimit = await prompts.selectOrInput(
    "Inline table row limit",
    [
      { label: "5", value: "5" },
      { label: "10", value: "10" },
      { label: "20", value: "20" },
    ],
    String(existing?.tableRendering?.inlineRowLimit ?? DEFAULT_TABLE_RENDERING_CONFIG.inlineRowLimit),
    "Enter a custom inline table row limit",
    "Custom inline row limit",
  );
  const inlineTableColumnLimit = await prompts.selectOrInput(
    "Inline table column limit",
    [
      { label: "6", value: "6" },
      { label: "8", value: "8" },
      { label: "10", value: "10" },
    ],
    String(existing?.tableRendering?.inlineColumnLimit ?? DEFAULT_TABLE_RENDERING_CONFIG.inlineColumnLimit),
    "Enter a custom inline table column limit",
    "Custom inline column limit",
  );
  const previewTableRowLimit = await prompts.selectOrInput(
    "Large-table preview rows",
    [
      { label: "10", value: "10" },
      { label: "20", value: "20" },
      { label: "50", value: "50" },
    ],
    String(existing?.tableRendering?.previewRowLimit ?? DEFAULT_TABLE_RENDERING_CONFIG.previewRowLimit),
    "Enter a custom large-table preview row limit",
    "Custom table preview limit",
  );

  return {
    resultRowLimit: parsePositiveInteger(resultRowLimit, "Max cached result rows"),
    previewRowLimit: parsePositiveInteger(previewRowLimit, "Preview row limit"),
    tempArtifactRetentionDays: existing?.tempArtifactRetentionDays ?? DEFAULT_APP_CONFIG.tempArtifactRetentionDays,
    tableRendering: {
      inlineRowLimit: parsePositiveInteger(inlineTableRowLimit, "Inline table row limit"),
      inlineColumnLimit: parsePositiveInteger(inlineTableColumnLimit, "Inline table column limit"),
      previewRowLimit: parsePositiveInteger(previewTableRowLimit, "Large-table preview rows"),
    },
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
  const appPromptDefaults = await resolveAppRuntimePromptDefaults(existing.app);
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

  existing.app = await promptAppRuntimeConfig(prompts, appPromptDefaults);
  setActiveSelection(existing, targetHost.name, databaseEntry.name);

  await saveNormalizedStoredConfig(existing);
  console.log(`Configuration saved to: ${getConfigPath()}`);
}
