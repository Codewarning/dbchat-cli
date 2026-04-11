import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { DEFAULT_EMBEDDING_MODEL_DOWNLOAD_URLS, DEFAULT_EMBEDDING_MODEL_URL } from "../config/defaults.js";
import { getConfigDirectory } from "../config/paths.js";
import type { AgentIO, ProgressHandle } from "../types/index.js";

const DOWNLOAD_RENDER_INTERVAL_MS = 100;
const PROGRESS_BAR_WIDTH = 24;

export interface EmbeddingModelInfo {
  modelUrl: string;
  modelPath: string;
  modelId: string;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let normalized = value / 1024;
  let unitIndex = 0;
  while (normalized >= 1024 && unitIndex < units.length - 1) {
    normalized /= 1024;
    unitIndex += 1;
  }

  return `${normalized.toFixed(normalized >= 100 ? 0 : normalized >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function buildProgressBar(completed: number, total: number): string {
  if (!total) {
    return `${"=".repeat(Math.floor(PROGRESS_BAR_WIDTH / 2)).padEnd(PROGRESS_BAR_WIDTH, ".")}`;
  }

  const ratio = Math.max(0, Math.min(1, completed / total));
  const filled = Math.round(PROGRESS_BAR_WIDTH * ratio);
  return `${"=".repeat(filled)}${".".repeat(PROGRESS_BAR_WIDTH - filled)}`;
}

function renderDownloadProgress(label: string, downloadedBytes: number, totalBytes: number | null): void {
  if (!process.stdout.isTTY) {
    return;
  }

  const progressText = totalBytes ? `${Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)).toString().padStart(3, " ")}%` : " --%";
  const sizeText = totalBytes ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}` : `${formatBytes(downloadedBytes)} downloaded`;
  const line = `${label} [${buildProgressBar(downloadedBytes, totalBytes ?? 0)}] ${progressText} ${sizeText}`;
  process.stdout.write(`\r${line}`);
}

function finishDownloadProgress(message: string): void {
  if (!process.stdout.isTTY) {
    console.log(message);
    return;
  }

  process.stdout.write(`\r${" ".repeat(120)}\r`);
  console.log(message);
}

function clearDownloadProgressLine(): void {
  if (!process.stdout.isTTY) {
    return;
  }

  process.stdout.write(`\r${" ".repeat(120)}\r`);
}

function getTempDownloadPath(destinationPath: string): string {
  return `${destinationPath}.download`;
}

function getDecodedModelFileName(modelUrl: string): string {
  const parsedUrl = new URL(modelUrl);
  const rawName = path.basename(parsedUrl.pathname) || "embedding-model.gguf";
  return decodeURIComponent(rawName);
}

function getModelFileName(modelUrl: string): string {
  const decodedName = getDecodedModelFileName(modelUrl);
  const extension = path.extname(decodedName) || ".gguf";
  const baseName = path.basename(decodedName, extension).replace(/[^a-zA-Z0-9._-]+/g, "-") || "embedding-model";
  return `${baseName}${extension}`;
}

function getLegacyHashedModelFileName(modelUrl: string): string {
  const decodedName = getDecodedModelFileName(modelUrl);
  const extension = path.extname(decodedName) || ".gguf";
  const baseName = path.basename(decodedName, extension).replace(/[^a-zA-Z0-9._-]+/g, "-") || "embedding-model";
  const digest = createHash("sha256").update(modelUrl).digest("hex").slice(0, 10);
  return `${baseName}-${digest}${extension}`;
}

async function findExistingModelPath(modelUrl: string): Promise<string | null> {
  const modelDirectory = getEmbeddingModelDirectory();
  const canonicalPath = path.join(modelDirectory, getModelFileName(modelUrl));
  const decodedLegacyPath = path.join(modelDirectory, getDecodedModelFileName(modelUrl));
  const hashedLegacyPath = path.join(modelDirectory, getLegacyHashedModelFileName(modelUrl));

  for (const candidatePath of [canonicalPath, decodedLegacyPath, hashedLegacyPath]) {
    try {
      const file = await stat(candidatePath);
      if (file.isFile() && file.size > 0) {
        return candidatePath;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return null;
}

function parsePositiveIntegerHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export interface EmbeddingDownloadOptions {
  createProgressHandle?: (message: string) => ProgressHandle | undefined;
}

async function downloadModelFile(sourceUrl: string, destinationPath: string, progressHandle?: ProgressHandle): Promise<void> {
  const tempPath = getTempDownloadPath(destinationPath);
  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Embedding model download failed with HTTP ${response.status}.`);
  }

  const totalBytes = parsePositiveIntegerHeader(response.headers.get("content-length"));
  if (!progressHandle) {
    clearDownloadProgressLine();
    console.log(`Downloading embedding model from ${sourceUrl}`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await rm(tempPath, { force: true }).catch(() => undefined);
  const stream = createWriteStream(tempPath, { flags: "w" });
  const reader = response.body.getReader();
  let downloadedBytes = 0;
  let lastRenderAt = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value?.length) {
        continue;
      }

      downloadedBytes += value.byteLength;
      if (!stream.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          const handleDrain = () => {
            stream.off("error", handleError);
            resolve();
          };
          const handleError = (error: Error) => {
            stream.off("drain", handleDrain);
            reject(error);
          };

          stream.once("drain", handleDrain);
          stream.once("error", handleError);
        });
      }

      const now = Date.now();
      if (now - lastRenderAt >= DOWNLOAD_RENDER_INTERVAL_MS || (totalBytes !== null && downloadedBytes >= totalBytes)) {
        if (progressHandle) {
          progressHandle.update({
            message: `Downloading embedding model from ${sourceUrl}`,
            completed: downloadedBytes,
            total: totalBytes,
            unit: "bytes",
          });
        } else {
          renderDownloadProgress("Downloading embedding model", downloadedBytes, totalBytes);
        }
        lastRenderAt = now;
      }
    }

    stream.end();
    await finished(stream);
    await rename(tempPath, destinationPath);
    if (progressHandle) {
      progressHandle.complete(`Embedding model ready: ${destinationPath}`);
    } else {
      finishDownloadProgress(`Embedding model ready: ${destinationPath}`);
    }
  } catch (error) {
    stream.destroy();
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (!progressHandle) {
      clearDownloadProgressLine();
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function resolveEmbeddingModelUrl(): string {
  const configuredUrl = process.env.EMBEDDING_MODEL_URL?.trim();
  return configuredUrl || DEFAULT_EMBEDDING_MODEL_URL;
}

export function resolveEmbeddingModelDownloadUrls(modelUrl = resolveEmbeddingModelUrl()): string[] {
  if (modelUrl === DEFAULT_EMBEDDING_MODEL_URL) {
    return [...DEFAULT_EMBEDDING_MODEL_DOWNLOAD_URLS];
  }

  return [modelUrl];
}

export function getEmbeddingModelDirectory(): string {
  return path.join(getConfigDirectory(), "models");
}

export function getEmbeddingModelInfo(modelUrl = resolveEmbeddingModelUrl()): EmbeddingModelInfo {
  const fileName = getModelFileName(modelUrl);
  return {
    modelUrl,
    modelPath: path.join(getEmbeddingModelDirectory(), fileName),
    modelId: fileName,
  };
}

export async function isEmbeddingModelDownloaded(modelUrl = resolveEmbeddingModelUrl()): Promise<boolean> {
  return (await findExistingModelPath(modelUrl)) !== null;
}

const embeddingModelReadyPromises = new Map<string, Promise<EmbeddingModelInfo>>();

export async function ensureEmbeddingModelDownloaded(
  modelUrl = resolveEmbeddingModelUrl(),
  options?: EmbeddingDownloadOptions,
): Promise<EmbeddingModelInfo> {
  const modelInfo = getEmbeddingModelInfo(modelUrl);
  const modelKey = modelInfo.modelId;
  const existingPromise = embeddingModelReadyPromises.get(modelKey);
  if (existingPromise) {
    return existingPromise;
  }

  const loadingPromise = (async () => {
    const existingModelPath = await findExistingModelPath(modelUrl);
    if (existingModelPath) {
      return {
        modelUrl,
        modelPath: existingModelPath,
        modelId: modelKey,
      };
    }

    await mkdir(getEmbeddingModelDirectory(), { recursive: true });
    const progressHandle = options?.createProgressHandle?.("Downloading embedding model");
    const candidateUrls = resolveEmbeddingModelDownloadUrls(modelUrl);
    let lastError: Error | null = null;

    for (const [index, candidateUrl] of candidateUrls.entries()) {
      try {
        await downloadModelFile(candidateUrl, modelInfo.modelPath, progressHandle);
        return modelInfo;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (index < candidateUrls.length - 1) {
          const retryMessage = `Embedding model download failed from ${candidateUrl}. Retrying with the next source.`;
          if (progressHandle) {
            progressHandle.update({
              message: retryMessage,
              completed: 0,
              total: null,
              unit: "bytes",
            });
          } else {
            console.warn(retryMessage);
          }
          continue;
        }
      }
    }

    if (progressHandle && lastError) {
      progressHandle.fail(`Embedding model download failed: ${lastError.message}`);
    }

    throw lastError ?? new Error("Embedding model download failed.");
  })().catch((error) => {
    embeddingModelReadyPromises.delete(modelKey);
    throw error;
  });
  embeddingModelReadyPromises.set(modelKey, loadingPromise);

  return loadingPromise;
}

export async function ensureEmbeddingModelReady(
  io?: Pick<AgentIO, "createProgressHandle">,
  modelUrl = resolveEmbeddingModelUrl(),
): Promise<EmbeddingModelInfo> {
  return ensureEmbeddingModelDownloaded(modelUrl, {
    createProgressHandle: (message) => io?.createProgressHandle?.(message),
  });
}
