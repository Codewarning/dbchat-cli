// Zod schemas define the persisted/runtime config contract in one place.
import { z } from "zod";

// Restrict dialect values up front so config resolution never has to handle arbitrary strings.
export const databaseDialectSchema = z.enum(["postgres", "mysql"]);
export const llmProviderSchema = z.enum(["openai", "anthropic", "deepseek", "custom"]);
export const llmApiFormatSchema = z.enum(["openai", "anthropic"]);
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

export const appRuntimeConfigSchema = z.object({
  resultRowLimit: z.number().int().positive(),
  previewRowLimit: z.number().int().positive(),
});

export const storedConfigSchema = z.object({
  llm: llmConfigSchema.partial().optional(),
  databaseHosts: z.array(storedDatabaseHostSchema).optional(),
  activeDatabaseHost: z.string().min(1).optional(),
  activeDatabaseName: z.string().min(1).optional(),
  app: appRuntimeConfigSchema.partial().optional(),
});

export const appConfigSchema = z.object({
  llm: llmConfigSchema,
  database: databaseConfigSchema,
  app: appRuntimeConfigSchema,
});
