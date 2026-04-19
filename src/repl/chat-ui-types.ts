import type { PlanItem, ProgressUnit } from "../types/index.js";
import type { SelectChoice } from "../ui/prompts.js";

export type EntryTone = "normal" | "muted" | "info" | "success" | "warning" | "error" | "accent" | "user" | "assistant" | "welcome";

export interface ChatEntry {
  id: string;
  title?: string;
  body: string;
  tone: EntryTone;
  meta?: {
    model?: string;
    database?: string;
    permission?: string;
    plan?: PlanItem[];
    table?: {
      fields: string[];
      rows: Record<string, unknown>[];
    };
  };
}

export interface LoadingTask {
  id: string;
  message: string;
  startedAt: number;
  completed?: number;
  total?: number | null;
  unit?: ProgressUnit;
}

export interface DatabaseSuggestion {
  hostName: string;
  databaseName: string;
  schema?: string;
  isActive: boolean;
}

interface BasePromptRequest<TValue> {
  id: string;
  message: string;
  resolve(value: TValue): void;
  reject(error: Error): void;
}

export interface ConfirmPromptRequest extends BasePromptRequest<boolean> {
  kind: "confirm";
  defaultValue: boolean;
}

export interface InputPromptRequest extends BasePromptRequest<string> {
  kind: "input";
  defaultValue: string;
  secret: boolean;
}

export interface SelectPromptRequest extends BasePromptRequest<string> {
  kind: "select";
  defaultValue?: string;
  choices: SelectChoice<string>[];
}

export type PromptRequest = ConfirmPromptRequest | InputPromptRequest | SelectPromptRequest;
