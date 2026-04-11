// Shared wire-format types used by the provider-specific client implementation.
/**
 * A single function schema exposed to provider tool-calling APIs.
 */
export interface LlmToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Provider-agnostic wrapper for a function-style tool declaration.
 */
export interface LlmToolDefinition {
  type: "function";
  function: LlmToolFunctionDefinition;
}

/**
 * A provider-normalized tool invocation returned by the model.
 */
export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Union of message shapes used internally before provider-specific translation.
 */
export type LlmMessageParam =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: LlmToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
      is_error?: boolean;
    };

/**
 * The normalized assistant payload returned by the LLM client.
 */
export interface LlmAssistantMessage {
  content: string | null;
  tool_calls?: LlmToolCall[];
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
    tool_calls?: LlmToolCall[];
  };
}

/**
 * Minimal OpenAI-compatible response fields used by the project.
 */
export interface OpenAiChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
}

/**
 * Anthropic content blocks normalized into the subset this project consumes.
 */
export type AnthropicContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/**
 * One Anthropic messages API turn after provider-specific translation.
 */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

/**
 * Minimal Anthropic messages response fields used by the project.
 */
export interface AnthropicMessagesResponse {
  content?: Array<
    | {
        type: "text";
        text?: string;
      }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
  >;
  error?: {
    message?: string;
  };
}
