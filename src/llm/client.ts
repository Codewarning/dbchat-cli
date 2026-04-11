// Provider-aware LLM client that speaks either OpenAI-compatible or Anthropic-compatible APIs.
import type { LlmConfig } from "../types/index.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesResponse,
  LlmAssistantMessage,
  LlmMessageParam,
  LlmToolDefinition,
  OpenAiChatCompletionResponse,
} from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const MAX_REQUEST_ATTEMPTS = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Join a base URL with one API suffix while tolerating a trailing slash.
 */
function normalizeBaseUrl(baseUrl: string, pathSuffix: string): string {
  // Trim only one trailing slash so callers can pass either ".../v1" or ".../v1/".
  return `${baseUrl.replace(/\/$/, "")}${pathSuffix}`;
}

/**
 * Parse tool arguments into an object or fall back to an empty object.
 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

function extractResponseError(payload: unknown, status: number, rawText: string, fallbackLabel: string): string {
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
    return `${fallbackLabel} failed with HTTP ${status}: ${clipErrorText(rawText)}`;
  }

  return `${fallbackLabel} failed with HTTP ${status}.`;
}

async function requestJson<T>(endpoint: string, init: RequestInit, fallbackLabel: string): Promise<T> {
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
          extractResponseError(payload, response.status, rawText, fallbackLabel),
          RETRYABLE_STATUS_CODES.has(response.status),
        );
        if (attempt < MAX_REQUEST_ATTEMPTS && RETRYABLE_STATUS_CODES.has(response.status)) {
          lastError = error;
          await delay(250 * attempt);
          continue;
        }

        throw error;
      }

      if (!payload) {
        throw new Error(`${fallbackLabel} returned an empty or non-JSON response body.`);
      }

      return payload;
    } catch (error) {
      if (error instanceof HttpRequestError && !error.retryable) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const isAbort = error instanceof Error && error.name === "AbortError";
      const normalizedError = new Error(
        isAbort ? `${fallbackLabel} timed out after ${Math.round(DEFAULT_REQUEST_TIMEOUT_MS / 1000)}s.` : message,
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

  throw lastError ?? new Error(`${fallbackLabel} failed.`);
}

/**
 * Type guard for Anthropic text blocks.
 */
function isAnthropicTextBlock(
  block: NonNullable<AnthropicMessagesResponse["content"]>[number],
): block is { type: "text"; text?: string } {
  return block.type === "text";
}

/**
 * Type guard for Anthropic tool invocation blocks.
 */
function isAnthropicToolUseBlock(
  block: NonNullable<AnthropicMessagesResponse["content"]>[number],
): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } {
  return block.type === "tool_use";
}

/**
 * Provider-aware wrapper around the supported LLM APIs.
 */
export class LlmClient {
  /**
   * Validate that the resolved LLM config includes an API key.
   */
  constructor(private readonly config: LlmConfig) {
    if (!config.apiKey) {
      throw new Error("Missing LLM API key. Run `dbchat init` or set the appropriate environment variable.");
    }
  }

  /**
   * Complete one assistant turn using the configured provider protocol.
   */
  async complete(messages: LlmMessageParam[], tools: LlmToolDefinition[]): Promise<LlmAssistantMessage> {
    // Route through the protocol-specific implementation selected by the resolved config.
    return this.config.apiFormat === "anthropic"
      ? this.completeAnthropic(messages, tools)
      : this.completeOpenAiCompatible(messages, tools);
  }

  /**
   * Send a chat-completions request to any OpenAI-compatible provider.
   */
  private async completeOpenAiCompatible(
    messages: LlmMessageParam[],
    tools: LlmToolDefinition[],
  ): Promise<LlmAssistantMessage> {
    const endpoint = normalizeBaseUrl(this.config.baseUrl, "/chat/completions");
    // OpenAI-compatible providers all consume the same chat-completions payload shape.
    const payload = await requestJson<OpenAiChatCompletionResponse>(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(
          tools.length
            ? {
                model: this.config.model,
                temperature: 0.1,
                messages,
                tools,
                tool_choice: "auto",
              }
            : {
                model: this.config.model,
                temperature: 0.1,
                messages,
              },
        ),
      },
      "LLM request",
    );

    const choice = payload.choices?.[0];
    if (!choice?.message) {
      throw new Error("The LLM response did not contain a valid message.");
    }

    return {
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
    };
  }

  /**
   * Send a messages request to Anthropic-compatible providers and normalize the response.
   */
  private async completeAnthropic(messages: LlmMessageParam[], tools: LlmToolDefinition[]): Promise<LlmAssistantMessage> {
    const { system, anthropicMessages } = this.buildAnthropicMessages(messages);
    const endpoint = normalizeBaseUrl(this.config.baseUrl, "/messages");
    // Anthropic expects tools and messages in a different shape than OpenAI-compatible APIs.
    const payload = await requestJson<AnthropicMessagesResponse>(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(
          tools.length
            ? {
                model: this.config.model,
                system,
                messages: anthropicMessages,
                tools: tools.map((tool) => ({
                  name: tool.function.name,
                  description: tool.function.description,
                  input_schema: tool.function.parameters,
                })),
                temperature: 0.1,
                max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
              }
            : {
                model: this.config.model,
                system,
                messages: anthropicMessages,
                temperature: 0.1,
                max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
              },
        ),
      },
      "Anthropic request",
    );

    const contentBlocks = payload.content ?? [];
    const content = contentBlocks
      .filter(isAnthropicTextBlock)
      .map((block) => block.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join("\n");

    // Translate Anthropic tool blocks back into the project's OpenAI-like internal representation.
    const toolCalls = contentBlocks
      .filter(isAnthropicToolUseBlock)
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));

    return {
      content: content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  }

  /**
   * Translate the internal message history into Anthropic's split system/messages format.
   */
  private buildAnthropicMessages(messages: LlmMessageParam[]): { system: string | undefined; anthropicMessages: AnthropicMessage[] } {
    const systemParts: string[] = [];
    const anthropicMessages: AnthropicMessage[] = [];
    let pendingToolResults: AnthropicContentBlock[] = [];

    // Anthropic requires tool results to be grouped into a user turn rather than streamed as standalone messages.
    const flushToolResults = () => {
      if (!pendingToolResults.length) {
        return;
      }

      // Tool results must be sent back as a synthetic user turn tied to the earlier tool_use id.
      anthropicMessages.push({
        role: "user",
        content: pendingToolResults,
      });
      pendingToolResults = [];
    };

    for (const message of messages) {
      switch (message.role) {
        case "system":
          systemParts.push(message.content);
          break;

        case "user":
          flushToolResults();
          anthropicMessages.push({
            role: "user",
            content: [{ type: "text", text: message.content }],
          });
          break;

        case "assistant": {
          flushToolResults();
          const content: AnthropicContentBlock[] = [];
          if (message.content?.trim()) {
            content.push({ type: "text", text: message.content });
          }

          for (const toolCall of message.tool_calls ?? []) {
            content.push({
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.function.name,
              input: parseToolArguments(toolCall.function.arguments),
            });
          }

          if (content.length) {
            anthropicMessages.push({
              role: "assistant",
              content,
            });
          }
          break;
        }

        case "tool":
          // Buffer tool results until the next non-tool message so Anthropic receives a single grouped turn.
          pendingToolResults.push({
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: message.content,
            is_error: message.is_error,
          });
          break;
      }
    }

    flushToolResults();

    return {
      system: systemParts.length ? systemParts.join("\n\n") : undefined,
      anthropicMessages,
    };
  }
}
