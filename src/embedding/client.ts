import type { LlamaEmbeddingContext } from "node-llama-cpp";
import { ensureEmbeddingModelDownloaded } from "./model.js";
import type { ProgressHandle } from "../types/index.js";

function normalizeInput(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Embedding input cannot be empty.");
  }

  return normalized;
}

const embeddingContextPromises = new Map<string, Promise<LlamaEmbeddingContext>>();

export interface EmbeddingRuntimeOptions {
  createModelDownloadProgressHandle?: (message: string) => ProgressHandle | undefined;
}

async function getEmbeddingContext(options?: EmbeddingRuntimeOptions): Promise<LlamaEmbeddingContext> {
  const modelInfo = await ensureEmbeddingModelDownloaded(undefined, {
    createProgressHandle: options?.createModelDownloadProgressHandle,
  });
  const contextKey = modelInfo.modelPath;
  const existingPromise = embeddingContextPromises.get(contextKey);
  if (existingPromise) {
    return existingPromise;
  }

  const loadingPromise = (async () => {
      const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
      const llama = await getLlama({
        // The local embedding model can emit noisy tokenizer warnings for some GGUF files.
        // Keep hard errors visible while suppressing non-actionable startup warnings in the CLI.
        logLevel: LlamaLogLevel.error,
        logger: () => undefined,
      });
      const model = await llama.loadModel({
        modelPath: modelInfo.modelPath,
        gpuLayers: 0,
      });
      return model.createEmbeddingContext();
    })().catch((error) => {
      embeddingContextPromises.delete(contextKey);
      throw error;
    });
  embeddingContextPromises.set(contextKey, loadingPromise);

  return loadingPromise;
}

export async function embedTexts(inputs: string[], options?: EmbeddingRuntimeOptions): Promise<number[][]> {
  const normalizedInputs = inputs.map(normalizeInput);
  const embeddingContext = await getEmbeddingContext(options);
  const vectors: number[][] = [];

  for (const input of normalizedInputs) {
    const embedding = await embeddingContext.getEmbeddingFor(input);
    if (!embedding.vector.length) {
      throw new Error("The local embedding model returned an empty vector.");
    }

    vectors.push([...embedding.vector]);
  }

  return vectors;
}

export async function embedText(input: string, options?: EmbeddingRuntimeOptions): Promise<number[]> {
  const [embedding] = await embedTexts([input], options);
  return embedding;
}
