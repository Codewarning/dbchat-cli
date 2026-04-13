import { normalizeEmbeddingBaseUrl } from "./config.js";
import type { EmbeddingConfig } from "../types/index.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const MAX_REQUEST_ATTEMPTS = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const ALIYUN_MAX_BATCH_SIZE = 10;

interface EmbeddingApiResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
}

class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function normalizeInput(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Embedding input cannot be empty.");
  }

  return normalized;
}

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("Chunk size must be a positive integer.");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function getPreferredBatchSize(config: EmbeddingConfig): number {
  return config.provider === "aliyun" ? ALIYUN_MAX_BATCH_SIZE : Number.POSITIVE_INFINITY;
}

function extractBatchSizeLimit(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/not be larger than\s+(\d+)/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipErrorText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponsePayload<T>(response: Response): Promise<{ payload: T | null; rawText: string }> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return {
      payload: null,
      rawText,
    };
  }

  try {
    return {
      payload: JSON.parse(rawText) as T,
      rawText,
    };
  } catch {
    return {
      payload: null,
      rawText,
    };
  }
}

function extractResponseError(payload: unknown, status: number, rawText: string): string {
  if (isRecord(payload)) {
    const directMessage = typeof payload.message === "string" ? payload.message : null;
    if (directMessage) {
      return directMessage;
    }

    const nestedError = payload.error;
    if (isRecord(nestedError) && typeof nestedError.message === "string") {
      return nestedError.message;
    }

    if (typeof nestedError === "string") {
      return nestedError;
    }
  }

  if (rawText.trim()) {
    return `Embedding request failed with HTTP ${status}: ${clipErrorText(rawText)}`;
  }

  return `Embedding request failed with HTTP ${status}.`;
}

async function requestJson<T>(endpoint: string, init: RequestInit): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        ...init,
        signal: controller.signal,
      });
      const { payload, rawText } = await parseResponsePayload<T>(response);

      if (!response.ok) {
        const error = new HttpRequestError(
          extractResponseError(payload, response.status, rawText),
          RETRYABLE_STATUS_CODES.has(response.status),
        );
        if (attempt < MAX_REQUEST_ATTEMPTS && error.retryable) {
          lastError = error;
          await delay(250 * attempt);
          continue;
        }

        throw error;
      }

      if (!payload) {
        throw new Error("Embedding request returned an empty or non-JSON response body.");
      }

      return payload;
    } catch (error) {
      if (error instanceof HttpRequestError && !error.retryable) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const isAbort = error instanceof Error && error.name === "AbortError";
      const normalizedError = new Error(
        isAbort ? `Embedding request timed out after ${Math.round(DEFAULT_REQUEST_TIMEOUT_MS / 1000)}s.` : message,
      );
      if (attempt < MAX_REQUEST_ATTEMPTS && !isAbort) {
        lastError = normalizedError;
        await delay(250 * attempt);
        continue;
      }

      throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Embedding request failed.");
}

/**
 * Minimal client for OpenAI-compatible embedding APIs.
 */
class EmbeddingClient {
  constructor(private readonly config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error("Missing embedding API key. Run `dbchat init` or set DBCHAT_EMBEDDING_API_KEY.");
    }
  }

  async embedTexts(inputs: string[]): Promise<number[][]> {
    if (!inputs.length) {
      return [];
    }

    return this.embedTextsAdaptive(inputs, getPreferredBatchSize(this.config));
  }

  private async embedTextsAdaptive(inputs: string[], batchSize: number): Promise<number[][]> {
    if (inputs.length > batchSize) {
      const vectors: number[][] = [];

      for (const chunk of chunkItems(inputs, batchSize)) {
        vectors.push(...(await this.embedTextsAdaptive(chunk, batchSize)));
      }

      return vectors;
    }

    try {
      return await this.requestEmbeddings(inputs);
    } catch (error) {
      const detectedBatchLimit = extractBatchSizeLimit(error);
      if (inputs.length > 1 && detectedBatchLimit && detectedBatchLimit < inputs.length) {
        return this.embedTextsAdaptive(inputs, detectedBatchLimit);
      }

      throw error;
    }
  }

  private async requestEmbeddings(inputs: string[]): Promise<number[][]> {
    const endpoint = `${normalizeEmbeddingBaseUrl(this.config.baseUrl)}/embeddings`;
    const payload = await requestJson<EmbeddingApiResponse>(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: inputs.length === 1 ? inputs[0] : inputs,
      }),
    });

    const data = (payload.data ?? [])
      .map((entry, arrayIndex) => ({
        embedding: Array.isArray(entry.embedding) ? entry.embedding : [],
        index: typeof entry.index === "number" ? entry.index : arrayIndex,
      }))
      .sort((left, right) => left.index - right.index);

    if (data.length !== inputs.length) {
      throw new Error(`Embedding response returned ${data.length} vectors for ${inputs.length} inputs.`);
    }

    return data.map((entry, index) => {
      if (!entry.embedding.length) {
        throw new Error(`Embedding API returned an empty vector for input ${index + 1}.`);
      }

      return [...entry.embedding];
    });
  }
}

export interface EmbeddingRuntimeOptions {
  config: EmbeddingConfig;
}

export async function embedTexts(inputs: string[], options: EmbeddingRuntimeOptions): Promise<number[][]> {
  const normalizedInputs = inputs.map(normalizeInput);
  const client = new EmbeddingClient(options.config);
  return client.embedTexts(normalizedInputs);
}

export async function embedText(input: string, options: EmbeddingRuntimeOptions): Promise<number[]> {
  const [embedding] = await embedTexts([input], options);
  return embedding;
}
