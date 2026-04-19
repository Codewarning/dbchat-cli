import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_APP_CONFIG } from "../config/defaults.js";
import { getConfigDirectory } from "../config/paths.js";

const TEMP_ARTIFACTS_RELATIVE_DIRECTORY = "tmp";
const DEFAULT_RETENTION_DAYS = DEFAULT_APP_CONFIG.tempArtifactRetentionDays;

function sanitizeFileLabel(value: string | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "artifact";
}

function buildTimestampLabel(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".000Z", "Z").replace("T", "-");
}

function getEntryCreatedAtMs(stats: Awaited<ReturnType<typeof stat>>): number {
  const birthtimeMs = Number(stats.birthtimeMs);
  const mtimeMs = Number(stats.mtimeMs);
  return Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : mtimeMs;
}

/**
 * Return the temp directory used for generated HTML and export artifacts under the user config directory.
 */
export async function getWorkspaceTempArtifactsDirectory(): Promise<string> {
  const directory = path.join(getConfigDirectory(), TEMP_ARTIFACTS_RELATIVE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * Build one unique artifact path under the app temp directory.
 */
export async function createWorkspaceTempArtifactPath(
  options: {
    prefix: string;
    extension: string;
    suggestedName?: string;
  },
): Promise<string> {
  const directory = await getWorkspaceTempArtifactsDirectory();
  const extension = options.extension.startsWith(".") ? options.extension : `.${options.extension}`;
  const suggestedStem = options.suggestedName ? path.parse(options.suggestedName).name : "";
  const fileName = [
    sanitizeFileLabel(options.prefix),
    sanitizeFileLabel(suggestedStem),
    buildTimestampLabel(),
    String(process.pid),
    Math.random().toString(16).slice(2, 10),
  ].join("-");

  return path.join(directory, `${fileName}${extension}`);
}

/**
 * Delete old generated artifacts from the app temp directory.
 */
export async function cleanupExpiredWorkspaceTempArtifacts(
  options?: {
    now?: number;
    retentionDays?: number;
  },
): Promise<void> {
  const directory = await getWorkspaceTempArtifactsDirectory();
  const retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = (options?.now ?? Date.now()) - retentionMs;
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.name !== ".probe")
      .map(async (entry) => {
        const entryPath = path.join(directory, entry.name);

        try {
          const stats = await stat(entryPath);
          if (getEntryCreatedAtMs(stats) < cutoff) {
            await rm(entryPath, { recursive: true, force: true });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }),
  );
}

/**
 * Convert one filesystem path into a browser-openable file URL.
 */
export function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
