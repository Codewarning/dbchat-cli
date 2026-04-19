import path from "node:path";
import process from "node:process";
import { loadProjectEnvDefaultsSync } from "../config/env-file.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_UNDERLINE = "\u001b[4m";
const ANSI_CYAN = "\u001b[38;5;81m";
const OSC8_BEL = "\u0007";
const OSC8_OPEN_PREFIX = "\u001b]8;;";
const OSC8_CLOSE = `${OSC8_OPEN_PREFIX}${OSC8_BEL}`;

const HIGHLIGHTABLE_ARTIFACT_LABELS = new Set(["Open full table in a browser:", "Open the same cached rows as CSV:"]);
const ARTIFACT_LINE_PATTERN =
  /^(?<label>(?:Open full table in a browser|Open the same cached rows as CSV|HTML file|CSV file):)\s+(?<target>.+)$/;
const GENERIC_FILE_LINE_PATTERN = /^(?<label>[^:：\n]{1,80}[:：])\s*(?<target>.+)$/u;

export interface TerminalLinkFormattingOptions {
  prefix?: string;
  ansi?: boolean;
  hyperlinks?: boolean;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

/**
 * Detect whether ANSI styling should be emitted for terminal-facing text.
 */
export function supportsAnsiStyling(stdout: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stdout.isTTY && env.NO_COLOR !== "1");
}

/**
 * Detect whether OSC 8 hyperlinks are likely to work in the active terminal.
 */
export function supportsOsc8Hyperlinks(
  stdout: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
  projectDefaults: NodeJS.ProcessEnv = loadProjectEnvDefaultsSync(process.cwd()),
): boolean {
  const forced = parseBooleanFlag(
    env.FORCE_HYPERLINK ??
      env.DBCHAT_FORCE_HYPERLINK ??
      projectDefaults.FORCE_HYPERLINK ??
      projectDefaults.DBCHAT_FORCE_HYPERLINK,
  );
  if (typeof forced === "boolean") {
    return forced;
  }

  if (!stdout.isTTY || env.TERM === "dumb") {
    return false;
  }

  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  if (termProgram === "vscode" || termProgram === "wezterm" || termProgram === "iterm.app") {
    return true;
  }

  if (env.WT_SESSION || env.DOMTERM || env.KONSOLE_VERSION) {
    return true;
  }

  const vteVersion = Number(env.VTE_VERSION ?? "0");
  return Number.isFinite(vteVersion) && vteVersion >= 5000;
}

function applyAnsi(text: string, codes: string[], enabled: boolean): string {
  if (!enabled) {
    return text;
  }

  return `${codes.join("")}${text}${ANSI_RESET}`;
}

function isFileUrl(value: string): boolean {
  return /^file:\/\//iu.test(value);
}

function encodePathSegments(value: string): string {
  return value
    .split("/")
    .map((segment, index) => {
      if (!segment) {
        return segment;
      }

      if (index === 0 && /^[A-Za-z]:$/u.test(segment)) {
        return segment;
      }

      return encodeURIComponent(segment);
    })
    .join("/");
}

function toFileUrlFromWindowsPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (normalized.startsWith("//")) {
    const [_, __, host, ...segments] = normalized.split("/");
    return `file://${host}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  }

  return `file:///${encodePathSegments(normalized)}`;
}

function resolveArtifactHref(target: string): string | null {
  if (isFileUrl(target)) {
    return target;
  }

  if (path.posix.isAbsolute(target)) {
    return `file://${encodePathSegments(target)}`;
  }

  if (path.win32.isAbsolute(target)) {
    return toFileUrlFromWindowsPath(target);
  }

  return null;
}

function formatHyperlink(displayText: string, href: string | null, enabled: boolean): string {
  if (!enabled || !href) {
    return displayText;
  }

  return `${OSC8_OPEN_PREFIX}${href}${OSC8_BEL}${displayText}${OSC8_CLOSE}`;
}

/**
 * Format one artifact line with ANSI-friendly styling and optional OSC 8 hyperlinks.
 */
export function formatArtifactLineForTerminal(line: string, options: TerminalLinkFormattingOptions = {}): string | null {
  const prefix = options.prefix ?? "";
  const ansi = options.ansi ?? supportsAnsiStyling();
  const hyperlinks = options.hyperlinks ?? supportsOsc8Hyperlinks();
  const explicitMatch = line.match(ARTIFACT_LINE_PATTERN);
  const explicitLabel = explicitMatch?.groups?.label;
  const explicitTarget = explicitMatch?.groups?.target?.trim();
  if (explicitLabel && explicitTarget) {
    const href = resolveArtifactHref(explicitTarget);
    const clickableTarget = formatHyperlink(explicitTarget, href, hyperlinks);

    if (HIGHLIGHTABLE_ARTIFACT_LABELS.has(explicitLabel)) {
      const renderedLabel = applyAnsi(`${prefix}${explicitLabel}`, [ANSI_BOLD, ANSI_CYAN], ansi);
      const renderedTarget = applyAnsi(clickableTarget, [ANSI_CYAN, ANSI_UNDERLINE], ansi);
      return `${renderedLabel} ${renderedTarget}`;
    }

    const renderedTarget = applyAnsi(clickableTarget, [ANSI_CYAN, ANSI_UNDERLINE], ansi);
    return `${prefix}${explicitLabel} ${renderedTarget}`;
  }

  const genericMatch = line.match(GENERIC_FILE_LINE_PATTERN);
  const genericLabel = genericMatch?.groups?.label;
  const genericTarget = genericMatch?.groups?.target?.trim();
  if (genericLabel && genericTarget) {
    const href = resolveArtifactHref(genericTarget);
    if (href) {
      const clickableTarget = formatHyperlink(genericTarget, href, hyperlinks);
      const renderedTarget = applyAnsi(clickableTarget, [ANSI_CYAN, ANSI_UNDERLINE], ansi);
      return `${prefix}${genericLabel} ${renderedTarget}`;
    }
  }

  const trimmed = line.trim();
  const href = resolveArtifactHref(trimmed);
  if (href) {
    const clickableTarget = formatHyperlink(trimmed, href, hyperlinks);
    return `${prefix}${applyAnsi(clickableTarget, [ANSI_CYAN, ANSI_UNDERLINE], ansi)}`;
  }

  return null;
}

/**
 * Format every artifact line inside a multi-line block while leaving other lines unchanged.
 */
export function formatArtifactTextForTerminal(text: string, options: TerminalLinkFormattingOptions = {}): string {
  return text
    .split("\n")
    .map((line) => formatArtifactLineForTerminal(line, options) ?? `${options.prefix ?? ""}${line}`)
    .join("\n");
}
