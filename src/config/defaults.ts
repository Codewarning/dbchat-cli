// Centralized provider and runtime defaults used by init prompts and config resolution.
import type { AppRuntimeConfig, ContextCompressionConfig, EmbeddingProvider, LlmApiFormat, LlmProvider } from "../types/index.js";

/**
 * Default connection metadata associated with a named LLM provider preset.
 */
export interface LlmProviderPreset {
  label: string;
  apiFormat: LlmApiFormat;
  defaultBaseUrl: string;
  defaultModel: string;
}

/**
 * Default connection metadata associated with a named embedding provider preset.
 */
export interface EmbeddingProviderPreset {
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  modelChoices: readonly string[];
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
export const DEFAULT_CUSTOM_MODEL = "custom-model";
export const DEFAULT_ALIYUN_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_ALIYUN_EMBEDDING_MODEL = "text-embedding-v4";
export const DEFAULT_OPENAI_EMBEDDING_BASE_URL = DEFAULT_OPENAI_BASE_URL;
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_CUSTOM_EMBEDDING_MODEL = "custom-embedding-model";
export const DEFAULT_POSTGRES_PORT = 5432;
export const DEFAULT_MYSQL_PORT = 3306;

export const DEFAULT_CONTEXT_COMPRESSION_CONFIG: ContextCompressionConfig = {
  recentRawTurns: 2,
  rawHistoryChars: 7000,
  largeToolOutputChars: 2400,
  persistedToolPreviewChars: 1200,
  maxToolCallsPerTurn: 12,
};

export const DEFAULT_APP_CONFIG: AppRuntimeConfig = {
  resultRowLimit: 200,
  previewRowLimit: 20,
  contextCompression: DEFAULT_CONTEXT_COMPRESSION_CONFIG,
};

// Presets keep vendor-specific defaults in one place so custom handling stays minimal elsewhere.
export const LLM_PROVIDER_PRESETS: Record<LlmProvider, LlmProviderPreset> = {
  openai: {
    label: "OpenAI GPT",
    apiFormat: "openai",
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  anthropic: {
    label: "Claude / Anthropic",
    apiFormat: "anthropic",
    defaultBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
  },
  deepseek: {
    label: "DeepSeek",
    apiFormat: "openai",
    defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
  },
  custom: {
    label: "Custom",
    apiFormat: "openai",
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    defaultModel: DEFAULT_CUSTOM_MODEL,
  },
};

export const EMBEDDING_PROVIDER_PRESETS: Record<EmbeddingProvider, EmbeddingProviderPreset> = {
  aliyun: {
    label: "Aliyun Bailian",
    defaultBaseUrl: DEFAULT_ALIYUN_EMBEDDING_BASE_URL,
    defaultModel: DEFAULT_ALIYUN_EMBEDDING_MODEL,
    modelChoices: ["text-embedding-v4", "text-embedding-v3", "text-embedding-v2"],
  },
  openai: {
    label: "OpenAI",
    defaultBaseUrl: DEFAULT_OPENAI_EMBEDDING_BASE_URL,
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    modelChoices: ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"],
  },
  custom: {
    label: "Custom",
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    defaultModel: DEFAULT_CUSTOM_EMBEDDING_MODEL,
    modelChoices: [],
  },
};

/**
 * Look up the built-in preset metadata for one provider name.
 */
export function getLlmProviderPreset(provider: LlmProvider): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS[provider];
}

/**
 * Look up the built-in preset metadata for one embedding provider name.
 */
export function getEmbeddingProviderPreset(provider: EmbeddingProvider): EmbeddingProviderPreset {
  return EMBEDDING_PROVIDER_PRESETS[provider];
}

/**
 * Choose a fallback base URL for a custom provider based on its wire protocol.
 */
export function getDefaultBaseUrlForApiFormat(apiFormat: LlmApiFormat): string {
  return apiFormat === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
}

/**
 * Choose a fallback model name for a custom provider based on its wire protocol.
 */
export function getDefaultModelForApiFormat(apiFormat: LlmApiFormat): string {
  // Custom providers fall back to a generic model name unless they mimic Anthropic's API.
  return apiFormat === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_CUSTOM_MODEL;
}
