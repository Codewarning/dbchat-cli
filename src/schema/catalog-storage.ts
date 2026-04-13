import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfigDirectory } from "../config/paths.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import type { DatabaseConfig, SchemaCatalog } from "../types/index.js";

export const SCHEMA_CATALOG_VERSION = 6;

/**
 * Build a filesystem-safe fragment for one database identifier component.
 */
function sanitizePathFragment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "database";
}

/**
 * Build one readable path segment with a short digest to avoid collisions after sanitization.
 */
function buildScopedPathFragment(label: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${sanitizePathFragment(label)}-${digest}`;
}

/**
 * Build the persisted schema catalog relative path for one database target.
 */
function buildSchemaCatalogRelativePath(config: DatabaseConfig): string {
  const schemaName = config.schema ?? "default";
  const dialectDirectory = sanitizePathFragment(config.dialect);
  const hostDirectory = buildScopedPathFragment(`${config.host}-${config.port}`, JSON.stringify({ host: config.host, port: config.port }));
  const databaseDirectory = buildScopedPathFragment(config.database, config.database);
  const schemaFileName = `${buildScopedPathFragment(schemaName, schemaName)}.json`;

  return path.join(dialectDirectory, hostDirectory, databaseDirectory, schemaFileName);
}

/**
 * Return the directory that stores on-disk schema catalogs.
 */
export function getSchemaCatalogDirectory(): string {
  return path.join(getConfigDirectory(), "schema-catalog");
}

/**
 * Return the full catalog path for one database target.
 */
export function getSchemaCatalogPath(config: DatabaseConfig): string {
  return path.join(getSchemaCatalogDirectory(), buildSchemaCatalogRelativePath(config));
}

/**
 * Load the persisted schema catalog for one database target when present.
 */
export async function loadSchemaCatalog(config: DatabaseConfig): Promise<SchemaCatalog | null> {
  try {
    const content = await readFile(getSchemaCatalogPath(config), "utf8");
    const parsed = JSON.parse(content) as SchemaCatalog;
    return parsed?.version === SCHEMA_CATALOG_VERSION ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * Persist one schema catalog to disk for the active database target.
 */
export async function saveSchemaCatalog(config: DatabaseConfig, catalog: SchemaCatalog): Promise<void> {
  const catalogPath = getSchemaCatalogPath(config);
  await writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}
