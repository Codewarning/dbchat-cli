import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const PROJECT_ENV_FILE = ".env";
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const syncEnvDefaultsCache = new Map<string, Record<string, string>>();

function parseQuotedEnvValue(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value.at(-1) !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (quote === "'") {
    return inner;
  }

  return inner.replace(/\\([nrt"\\])/gu, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\"":
        return "\"";
      case "\\":
        return "\\";
      default:
        return escaped;
    }
  });
}

function stripInlineComment(value: string): string {
  const commentIndex = value.search(/\s#/u);
  if (commentIndex < 0) {
    return value;
  }

  return value.slice(0, commentIndex).trimEnd();
}

/**
 * Parse a simple dotenv-style file into string key/value pairs.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/u);

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const normalizedLine = trimmedLine.startsWith("export ") ? trimmedLine.slice("export ".length).trimStart() : trimmedLine;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!VALID_ENV_KEY.test(key)) {
      continue;
    }

    const rawValue = normalizedLine.slice(separatorIndex + 1).trim();
    const value =
      rawValue.startsWith("\"") || rawValue.startsWith("'")
        ? parseQuotedEnvValue(rawValue)
        : stripInlineComment(rawValue);
    parsed[key] = value;
  }

  return parsed;
}

/**
 * Load project-level environment defaults from the current workspace root.
 */
export async function loadProjectEnvDefaults(cwd = process.cwd()): Promise<Record<string, string>> {
  const envPath = path.join(cwd, PROJECT_ENV_FILE);
  try {
    return parseEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

/**
 * Load project-level environment defaults synchronously for terminal-only runtime checks.
 */
export function loadProjectEnvDefaultsSync(cwd = process.cwd()): Record<string, string> {
  if (syncEnvDefaultsCache.has(cwd)) {
    return syncEnvDefaultsCache.get(cwd)!;
  }

  const envPath = path.join(cwd, PROJECT_ENV_FILE);
  try {
    const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
    syncEnvDefaultsCache.set(cwd, parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      syncEnvDefaultsCache.set(cwd, {});
      return {};
    }

    throw error;
  }
}
