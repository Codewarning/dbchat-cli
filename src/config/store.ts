// Config persistence and resolution live here so the rest of the app sees one normalized shape.
import { readFile } from "node:fs/promises";
import {
  DEFAULT_APP_CONFIG,
  getDefaultBaseUrlForApiFormat,
  getDefaultModelForApiFormat,
  getLlmProviderPreset,
} from "./defaults.js";
import { normalizeStoredConfig, resolveStoredDatabaseConfig, toStoredConfig } from "./database-hosts.js";
import { getConfigPath } from "./paths.js";
import { appConfigSchema, storedConfigSchema } from "./schema.js";
import { getEmbeddingModelInfo, isEmbeddingModelDownloaded, resolveEmbeddingModelUrl } from "../embedding/model.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { DEFAULT_DATABASE_OPERATION_ACCESS } from "../db/operation-access.js";
import type { AppConfig, DatabaseDialect, LlmApiFormat, LlmProvider, StoredConfig } from "../types/index.js";

export { getConfigDirectory, getConfigPath } from "./paths.js";

/**
 * Parse a numeric environment override and ignore invalid numbers.
 */
function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
function resolveLlmProvider(stored: StoredConfig, env: NodeJS.ProcessEnv): LlmProvider {
  // Environment overrides always win so automation can avoid mutating the on-disk config.
  const envProvider = env.DBCHAT_LLM_PROVIDER as LlmProvider | undefined;
  return envProvider ?? stored.llm?.provider ?? "openai";
}

/**
 * Resolve the API wire format for the selected provider.
 */
function resolveLlmApiFormat(provider: LlmProvider, stored: StoredConfig, env: NodeJS.ProcessEnv): LlmApiFormat {
  const envApiFormat = env.DBCHAT_LLM_API_FORMAT as LlmApiFormat | undefined;
  if (envApiFormat) {
    return envApiFormat;
  }

  if (stored.llm?.apiFormat) {
    return stored.llm.apiFormat;
  }

  return getLlmProviderPreset(provider).apiFormat;
}

/**
 * Resolve the API key source for the selected provider and protocol.
 */
function resolveLlmApiKey(provider: LlmProvider, apiFormat: LlmApiFormat, stored: StoredConfig, env: NodeJS.ProcessEnv): string {
  switch (provider) {
    case "openai":
      return pickFirstNonEmpty(env.DBCHAT_API_KEY, env.OPENAI_API_KEY, stored.llm?.apiKey) ?? "";
    case "anthropic":
      return pickFirstNonEmpty(env.DBCHAT_API_KEY, env.ANTHROPIC_API_KEY, stored.llm?.apiKey) ?? "";
    case "deepseek":
      return pickFirstNonEmpty(env.DBCHAT_API_KEY, env.DEEPSEEK_API_KEY, stored.llm?.apiKey) ?? "";
    case "custom":
      return pickFirstNonEmpty(
        env.DBCHAT_API_KEY,
        apiFormat === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
        stored.llm?.apiKey,
      ) ?? "";
    default:
      return "";
  }
}

/**
 * Merge stored config, environment overrides, and provider defaults into one validated runtime config.
 */
export function buildResolvedAppConfig(stored: StoredConfig, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = resolveLlmProvider(stored, env);
  const apiFormat = resolveLlmApiFormat(provider, stored, env);
  const providerPreset = getLlmProviderPreset(provider);
  const selectedDatabase = resolveStoredDatabaseConfig(stored);
  const envDialect = env.DBCHAT_DB_DIALECT as DatabaseDialect | undefined;
  const dialect = envDialect ?? selectedDatabase.dialect ?? "postgres";
  const resolvedDatabaseIdentity = {
    dialect,
    host: pickFirstNonEmpty(env.DBCHAT_DB_HOST, selectedDatabase.host) ?? "",
    port: parseNumber(env.DBCHAT_DB_PORT) ?? selectedDatabase.port ?? (dialect === "postgres" ? 5432 : 3306),
    database: pickFirstNonEmpty(env.DBCHAT_DB_NAME, selectedDatabase.database) ?? "",
    schema: pickFirstNonEmpty(env.DBCHAT_DB_SCHEMA, selectedDatabase.schema),
  };

  // Resolve every field eagerly so downstream modules do not need to juggle env-vs-file precedence.
  return appConfigSchema.parse({
    llm: {
      provider,
      apiFormat,
      baseUrl:
        pickFirstNonEmpty(env.DBCHAT_LLM_BASE_URL, stored.llm?.baseUrl) ??
        (provider === "custom" ? getDefaultBaseUrlForApiFormat(apiFormat) : providerPreset.defaultBaseUrl),
      apiKey: resolveLlmApiKey(provider, apiFormat, stored, env),
      model:
        pickFirstNonEmpty(env.DBCHAT_LLM_MODEL, stored.llm?.model) ??
        (provider === "custom" ? getDefaultModelForApiFormat(apiFormat) : providerPreset.defaultModel),
    },
    database: {
      ...resolvedDatabaseIdentity,
      username: pickFirstNonEmpty(env.DBCHAT_DB_USER, selectedDatabase.username) ?? "",
      password: pickFirstNonEmpty(env.DBCHAT_DB_PASSWORD, selectedDatabase.password) ?? "",
      ssl: parseBoolean(env.DBCHAT_DB_SSL) ?? selectedDatabase.ssl,
      operationAccess: DEFAULT_DATABASE_OPERATION_ACCESS,
    },
    app: {
      resultRowLimit: parseNumber(env.DBCHAT_RESULT_ROW_LIMIT) ?? stored.app?.resultRowLimit ?? DEFAULT_APP_CONFIG.resultRowLimit,
      previewRowLimit: parseNumber(env.DBCHAT_PREVIEW_ROW_LIMIT) ?? stored.app?.previewRowLimit ?? DEFAULT_APP_CONFIG.previewRowLimit,
    },
  });
}

export async function resolveAppConfig(): Promise<AppConfig> {
  return buildResolvedAppConfig(await loadStoredConfig());
}

/**
 * Return the stored config with sensitive fields masked for safe display.
 */
export async function getMaskedConfig(): Promise<Record<string, unknown>> {
  const config = normalizeStoredConfig(await loadStoredConfig());
  const modelUrl = resolveEmbeddingModelUrl();
  const modelInfo = getEmbeddingModelInfo(modelUrl);

  return {
    llm: {
      provider: config.llm?.provider ?? null,
      apiFormat: config.llm?.apiFormat ?? null,
      baseUrl: config.llm?.baseUrl ?? null,
      // Secrets are intentionally masked because this command is meant for safe terminal inspection.
      apiKey: config.llm?.apiKey ? "******" : null,
      model: config.llm?.model ?? null,
    },
    localEmbedding: {
      modelUrl,
      modelPath: modelInfo.modelPath,
      downloaded: await isEmbeddingModelDownloaded(modelUrl),
    },
    databaseSelection: {
      activeHost: config.activeDatabaseHost ?? null,
      activeDatabase: config.activeDatabaseName ?? null,
    },
    databaseHosts: config.databaseHosts.map((host) => ({
      name: host.name,
      dialect: host.dialect,
      host: host.host,
      port: host.port,
      username: host.username,
      password: host.password ? "******" : null,
      ssl: host.ssl ?? null,
      databases: host.databases.map((database) => ({
        name: database.name,
        schema: database.schema ?? null,
      })),
    })),
    app: {
      resultRowLimit: config.app?.resultRowLimit ?? null,
      previewRowLimit: config.app?.previewRowLimit ?? null,
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
