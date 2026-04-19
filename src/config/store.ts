// Config persistence and resolution live here so the rest of the app sees one normalized shape.
import { readFile } from "node:fs/promises";
import {
  DEFAULT_APP_CONFIG,
  DEFAULT_CONTEXT_COMPRESSION_CONFIG,
  DEFAULT_TABLE_RENDERING_CONFIG,
  getDefaultBaseUrlForApiFormat,
  getDefaultModelForApiFormat,
  getEmbeddingProviderPreset,
  getLlmProviderPreset,
} from "./defaults.js";
import { loadProjectEnvDefaults } from "./env-file.js";
import { normalizeStoredConfig, resolveStoredDatabaseConfig, toStoredConfig } from "./database-hosts.js";
import { getConfigPath } from "./paths.js";
import { appConfigSchema, storedConfigSchema } from "./schema.js";
import { getEmbeddingModelInfo } from "../embedding/config.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { DEFAULT_DATABASE_OPERATION_ACCESS } from "../db/operation-access.js";
import type { AppConfig, DatabaseDialect, EmbeddingProvider, LlmApiFormat, LlmProvider, StoredConfig } from "../types/index.js";

export { getConfigDirectory, getConfigPath } from "./paths.js";

/**
 * Parse a positive integer environment override and ignore invalid values.
 */
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Parse a boolean environment override and ignore unsupported values.
 */
function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
}

/**
 * Return the first defined non-empty string from a list of candidates.
 */
function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  // Environment variables often exist but are empty strings; skip those.
  return values.find((value) => Boolean(value && value.trim()));
}

/**
 * Resolve a positive integer from runtime env, stored config, project defaults, and a hard fallback.
 */
function resolvePositiveInteger(
  runtimeValue: string | undefined,
  storedValue: number | undefined,
  projectDefaultValue: string | undefined,
  fallbackValue: number,
): number {
  return parsePositiveInteger(runtimeValue) ?? storedValue ?? parsePositiveInteger(projectDefaultValue) ?? fallbackValue;
}

/**
 * Resolve a boolean from runtime env, stored config, and project defaults.
 */
function resolveBoolean(
  runtimeValue: string | undefined,
  storedValue: boolean | undefined,
  projectDefaultValue: string | undefined,
): boolean | undefined {
  return parseBoolean(runtimeValue) ?? storedValue ?? parseBoolean(projectDefaultValue);
}

/**
 * Load the stored config file if it exists, otherwise return an empty shape.
 */
export async function loadStoredConfig(): Promise<StoredConfig> {
  try {
    const content = await readFile(getConfigPath(), "utf8");
    return storedConfigSchema.parse(JSON.parse(content) as StoredConfig);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

/**
 * Persist the partial config object to the user's config file.
 */
export async function saveStoredConfig(config: StoredConfig): Promise<void> {
  // Persist a trailing newline so the file stays friendly to shell tools and diffs.
  await writeFileAtomic(getConfigPath(), `${JSON.stringify(storedConfigSchema.parse(config), null, 2)}\n`);
}

/**
 * Resolve the active LLM provider after applying environment overrides.
 */
function resolveLlmProvider(
  stored: StoredConfig,
  env: NodeJS.ProcessEnv,
  projectDefaults: NodeJS.ProcessEnv,
): LlmProvider {
  // Environment overrides always win so automation can avoid mutating the on-disk config.
  const envProvider = env.DBCHAT_LLM_PROVIDER as LlmProvider | undefined;
  const projectDefaultProvider = projectDefaults.DBCHAT_LLM_PROVIDER as LlmProvider | undefined;
  return envProvider ?? stored.llm?.provider ?? projectDefaultProvider ?? "openai";
}

/**
 * Resolve the embedding provider after applying environment overrides.
 */
function resolveEmbeddingProvider(
  stored: StoredConfig,
  env: NodeJS.ProcessEnv,
  projectDefaults: NodeJS.ProcessEnv,
): EmbeddingProvider {
  const envProvider = env.DBCHAT_EMBEDDING_PROVIDER as EmbeddingProvider | undefined;
  const projectDefaultProvider = projectDefaults.DBCHAT_EMBEDDING_PROVIDER as EmbeddingProvider | undefined;
  return envProvider ?? stored.embedding?.provider ?? projectDefaultProvider ?? "aliyun";
}

/**
 * Resolve the API wire format for the selected provider.
 */
function resolveLlmApiFormat(
  provider: LlmProvider,
  stored: StoredConfig,
  env: NodeJS.ProcessEnv,
  projectDefaults: NodeJS.ProcessEnv,
): LlmApiFormat {
  const envApiFormat = env.DBCHAT_LLM_API_FORMAT as LlmApiFormat | undefined;
  if (envApiFormat) {
    return envApiFormat;
  }

  if (stored.llm?.apiFormat) {
    return stored.llm.apiFormat;
  }

  if (projectDefaults.DBCHAT_LLM_API_FORMAT) {
    return projectDefaults.DBCHAT_LLM_API_FORMAT as LlmApiFormat;
  }

  return getLlmProviderPreset(provider).apiFormat;
}

/**
 * Resolve the API key source for the selected provider and protocol.
 */
function resolveLlmApiKey(
  provider: LlmProvider,
  apiFormat: LlmApiFormat,
  stored: StoredConfig,
  env: NodeJS.ProcessEnv,
  projectDefaults: NodeJS.ProcessEnv,
): string {
  switch (provider) {
    case "openai":
      return pickFirstNonEmpty(
        env.DBCHAT_API_KEY,
        env.OPENAI_API_KEY,
        stored.llm?.apiKey,
        projectDefaults.DBCHAT_API_KEY,
        projectDefaults.OPENAI_API_KEY,
      ) ?? "";
    case "anthropic":
      return pickFirstNonEmpty(
        env.DBCHAT_API_KEY,
        env.ANTHROPIC_API_KEY,
        stored.llm?.apiKey,
        projectDefaults.DBCHAT_API_KEY,
        projectDefaults.ANTHROPIC_API_KEY,
      ) ?? "";
    case "deepseek":
      return pickFirstNonEmpty(
        env.DBCHAT_API_KEY,
        env.DEEPSEEK_API_KEY,
        stored.llm?.apiKey,
        projectDefaults.DBCHAT_API_KEY,
        projectDefaults.DEEPSEEK_API_KEY,
      ) ?? "";
    case "custom":
      return pickFirstNonEmpty(
        env.DBCHAT_API_KEY,
        apiFormat === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
        stored.llm?.apiKey,
        projectDefaults.DBCHAT_API_KEY,
        apiFormat === "anthropic" ? projectDefaults.ANTHROPIC_API_KEY : projectDefaults.OPENAI_API_KEY,
      ) ?? "";
    default:
      return "";
  }
}

/**
 * Resolve the API key source for the selected embedding provider.
 */
function resolveEmbeddingApiKey(
  provider: EmbeddingProvider,
  stored: StoredConfig,
  env: NodeJS.ProcessEnv,
  projectDefaults: NodeJS.ProcessEnv,
): string {
  switch (provider) {
    case "aliyun":
      return pickFirstNonEmpty(
        env.DBCHAT_EMBEDDING_API_KEY,
        env.DASHSCOPE_API_KEY,
        stored.embedding?.apiKey,
        projectDefaults.DBCHAT_EMBEDDING_API_KEY,
        projectDefaults.DASHSCOPE_API_KEY,
      ) ?? "";
    case "openai":
      return pickFirstNonEmpty(
        env.DBCHAT_EMBEDDING_API_KEY,
        env.OPENAI_API_KEY,
        stored.embedding?.apiKey,
        projectDefaults.DBCHAT_EMBEDDING_API_KEY,
        projectDefaults.OPENAI_API_KEY,
      ) ?? "";
    case "custom":
      return pickFirstNonEmpty(env.DBCHAT_EMBEDDING_API_KEY, stored.embedding?.apiKey, projectDefaults.DBCHAT_EMBEDDING_API_KEY) ?? "";
    default:
      return "";
  }
}

/**
 * Merge stored config, environment overrides, and provider defaults into one validated runtime config.
 */
export function buildResolvedAppConfig(
  stored: StoredConfig,
  env: NodeJS.ProcessEnv = process.env,
  projectDefaults: NodeJS.ProcessEnv = {},
): AppConfig {
  const provider = resolveLlmProvider(stored, env, projectDefaults);
  const apiFormat = resolveLlmApiFormat(provider, stored, env, projectDefaults);
  const providerPreset = getLlmProviderPreset(provider);
  const embeddingProvider = resolveEmbeddingProvider(stored, env, projectDefaults);
  const embeddingPreset = getEmbeddingProviderPreset(embeddingProvider);
  const selectedDatabase = resolveStoredDatabaseConfig(stored);
  const envDialect = env.DBCHAT_DB_DIALECT as DatabaseDialect | undefined;
  const projectDefaultDialect = projectDefaults.DBCHAT_DB_DIALECT as DatabaseDialect | undefined;
  const dialect = envDialect ?? selectedDatabase.dialect ?? projectDefaultDialect ?? "postgres";
  const resolvedDatabaseIdentity = {
    dialect,
    host: pickFirstNonEmpty(env.DBCHAT_DB_HOST, selectedDatabase.host, projectDefaults.DBCHAT_DB_HOST) ?? "",
    port: resolvePositiveInteger(
      env.DBCHAT_DB_PORT,
      selectedDatabase.port,
      projectDefaults.DBCHAT_DB_PORT,
      dialect === "postgres" ? 5432 : 3306,
    ),
    database: pickFirstNonEmpty(env.DBCHAT_DB_NAME, selectedDatabase.database, projectDefaults.DBCHAT_DB_NAME) ?? "",
    schema: pickFirstNonEmpty(env.DBCHAT_DB_SCHEMA, selectedDatabase.schema, projectDefaults.DBCHAT_DB_SCHEMA),
  };

  // Resolve every field eagerly so downstream modules do not need to juggle env-vs-file precedence.
  return appConfigSchema.parse({
    llm: {
      provider,
      apiFormat,
      baseUrl:
        pickFirstNonEmpty(env.DBCHAT_LLM_BASE_URL, stored.llm?.baseUrl, projectDefaults.DBCHAT_LLM_BASE_URL) ??
        (provider === "custom" ? getDefaultBaseUrlForApiFormat(apiFormat) : providerPreset.defaultBaseUrl),
      apiKey: resolveLlmApiKey(provider, apiFormat, stored, env, projectDefaults),
      model:
        pickFirstNonEmpty(env.DBCHAT_LLM_MODEL, stored.llm?.model, projectDefaults.DBCHAT_LLM_MODEL) ??
        (provider === "custom" ? getDefaultModelForApiFormat(apiFormat) : providerPreset.defaultModel),
    },
    embedding: {
      provider: embeddingProvider,
      baseUrl:
        pickFirstNonEmpty(env.DBCHAT_EMBEDDING_BASE_URL, stored.embedding?.baseUrl, projectDefaults.DBCHAT_EMBEDDING_BASE_URL) ??
        embeddingPreset.defaultBaseUrl,
      apiKey: resolveEmbeddingApiKey(embeddingProvider, stored, env, projectDefaults),
      model:
        pickFirstNonEmpty(env.DBCHAT_EMBEDDING_MODEL, stored.embedding?.model, projectDefaults.DBCHAT_EMBEDDING_MODEL) ??
        embeddingPreset.defaultModel,
    },
    database: {
      ...resolvedDatabaseIdentity,
      username: pickFirstNonEmpty(env.DBCHAT_DB_USER, selectedDatabase.username, projectDefaults.DBCHAT_DB_USER) ?? "",
      password: pickFirstNonEmpty(env.DBCHAT_DB_PASSWORD, selectedDatabase.password, projectDefaults.DBCHAT_DB_PASSWORD) ?? "",
      ssl: resolveBoolean(env.DBCHAT_DB_SSL, selectedDatabase.ssl, projectDefaults.DBCHAT_DB_SSL),
      operationAccess: DEFAULT_DATABASE_OPERATION_ACCESS,
    },
    app: {
      resultRowLimit: resolvePositiveInteger(
        env.DBCHAT_RESULT_ROW_LIMIT,
        stored.app?.resultRowLimit,
        projectDefaults.DBCHAT_RESULT_ROW_LIMIT,
        DEFAULT_APP_CONFIG.resultRowLimit,
      ),
      previewRowLimit: resolvePositiveInteger(
        env.DBCHAT_PREVIEW_ROW_LIMIT,
        stored.app?.previewRowLimit,
        projectDefaults.DBCHAT_PREVIEW_ROW_LIMIT,
        DEFAULT_APP_CONFIG.previewRowLimit,
      ),
      tempArtifactRetentionDays: resolvePositiveInteger(
        env.DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS,
        stored.app?.tempArtifactRetentionDays,
        projectDefaults.DBCHAT_TEMP_ARTIFACT_RETENTION_DAYS,
        DEFAULT_APP_CONFIG.tempArtifactRetentionDays,
      ),
      tableRendering: {
        inlineRowLimit: resolvePositiveInteger(
          env.DBCHAT_INLINE_TABLE_ROW_LIMIT,
          stored.app?.tableRendering?.inlineRowLimit,
          projectDefaults.DBCHAT_INLINE_TABLE_ROW_LIMIT,
          DEFAULT_TABLE_RENDERING_CONFIG.inlineRowLimit,
        ),
        inlineColumnLimit: resolvePositiveInteger(
          env.DBCHAT_INLINE_TABLE_COLUMN_LIMIT,
          stored.app?.tableRendering?.inlineColumnLimit,
          projectDefaults.DBCHAT_INLINE_TABLE_COLUMN_LIMIT,
          DEFAULT_TABLE_RENDERING_CONFIG.inlineColumnLimit,
        ),
        previewRowLimit: resolvePositiveInteger(
          env.DBCHAT_PREVIEW_TABLE_ROW_LIMIT,
          stored.app?.tableRendering?.previewRowLimit,
          projectDefaults.DBCHAT_PREVIEW_TABLE_ROW_LIMIT,
          DEFAULT_TABLE_RENDERING_CONFIG.previewRowLimit,
        ),
      },
      contextCompression: {
        recentRawTurns: resolvePositiveInteger(
          env.DBCHAT_CONTEXT_RECENT_RAW_TURNS,
          stored.app?.contextCompression?.recentRawTurns,
          projectDefaults.DBCHAT_CONTEXT_RECENT_RAW_TURNS,
          DEFAULT_CONTEXT_COMPRESSION_CONFIG.recentRawTurns,
        ),
        rawHistoryChars: resolvePositiveInteger(
          env.DBCHAT_CONTEXT_RAW_HISTORY_CHARS,
          stored.app?.contextCompression?.rawHistoryChars,
          projectDefaults.DBCHAT_CONTEXT_RAW_HISTORY_CHARS,
          DEFAULT_CONTEXT_COMPRESSION_CONFIG.rawHistoryChars,
        ),
        largeToolOutputChars: resolvePositiveInteger(
          env.DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS,
          stored.app?.contextCompression?.largeToolOutputChars,
          projectDefaults.DBCHAT_CONTEXT_LARGE_TOOL_OUTPUT_CHARS,
          DEFAULT_CONTEXT_COMPRESSION_CONFIG.largeToolOutputChars,
        ),
        persistedToolPreviewChars: resolvePositiveInteger(
          env.DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS,
          stored.app?.contextCompression?.persistedToolPreviewChars,
          projectDefaults.DBCHAT_CONTEXT_PERSISTED_TOOL_PREVIEW_CHARS,
          DEFAULT_CONTEXT_COMPRESSION_CONFIG.persistedToolPreviewChars,
        ),
        maxToolCallsPerTurn: resolvePositiveInteger(
          env.DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN,
          stored.app?.contextCompression?.maxToolCallsPerTurn,
          projectDefaults.DBCHAT_CONTEXT_MAX_TOOL_CALLS_PER_TURN,
          DEFAULT_CONTEXT_COMPRESSION_CONFIG.maxToolCallsPerTurn,
        ),
        maxAgentIterations: resolvePositiveInteger(
          env.DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS,
          stored.app?.contextCompression?.maxAgentIterations,
          projectDefaults.DBCHAT_CONTEXT_MAX_AGENT_ITERATIONS,
          DEFAULT_CONTEXT_COMPRESSION_CONFIG.maxAgentIterations,
        ),
      },
    },
  });
}

export async function resolveAppConfig(): Promise<AppConfig> {
  const [storedConfig, projectDefaults] = await Promise.all([loadStoredConfig(), loadProjectEnvDefaults(process.cwd())]);
  return buildResolvedAppConfig(storedConfig, process.env, projectDefaults);
}

/**
 * Mask one configured secret value for safe terminal output.
 */
function maskSecret(value: string | undefined): string | null {
  return value && value.trim() ? "******" : null;
}

/**
 * Convert the resolved runtime config into a safe-to-print masked shape.
 */
export function getMaskedResolvedConfigValue(config: AppConfig): Record<string, unknown> {
  const embeddingInfo = getEmbeddingModelInfo(config.embedding);

  return {
    llm: {
      provider: config.llm.provider,
      apiFormat: config.llm.apiFormat,
      baseUrl: config.llm.baseUrl,
      apiKey: maskSecret(config.llm.apiKey),
      model: config.llm.model,
    },
    embedding: {
      provider: config.embedding.provider,
      baseUrl: config.embedding.baseUrl,
      apiKey: maskSecret(config.embedding.apiKey),
      model: config.embedding.model,
      identity: embeddingInfo.modelId,
    },
    database: {
      dialect: config.database.dialect,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      username: config.database.username,
      password: maskSecret(config.database.password),
      schema: config.database.schema ?? null,
      ssl: config.database.ssl ?? null,
      operationAccess: config.database.operationAccess,
    },
    app: {
      resultRowLimit: config.app.resultRowLimit,
      previewRowLimit: config.app.previewRowLimit,
      tempArtifactRetentionDays: config.app.tempArtifactRetentionDays,
      tableRendering: {
        inlineRowLimit: config.app.tableRendering.inlineRowLimit,
        inlineColumnLimit: config.app.tableRendering.inlineColumnLimit,
        previewRowLimit: config.app.tableRendering.previewRowLimit,
      },
      contextCompression: {
        recentRawTurns: config.app.contextCompression.recentRawTurns,
        rawHistoryChars: config.app.contextCompression.rawHistoryChars,
        largeToolOutputChars: config.app.contextCompression.largeToolOutputChars,
        persistedToolPreviewChars: config.app.contextCompression.persistedToolPreviewChars,
        maxToolCallsPerTurn: config.app.contextCompression.maxToolCallsPerTurn,
        maxAgentIterations: config.app.contextCompression.maxAgentIterations,
      },
    },
  };
}

/**
 * Return the resolved runtime config with sensitive fields masked for safe display.
 */
export async function getMaskedResolvedConfig(): Promise<Record<string, unknown>> {
  return getMaskedResolvedConfigValue(await resolveAppConfig());
}

/**
 * Return the stored config file contents with sensitive fields masked for safe display.
 */
export async function getMaskedConfig(): Promise<Record<string, unknown>> {
  const config = normalizeStoredConfig(await loadStoredConfig());
  const embeddingInfo =
    config.embedding?.provider && config.embedding.baseUrl && config.embedding.model
      ? getEmbeddingModelInfo({
          provider: config.embedding.provider,
          baseUrl: config.embedding.baseUrl,
          apiKey: config.embedding.apiKey ?? "",
          model: config.embedding.model,
        })
      : null;

  return {
    llm: {
      provider: config.llm?.provider ?? null,
      apiFormat: config.llm?.apiFormat ?? null,
      baseUrl: config.llm?.baseUrl ?? null,
      // Secrets are intentionally masked because this command is meant for safe terminal inspection.
      apiKey: maskSecret(config.llm?.apiKey),
      model: config.llm?.model ?? null,
    },
    embedding: {
      provider: config.embedding?.provider ?? null,
      baseUrl: config.embedding?.baseUrl ?? null,
      apiKey: maskSecret(config.embedding?.apiKey),
      model: config.embedding?.model ?? null,
      identity: embeddingInfo?.modelId ?? null,
    },
    databaseSelection: {
      activeHost: config.activeDatabaseHost ?? null,
      activeHostPort: config.activeDatabasePort ?? null,
      activeDatabase: config.activeDatabaseName ?? null,
    },
    databaseHosts: config.databaseHosts.map((host) => ({
      name: host.name,
      dialect: host.dialect,
      host: host.host,
      port: host.port,
      username: host.username,
      password: maskSecret(host.password),
      ssl: host.ssl ?? null,
      databases: host.databases.map((database) => ({
        name: database.name,
        schema: database.schema ?? null,
      })),
    })),
    app: {
      resultRowLimit: config.app?.resultRowLimit ?? null,
      previewRowLimit: config.app?.previewRowLimit ?? null,
      tempArtifactRetentionDays: config.app?.tempArtifactRetentionDays ?? null,
      tableRendering: {
        inlineRowLimit: config.app?.tableRendering?.inlineRowLimit ?? null,
        inlineColumnLimit: config.app?.tableRendering?.inlineColumnLimit ?? null,
        previewRowLimit: config.app?.tableRendering?.previewRowLimit ?? null,
      },
      contextCompression: {
        recentRawTurns: config.app?.contextCompression?.recentRawTurns ?? null,
        rawHistoryChars: config.app?.contextCompression?.rawHistoryChars ?? null,
        largeToolOutputChars: config.app?.contextCompression?.largeToolOutputChars ?? null,
        persistedToolPreviewChars: config.app?.contextCompression?.persistedToolPreviewChars ?? null,
        maxToolCallsPerTurn: config.app?.contextCompression?.maxToolCallsPerTurn ?? null,
        maxAgentIterations: config.app?.contextCompression?.maxAgentIterations ?? null,
      },
    },
  };
}

/**
 * Save the normalized multi-host config shape back to disk.
 */
export async function saveNormalizedStoredConfig(config: ReturnType<typeof normalizeStoredConfig>): Promise<void> {
  await saveStoredConfig(toStoredConfig(config));
}

/**
 * Load config and return it in the normalized multi-host shape used by CLI config commands.
 */
export async function loadNormalizedStoredConfig(): Promise<ReturnType<typeof normalizeStoredConfig>> {
  return normalizeStoredConfig(await loadStoredConfig());
}
