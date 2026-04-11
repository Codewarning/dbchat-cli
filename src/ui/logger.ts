// Small terminal logger that supports timestamped lines and transient loading updates.
import process from "node:process";

/**
 * Control handle for a long-running loading indicator.
 */
export interface LoadingHandle {
  fail(message?: string): void;
  succeed(message?: string): void;
}

type LogTone = "normal" | "muted" | "info" | "success" | "warning" | "error" | "accent";
export type LoggerProfile = "compact" | "verbose";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_GRAY = "\u001b[38;5;250m";
const ANSI_BLUE = "\u001b[38;5;81m";
const ANSI_GREEN = "\u001b[38;5;114m";
const ANSI_YELLOW = "\u001b[38;5;221m";
const ANSI_RED = "\u001b[38;5;203m";
const ANSI_MAGENTA = "\u001b[38;5;213m";

/**
 * Detect whether ANSI colors should be emitted for the current terminal.
 */
function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== "1");
}

/**
 * Apply a color theme to one log fragment when color output is enabled.
 */
function colorize(text: string, tone: LogTone, bold = false): string {
  if (!supportsColor()) {
    return text;
  }

  const color =
    tone === "muted"
      ? ANSI_DIM
      : tone === "info"
        ? ANSI_BLUE
        : tone === "success"
          ? ANSI_GREEN
          : tone === "warning"
            ? ANSI_YELLOW
            : tone === "error"
              ? ANSI_RED
              : tone === "accent"
                ? ANSI_MAGENTA
                : ANSI_GRAY;

  const weight = bold ? ANSI_BOLD : "";
  return `${weight}${color}${text}${ANSI_RESET}`;
}

/**
 * Infer a color tone for single-line log messages based on message content.
 */
function inferMessageTone(message: string): LogTone {
  if (/(failed|error|rejected|cancelled)/i.test(message)) {
    return "error";
  }

  if (/(warning|warnings)/i.test(message)) {
    return "warning";
  }

  if (/(done|ready|completed|saved|loaded|granted)/i.test(message)) {
    return "success";
  }

  if (/(tool call|running|loading|fetching|executing|exporting|closing|creating|waiting)/i.test(message)) {
    return "info";
  }

  return "normal";
}

/**
 * Infer a more prominent tone for titled multi-line log blocks.
 */
function inferBlockTone(title: string): LogTone {
  if (/final answer/i.test(title)) {
    return "accent";
  }

  if (/(warning|warnings)/i.test(title)) {
    return "warning";
  }

  if (/(failed|error)/i.test(title)) {
    return "error";
  }

  if (/(plan updated|sql to execute|sql to explain|sql input)/i.test(title)) {
    return "accent";
  }

  return "info";
}

/**
 * Provide plain terminal logging plus transient loading feedback.
 */
export class TerminalLogger {
  private transientLength = 0;
  constructor(private readonly profile: LoggerProfile = "compact") {}

  /**
   * Keep default non-chat terminal output concise while preserving actionable feedback.
   */
  private shouldPrintMessage(message: string): boolean {
    if (this.profile === "verbose") {
      return true;
    }

    const tone = inferMessageTone(message);
    if (tone === "warning" || tone === "error") {
      return true;
    }

    return /(Ink chat UI is unavailable|No active database|Stored selection changed|Active database target changed|Active database connection reloaded|Session cleared)/i.test(
      message,
    );
  }

  /**
   * Keep only high-signal titled blocks outside verbose and chat-mode timelines.
   */
  private shouldPrintBlock(title: string): boolean {
    if (this.profile === "verbose") {
      return true;
    }

    return /(final answer|warning|warnings|failed|error)/i.test(title);
  }

  /**
   * Clear any in-place loading text before printing a normal log line.
   */
  clearTransient(): void {
    if (!process.stdout.isTTY || this.transientLength === 0) {
      return;
    }

    process.stdout.write(`\r${" ".repeat(this.transientLength)}\r`);
    this.transientLength = 0;
  }

  /**
   * Print a single-line log message with inferred styling.
   */
  log(message: string): void {
    if (!this.shouldPrintMessage(message)) {
      return;
    }

    this.clearTransient();
    console.log(colorize(message, inferMessageTone(message)));
  }

  /**
   * Print a titled block with each body line indented for readability.
   */
  logBlock(title: string, body: string): void {
    if (!this.shouldPrintBlock(title)) {
      return;
    }

    // Render multi-line blocks with a simple indent so they remain readable in plain terminals.
    const tone = inferBlockTone(title);
    this.clearTransient();
    console.log(colorize(title, tone, true));
    for (const line of body.split("\n")) {
      console.log(colorize(`  ${line}`, tone === "warning" || tone === "error" ? tone : "muted"));
    }
  }

  /**
   * Start a transient loading indicator that can later be marked as done or failed.
   */
  startLoading(message: string): LoadingHandle {
    const startedAt = Date.now();
    const interactive = Boolean(process.stdout.isTTY);
    let timer: NodeJS.Timeout | null = null;

    const render = () => {
      const seconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
      const line = `${message} ${seconds}s`;

      this.transientLength = line.length;
      process.stdout.write(`\r${colorize(line, "info")}`);
    };

    if (interactive) {
      render();
      timer = setInterval(render, 1000);
    } else {
      console.log(colorize(message, "info"));
    }

    const stop = (status: "done" | "failed", overrideMessage?: string) => {
      if (timer) {
        clearInterval(timer);
      }
      const seconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
      if (interactive) {
        this.clearTransient();
        this.log(overrideMessage ?? `${message} ${status} in ${seconds}s`);
        return;
      }

      if (status === "failed") {
        console.log(colorize(overrideMessage ?? `${message} failed in ${seconds}s`, "error"));
        return;
      }

      if (this.profile === "verbose") {
        console.log(colorize(overrideMessage ?? `${message} done in ${seconds}s`, "success"));
      }
    };

    return {
      succeed: (overrideMessage?: string) => {
        stop("done", overrideMessage);
      },
      fail: (overrideMessage?: string) => {
        stop("failed", overrideMessage);
      },
    };
  }

  /**
   * Wrap an async task with start/stop loading output.
   */
  async withLoading<T>(message: string, task: () => Promise<T>): Promise<T> {
    const handle = this.startLoading(message);

    try {
      const result = await task();
      handle.succeed();
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      handle.fail(`${message} failed: ${errorMessage}`);
      throw error;
    }
  }
}
