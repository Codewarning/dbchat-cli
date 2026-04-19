import { readFile } from "node:fs/promises";
import path from "node:path";
import { getConfigDirectory } from "../config/paths.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import type { DatabaseConfig, SchemaCatalog } from "../types/index.js";

export const SCHEMA_CATALOG_VERSION = 9;

/**
 * Build a filesystem-safe but readable fragment for one database identifier component.
 */
function sanitizePathFragment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

/**
 * Build one readable path segment for the host and port scope.
 */
function buildHostScopeFragment(config: DatabaseConfig): string {
  return `${sanitizePathFragment(config.host)}-${config.port}`;
}

/**
 * Build the persisted schema catalog relative directory for one database target.
 */
function buildSchemaCatalogRelativeDirectory(config: DatabaseConfig): string {
  const schemaName = config.dialect === "mysql" ? "public" : config.schema ?? "default";
  const dialectDirectory = sanitizePathFragment(config.dialect);
  const hostDirectory = buildHostScopeFragment(config);
  const databaseDirectory = sanitizePathFragment(config.database);
  const schemaDirectory = sanitizePathFragment(schemaName);

  return path.join(dialectDirectory, hostDirectory, databaseDirectory, schemaDirectory);
}

/**
 * Return the directory that stores on-disk schema catalogs.
 */
export function getSchemaCatalogDirectory(): string {
  return path.join(getConfigDirectory(), "schema-catalog");
}

/**
 * Return the scope directory for one database target.
 */
export function getSchemaCatalogScopeDirectory(config: DatabaseConfig): string {
  return path.join(getSchemaCatalogDirectory(), buildSchemaCatalogRelativeDirectory(config));
}

/**
 * Return the full catalog path for one database target.
 */
export function getSchemaCatalogPath(config: DatabaseConfig): string {
  return path.join(getSchemaCatalogScopeDirectory(config), "catalog.json");
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
