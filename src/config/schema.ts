// Zod schemas define the persisted/runtime config contract in one place.
import { z } from "zod";

// Restrict dialect values up front so config resolution never has to handle arbitrary strings.
export const databaseDialectSchema = z.enum(["postgres", "mysql"]);
export const llmProviderSchema = z.enum(["openai", "anthropic", "deepseek", "custom"]);
export const llmApiFormatSchema = z.enum(["openai", "anthropic"]);
export const embeddingProviderSchema = z.enum(["aliyun", "openai", "custom"]);
export const databaseOperationAccessSchema = z.enum([
  "read_only",
  "select_update",
  "select_update_delete",
  "select_update_delete_ddl",
]);

// Separate schemas keep validation granular and let stored config compose the full shape.
export const llmConfigSchema = z.object({
  provider: llmProviderSchema,
  apiFormat: llmApiFormatSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
});

export const embeddingConfigSchema = z.object({
  provider: embeddingProviderSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
});

export const databaseConfigSchema = z.object({
  dialect: databaseDialectSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  schema: z.string().min(1).optional(),
  ssl: z.boolean().optional(),
  operationAccess: databaseOperationAccessSchema,
});

export const storedDatabaseEntrySchema = z.object({
  name: z.string().min(1),
  schema: z.string().min(1).optional(),
}).strict();

export const storedDatabaseHostSchema = z.object({
  name: z.string().min(1),
  dialect: databaseDialectSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
  ssl: z.boolean().optional(),
  databases: z.array(storedDatabaseEntrySchema),
});

export const contextCompressionConfigSchema = z.object({
  recentRawTurns: z.number().int().positive(),
  rawHistoryChars: z.number().int().positive(),
  largeToolOutputChars: z.number().int().positive(),
  persistedToolPreviewChars: z.number().int().positive(),
  maxToolCallsPerTurn: z.number().int().positive(),
  maxAgentIterations: z.number().int().positive(),
});

export const tableRenderingConfigSchema = z.object({
  inlineRowLimit: z.number().int().positive(),
  inlineColumnLimit: z.number().int().positive(),
  previewRowLimit: z.number().int().positive(),
});

export const appRuntimeConfigSchema = z.object({
  resultRowLimit: z.number().int().positive(),
  previewRowLimit: z.number().int().positive(),
  tempArtifactRetentionDays: z.number().int().positive(),
  tableRendering: tableRenderingConfigSchema,
  contextCompression: contextCompressionConfigSchema,
});

export const storedAppRuntimeConfigSchema = z.object({
  resultRowLimit: z.number().int().positive().optional(),
  previewRowLimit: z.number().int().positive().optional(),
  tempArtifactRetentionDays: z.number().int().positive().optional(),
  tableRendering: tableRenderingConfigSchema.partial().optional(),
  contextCompression: contextCompressionConfigSchema.partial().optional(),
});

export const storedConfigSchema = z.object({
  llm: llmConfigSchema.partial().optional(),
  embedding: embeddingConfigSchema.partial().optional(),
  databaseHosts: z.array(storedDatabaseHostSchema).optional(),
  activeDatabaseHost: z.string().min(1).optional(),
  activeDatabasePort: z.number().int().positive().optional(),
  activeDatabaseName: z.string().min(1).optional(),
  app: storedAppRuntimeConfigSchema.optional(),
});

export const appConfigSchema = z.object({
  llm: llmConfigSchema,
  embedding: embeddingConfigSchema,
  database: databaseConfigSchema,
  app: appRuntimeConfigSchema,
});
