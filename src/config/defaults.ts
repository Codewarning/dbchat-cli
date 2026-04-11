// Centralized provider and runtime defaults used by init prompts and config resolution.
import type { AppRuntimeConfig, LlmApiFormat, LlmProvider } from "../types/index.js";

/**
 * Default connection metadata associated with a named LLM provider preset.
 */
export interface LlmProviderPreset {
  label: string;
  apiFormat: LlmApiFormat;
  defaultBaseUrl: string;
  defaultModel: string;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
export const DEFAULT_CUSTOM_MODEL = "custom-model";
export const DEFAULT_EMBEDDING_MODEL_URL =
  "https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf";
export const DEFAULT_EMBEDDING_MODEL_FALLBACK_URL =
  "https://hf-mirror.com/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/resolve/main/embeddinggemma-300m-qat-Q8_0.gguf";
export const DEFAULT_EMBEDDING_MODEL_DOWNLOAD_URLS = [DEFAULT_EMBEDDING_MODEL_URL, DEFAULT_EMBEDDING_MODEL_FALLBACK_URL] as const;
export const DEFAULT_POSTGRES_PORT = 5432;
export const DEFAULT_MYSQL_PORT = 3306;

export const DEFAULT_APP_CONFIG: AppRuntimeConfig = {
  resultRowLimit: 200,
  previewRowLimit: 20,
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

/**
 * Look up the built-in preset metadata for one provider name.
 */
export function getLlmProviderPreset(provider: LlmProvider): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS[provider];
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
