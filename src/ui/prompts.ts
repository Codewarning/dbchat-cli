// Minimal readline-based terminal prompts shared by commands and tool confirmations.
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { SqlApprovalDecision } from "../types/index.js";

/**
 * A single labeled option displayed in a terminal select prompt.
 */
export interface SelectChoice<T extends string> {
  label: string;
  value: T;
}

export interface PromptRuntime {
  input(message: string, defaultValue?: string): Promise<string>;
  password(message: string, defaultValue?: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  approveSql(message: string): Promise<SqlApprovalDecision>;
  select<T extends string>(message: string, choices: SelectChoice<T>[], defaultValue?: T): Promise<T>;
  selectOrInput(
    message: string,
    choices: SelectChoice<string>[],
    defaultValue?: string,
    customPromptMessage?: string,
    customLabel?: string,
  ): Promise<string>;
}

interface InteractiveSelectChoice<T extends string> extends SelectChoice<T> {
  note?: string;
}

const CUSTOM_SELECT_VALUE = "__custom__";
const APPROVE_ONCE_VALUE: SqlApprovalDecision = "approve_once";
const APPROVE_ALL_VALUE: SqlApprovalDecision = "approve_all";
const REJECT_SQL_VALUE: SqlApprovalDecision = "reject";

function deduplicateChoices<T extends string>(choices: SelectChoice<T>[]): SelectChoice<T>[] {
  return choices.filter((choice, index) => choices.findIndex((candidate) => candidate.value === choice.value) === index);
}

function buildInteractiveChoices<T extends string>(choices: SelectChoice<T>[], defaultValue?: T): InteractiveSelectChoice<T>[] {
  return choices.map((choice) => ({
    ...choice,
    note: choice.value === defaultValue ? "(default)" : undefined,
  }));
}

async function selectByNumber<T extends string>(
  question: (prompt: string) => Promise<string>,
  message: string,
  choices: SelectChoice<T>[],
  defaultValue?: T,
): Promise<T> {
  console.log(message);
  choices.forEach((choice, index) => {
    const marker = choice.value === defaultValue ? " (default)" : "";
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });

  const answer = (await question("Enter a number: ")).trim();
  if (!answer && defaultValue) {
    return defaultValue;
  }

  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > choices.length) {
    throw new Error("Invalid selection.");
  }

  return choices[index - 1]!.value;
}

export function buildSelectOrInputChoices(
  choices: SelectChoice<string>[],
  defaultValue = "",
  customLabel = "Custom value",
  customValue = CUSTOM_SELECT_VALUE,
): {
  choices: Array<SelectChoice<string>>;
  defaultSelection: string | undefined;
} {
  const deduplicatedChoices = deduplicateChoices(choices);

  if (defaultValue && !deduplicatedChoices.some((choice) => choice.value === defaultValue)) {
    deduplicatedChoices.unshift({
      label: defaultValue,
      value: defaultValue,
    });
  }

  const defaultSelection =
    defaultValue && deduplicatedChoices.some((choice) => choice.value === defaultValue) ? defaultValue : undefined;

  return {
    choices: [
      ...deduplicatedChoices,
      {
        label: customLabel,
        value: customValue,
      },
    ],
    defaultSelection,
  };
}

/**
 * Ask one question and resolve with the raw terminal input.
 */
async function ask(question: string): Promise<string> {
  // Create a short-lived readline instance per prompt to keep the helpers stateless.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a secret value while masking typed characters in interactive terminals.
 */
async function promptHiddenInput(message: string, defaultValue = ""): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return promptInput(message, defaultValue);
  }

  emitKeypressEvents(process.stdin);
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = Boolean(input.isRaw);
  const suffix = defaultValue ? " (press Enter to keep current value)" : "";
  let value = "";

  return await new Promise<string>((resolve, reject) => {
    const render = () => {
      output.write(`\r\u001b[2K${message}${suffix}: ${"*".repeat(value.length)}`);
    };

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write("\n");
    };

    const finish = (nextValue: string) => {
      cleanup();
      resolve(nextValue);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        fail(new Error("Prompt cancelled."));
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish(value || defaultValue);
        return;
      }

      if (key.name === "escape") {
        value = "";
        render();
        return;
      }

      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        render();
        return;
      }

      if (!key.ctrl && !key.meta && text) {
        value += text;
        render();
      }
    };

    input.on("keypress", onKeypress);
    input.setRawMode(true);
    input.resume();
    render();
  });
}

/**
 * Render a terminal selection list controlled by arrow keys and Enter.
 */
async function promptInteractiveSelect<T extends string>(
  message: string,
  choices: InteractiveSelectChoice<T>[],
  defaultValue?: T,
): Promise<T> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive selection requires a TTY.");
  }

  emitKeypressEvents(process.stdin);
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = Boolean(input.isRaw);
  let activeIndex = Math.max(
    0,
    defaultValue ? choices.findIndex((choice) => choice.value === defaultValue) : 0,
  );
  if (activeIndex < 0) {
    activeIndex = 0;
  }

  let renderedLineCount = 0;

  const clearRender = () => {
    for (let index = 0; index < renderedLineCount; index += 1) {
      output.write("\u001b[2K");
      if (index < renderedLineCount - 1) {
        output.write("\u001b[1A");
      }
    }

    if (renderedLineCount > 0) {
      output.write("\r");
    }
  };

  const render = () => {
    clearRender();
    const lines = [
      message,
      ...choices.map((choice, index) => {
        const isActive = index === activeIndex;
        const prefix = isActive ? "> " : "  ";
        const suffix = choice.note ? ` ${choice.note}` : "";
        return `${prefix}${choice.label}${suffix}`;
      }),
      "Use Up/Down to choose and Enter to confirm.",
    ];

    output.write(`${lines.join("\n")}\n`);
    renderedLineCount = lines.length + 1;
  };

  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(previousRawMode);
      // Always pause stdin after the menu finishes so one-shot CLI commands can exit cleanly.
      input.pause();
      clearRender();
      renderedLineCount = 0;
    };

    const finish = (value: T) => {
      const selected = choices[activeIndex]!;
      cleanup();
      console.log(`${message}: ${selected.label}`);
      resolve(value);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        fail(new Error("Prompt cancelled."));
        return;
      }

      if (key.name === "up") {
        activeIndex = activeIndex === 0 ? choices.length - 1 : activeIndex - 1;
        render();
        return;
      }

      if (key.name === "down") {
        activeIndex = activeIndex === choices.length - 1 ? 0 : activeIndex + 1;
        render();
        return;
      }

      if (key.name === "left" || key.name === "right") {
        if (choices.length === 2) {
          activeIndex = activeIndex === 0 ? 1 : 0;
          render();
        }
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish(choices[activeIndex]!.value);
      }
    };

    input.on("keypress", onKeypress);
    input.setRawMode(true);
    input.resume();
    render();
  });
}

/**
 * Parse a yes/no answer while honoring the caller's default when the input is empty.
 */
export function parseConfirmAnswer(answer: string, defaultValue = false): boolean {
  const normalized = answer.trim().toLowerCase();

  if (!normalized) {
    return defaultValue;
  }

  return normalized === "y" || normalized === "yes";
}

/**
 * Prompt for free-form text with an optional default value.
 */
export async function promptInput(message: string, defaultValue = ""): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = (await ask(`${message}${suffix}: `)).trim();
  return answer || defaultValue;
}

/**
 * Prompt for a secret value while currently reusing the plain text input flow.
 */
export async function promptPassword(message: string, defaultValue = ""): Promise<string> {
  return promptHiddenInput(message, defaultValue);
}

/**
 * Prompt for confirmation and convert the answer into a boolean.
 */
export async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const selected = await promptInteractiveSelect(
      message,
      [
        { label: "Yes", value: "yes", note: defaultValue ? "(default)" : "" },
        { label: "No", value: "no", note: !defaultValue ? "(default)" : "" },
      ],
      defaultValue ? "yes" : "no",
    );
    return selected === "yes";
  }

  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = await ask(`${message} [${suffix}]: `);
  return parseConfirmAnswer(answer, defaultValue);
}

/**
 * Prompt for SQL approval using safe-by-default choices.
 */
export async function promptSqlApproval(message: string): Promise<SqlApprovalDecision> {
  return promptSelect<SqlApprovalDecision>(
    message,
    [
      { label: "Approve Once", value: APPROVE_ONCE_VALUE },
      { label: "Approve All For Turn", value: APPROVE_ALL_VALUE },
      { label: "Reject", value: REJECT_SQL_VALUE },
    ],
    REJECT_SQL_VALUE,
  );
}

/**
 * Present choices and return the selected value.
 */
export async function promptSelect<T extends string>(
  message: string,
  choices: SelectChoice<T>[],
  defaultValue?: T,
): Promise<T> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return promptInteractiveSelect(message, buildInteractiveChoices(choices, defaultValue), defaultValue);
  }

  return selectByNumber(ask, message, choices, defaultValue);
}

/**
 * Present common choices first and fall back to free-form input when the user selects a custom option.
 */
export async function promptSelectOrInput(
  message: string,
  choices: SelectChoice<string>[],
  defaultValue = "",
  customPromptMessage = message,
  customLabel = "Custom value",
): Promise<string> {
  const { choices: preparedChoices, defaultSelection } = buildSelectOrInputChoices(
    choices,
    defaultValue,
    customLabel,
    CUSTOM_SELECT_VALUE,
  );
  const selected = await promptSelect(
    message,
    preparedChoices,
    defaultSelection,
  );

  if (selected === CUSTOM_SELECT_VALUE) {
    return promptInput(customPromptMessage, defaultValue);
  }

  return selected;
}

export const defaultPromptRuntime: PromptRuntime = {
  input: promptInput,
  password: promptPassword,
  confirm: promptConfirm,
  approveSql: promptSqlApproval,
  select: promptSelect,
  selectOrInput: promptSelectOrInput,
};

interface QuestionReader {
  question(prompt: string): Promise<string>;
  pause?(): void;
  resume?(): void;
}

async function selectWithQuestionReader<T extends string>(
  reader: QuestionReader,
  message: string,
  choices: SelectChoice<T>[],
  defaultValue?: T,
): Promise<T> {
  return selectByNumber((prompt) => reader.question(prompt), message, choices, defaultValue);
}

export function createReadlinePromptRuntime(reader: QuestionReader): PromptRuntime {
  const input = async (message: string, defaultValue = ""): Promise<string> => {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = (await reader.question(`${message}${suffix}: `)).trim();
    return answer || defaultValue;
  };

  const withPausedReader = async <T>(task: () => Promise<T>): Promise<T> => {
    reader.pause?.();
    try {
      return await task();
    } finally {
      reader.resume?.();
    }
  };

  return {
    input,
    async password(message: string, defaultValue = "") {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return withPausedReader(() => promptHiddenInput(message, defaultValue));
      }

      return input(message, defaultValue);
    },
    async confirm(message: string, defaultValue = false) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const selected = await withPausedReader(() =>
          promptInteractiveSelect(
            message,
            [
              { label: "Yes", value: "yes", note: defaultValue ? "(default)" : "" },
              { label: "No", value: "no", note: !defaultValue ? "(default)" : "" },
            ],
            defaultValue ? "yes" : "no",
          ),
        );
        return selected === "yes";
      }

      const suffix = defaultValue ? "Y/n" : "y/N";
      const answer = await reader.question(`${message} [${suffix}]: `);
      return parseConfirmAnswer(answer, defaultValue);
    },
    async approveSql(message: string) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return withPausedReader(() =>
          promptInteractiveSelect(
            message,
            [
              { label: "Approve Once", value: APPROVE_ONCE_VALUE },
              { label: "Approve All For Turn", value: APPROVE_ALL_VALUE },
              { label: "Reject", value: REJECT_SQL_VALUE, note: "(default)" },
            ],
            REJECT_SQL_VALUE,
          ),
        );
      }

      return selectWithQuestionReader(
        reader,
        message,
        [
          { label: "Approve Once", value: APPROVE_ONCE_VALUE },
          { label: "Approve All For Turn", value: APPROVE_ALL_VALUE },
          { label: "Reject", value: REJECT_SQL_VALUE },
        ],
        REJECT_SQL_VALUE,
      );
    },
    async select<T extends string>(message: string, choices: SelectChoice<T>[], defaultValue?: T) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return withPausedReader(() => promptInteractiveSelect(message, buildInteractiveChoices(choices, defaultValue), defaultValue));
      }

      return selectWithQuestionReader(reader, message, choices, defaultValue);
    },
    async selectOrInput(
      message: string,
      choices: SelectChoice<string>[],
      defaultValue = "",
      customPromptMessage = message,
      customLabel = "Custom value",
    ) {
      const { choices: preparedChoices, defaultSelection } = buildSelectOrInputChoices(
        choices,
        defaultValue,
        customLabel,
        CUSTOM_SELECT_VALUE,
      );
      const selected = await selectWithQuestionReader(
        reader,
        message,
        preparedChoices,
        defaultSelection,
      );

      if (selected === CUSTOM_SELECT_VALUE) {
        return input(customPromptMessage, defaultValue);
      }

      return selected;
    },
  };
}
