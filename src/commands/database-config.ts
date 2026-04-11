import type { DatabaseConfig } from "../types/index.js";
import type { NormalizedStoredConfig } from "../config/database-hosts.js";
import {
  cloneNormalizedStoredConfig,
  findDatabaseEntry,
  getActiveDatabaseHost,
  resolveNormalizedDatabaseConfig,
} from "../config/database-hosts.js";
import { loadNormalizedStoredConfig, saveNormalizedStoredConfig } from "../config/store.js";
import type { PromptRuntime } from "../ui/prompts.js";
import {
  ensureUniqueDatabaseName,
  ensureUniqueHostAddress,
  ensureUniqueHostName,
  promptDatabaseEntryConfig,
  promptDatabaseHostConfig,
  promptForExistingDatabase,
  promptForLiveDatabaseName,
  requireDatabaseEntry,
  listLiveDatabaseNamesForHost,
  resolveCommandHost,
  resolveInteractiveCommandHost,
  setActiveSelection,
  syncSelectionAfterHostRemoval,
} from "./database-config-helpers.js";

export interface DatabaseConfigCommandOutcome {
  message: string;
  previousConfig: NormalizedStoredConfig;
  nextConfig: NormalizedStoredConfig;
  previousActiveTarget: DatabaseConfig | null;
  nextActiveTarget: DatabaseConfig | null;
}

/**
 * Convert before/after config snapshots into one reusable command outcome.
 */
function buildOutcome(
  previousConfig: NormalizedStoredConfig,
  nextConfig: NormalizedStoredConfig,
  message: string,
): DatabaseConfigCommandOutcome {
  return {
    message,
    previousConfig: cloneNormalizedStoredConfig(previousConfig),
    nextConfig: cloneNormalizedStoredConfig(nextConfig),
    previousActiveTarget: resolveNormalizedDatabaseConfig(previousConfig) ?? null,
    nextActiveTarget: resolveNormalizedDatabaseConfig(nextConfig) ?? null,
  };
}

/**
 * Persist the updated config and return a before/after outcome snapshot.
 */
async function saveOutcome(
  previousConfig: NormalizedStoredConfig,
  nextConfig: NormalizedStoredConfig,
  message: string,
): Promise<DatabaseConfigCommandOutcome> {
  await saveNormalizedStoredConfig(nextConfig);
  return buildOutcome(previousConfig, nextConfig, message);
}

/**
 * Reuse the current or default schema when a live-discovered PostgreSQL database is first saved locally.
 */
function resolveSchemaForDiscoveredDatabase(
  host: NonNullable<ReturnType<typeof getActiveDatabaseHost>>,
  defaultDatabaseName?: string,
): string | undefined {
  if (host.dialect !== "postgres") {
    return undefined;
  }

  return (defaultDatabaseName ? findDatabaseEntry(host, defaultDatabaseName)?.schema : undefined) ?? host.databases[0]?.schema ?? "public";
}

/**
 * Resolve one user-supplied database name against the live list returned by the target host.
 */
function requireLiveDatabaseName(hostName: string, liveDatabaseNames: string[], requestedName: string): string {
  const exactMatch = liveDatabaseNames.find((databaseName) => databaseName === requestedName);
  if (exactMatch) {
    return exactMatch;
  }

  const caseInsensitiveMatch = liveDatabaseNames.find((databaseName) => databaseName.toLowerCase() === requestedName.toLowerCase());
  if (caseInsensitiveMatch) {
    return caseInsensitiveMatch;
  }

  throw new Error(`Database '${requestedName}' is not visible on host '${hostName}'.`);
}

/**
 * Load the normalized config for list-style read-only commands.
 */
export async function loadDatabaseConfigList(): Promise<NormalizedStoredConfig> {
  return loadNormalizedStoredConfig();
}

/**
 * Add one new host config with its first database entry.
 */
export async function addHostConfig(prompts: PromptRuntime, hostName?: string): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const activeHost = getActiveDatabaseHost(config);
  const activeDatabase = activeHost ? activeHost.databases[0] : undefined;
  const hostConfig = await promptDatabaseHostConfig(prompts, activeHost ? { ...activeHost, name: hostName ?? "" } : { name: hostName ?? "" });
  ensureUniqueHostName(config, hostConfig.name);
  ensureUniqueHostAddress(config, hostConfig);

  const databaseEntry = await promptDatabaseEntryConfig(prompts, hostConfig.dialect, {
    name: "",
    schema: activeDatabase?.schema,
  });
  config.databaseHosts.push({
    ...hostConfig,
    databases: [databaseEntry],
  });

  if (!config.activeDatabaseHost) {
    setActiveSelection(config, hostConfig.name, databaseEntry.name);
  }

  return saveOutcome(previousConfig, config, `Host config '${hostConfig.name}' was added.`);
}

/**
 * Update one existing host config without touching its database list.
 */
export async function updateHostConfig(prompts: PromptRuntime, hostName?: string): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = await resolveInteractiveCommandHost(prompts, config, hostName, "Select a host config to update");
  const updated = await promptDatabaseHostConfig(prompts, host);
  ensureUniqueHostName(config, updated.name, host.name);
  ensureUniqueHostAddress(config, updated, host.name);

  const previousName = host.name;
  host.name = updated.name;
  host.dialect = updated.dialect;
  host.host = updated.host;
  host.port = updated.port;
  host.username = updated.username;
  host.password = updated.password;
  host.ssl = updated.ssl;

  if (config.activeDatabaseHost === previousName) {
    config.activeDatabaseHost = updated.name;
  }

  return saveOutcome(previousConfig, config, `Host config '${previousName}' was updated.`);
}

/**
 * Remove one host config and all databases grouped under it.
 */
export async function removeHostConfig(prompts: PromptRuntime, hostName?: string): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = await resolveInteractiveCommandHost(prompts, config, hostName, "Select a host config to remove");
  const approved = await prompts.confirm(
    `Remove host config '${host.name}' and its ${host.databases.length} stored database entry${host.databases.length === 1 ? "" : "ies"}?`,
    false,
  );
  if (!approved) {
    return buildOutcome(previousConfig, config, "Removal cancelled.");
  }

  config.databaseHosts = config.databaseHosts.filter((entry) => entry.name !== host.name);
  if (config.activeDatabaseHost === host.name) {
    syncSelectionAfterHostRemoval(config);
  }

  return saveOutcome(previousConfig, config, `Host config '${host.name}' was removed.`);
}

/**
 * Switch the active host config and default its active database to the first entry under that host.
 */
export async function useHostConfig(prompts: PromptRuntime, hostName?: string): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = await resolveInteractiveCommandHost(prompts, config, hostName, "Select a host config to use");
  setActiveSelection(config, host.name);
  return saveOutcome(previousConfig, config, `Active host switched to '${host.name}'. Active database: ${config.activeDatabaseName ?? "(none)"}`);
}

/**
 * Add one new database entry under the selected host config.
 */
export async function addDatabaseConfig(
  prompts: PromptRuntime,
  databaseName?: string,
  hostName?: string,
): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = resolveCommandHost(config, hostName);
  const databaseEntry = await promptDatabaseEntryConfig(prompts, host.dialect, {
    name: databaseName ?? "",
    schema: host.databases[0]?.schema,
  });
  ensureUniqueDatabaseName(host, databaseEntry.name);
  host.databases.push(databaseEntry);

  if (config.activeDatabaseHost === host.name && !config.activeDatabaseName) {
    config.activeDatabaseName = databaseEntry.name;
  }

  return saveOutcome(previousConfig, config, `Database '${databaseEntry.name}' was added under host '${host.name}'.`);
}

/**
 * Update one database entry under the selected host config.
 */
export async function updateDatabaseConfig(
  prompts: PromptRuntime,
  databaseName?: string,
  hostName?: string,
): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = await resolveInteractiveCommandHost(prompts, config, hostName, "Select a host config for the database update");
  const defaultDatabaseName = config.activeDatabaseHost === host.name ? config.activeDatabaseName : undefined;
  const database = databaseName
    ? requireDatabaseEntry(host, databaseName)
    : await promptForExistingDatabase(prompts, host, "Select a database to update", defaultDatabaseName);
  const updated = await promptDatabaseEntryConfig(prompts, host.dialect, database);
  ensureUniqueDatabaseName(host, updated.name, database.name);

  const previousName = database.name;
  database.name = updated.name;
  database.schema = updated.schema;

  if (config.activeDatabaseHost === host.name && config.activeDatabaseName === previousName) {
    config.activeDatabaseName = updated.name;
  }

  return saveOutcome(previousConfig, config, `Database '${previousName}' under host '${host.name}' was updated.`);
}

/**
 * Remove one database entry from the selected host config.
 */
export async function removeDatabaseConfig(
  prompts: PromptRuntime,
  databaseName?: string,
  hostName?: string,
): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = await resolveInteractiveCommandHost(prompts, config, hostName, "Select a host config for the database removal");
  if (host.databases.length <= 1) {
    throw new Error(`Cannot remove the last database from host '${host.name}'. Remove the host config instead.`);
  }

  const defaultDatabaseName = config.activeDatabaseHost === host.name ? config.activeDatabaseName : undefined;
  const database = databaseName
    ? requireDatabaseEntry(host, databaseName)
    : await promptForExistingDatabase(prompts, host, "Select a database to remove", defaultDatabaseName);
  const approved = await prompts.confirm(`Remove database '${database.name}' from host '${host.name}'?`, false);
  if (!approved) {
    return buildOutcome(previousConfig, config, "Removal cancelled.");
  }

  host.databases = host.databases.filter((entry) => entry.name !== database.name);
  if (config.activeDatabaseHost === host.name && config.activeDatabaseName === database.name) {
    config.activeDatabaseName = host.databases[0]?.name;
  }

  return saveOutcome(previousConfig, config, `Database '${database.name}' was removed from host '${host.name}'.`);
}

/**
 * Switch the active database under the selected or active host config.
 */
export async function useDatabaseConfig(
  prompts: PromptRuntime,
  databaseName?: string,
  hostName?: string,
): Promise<DatabaseConfigCommandOutcome> {
  const config = await loadNormalizedStoredConfig();
  const previousConfig = cloneNormalizedStoredConfig(config);
  const host = await resolveInteractiveCommandHost(prompts, config, hostName, "Select a host config for the database switch");
  const defaultDatabaseName = config.activeDatabaseHost === host.name ? config.activeDatabaseName : undefined;
  const liveDatabaseNames = await listLiveDatabaseNamesForHost(host, defaultDatabaseName);
  const selectedDatabaseName = databaseName
    ? requireLiveDatabaseName(host.name, liveDatabaseNames, databaseName)
    : await promptForLiveDatabaseName(prompts, host, liveDatabaseNames, "Select a database to use", defaultDatabaseName);
  let database = findDatabaseEntry(host, selectedDatabaseName);
  let discoveredDatabaseAdded = false;

  if (!database) {
    database = {
      name: selectedDatabaseName,
      schema: resolveSchemaForDiscoveredDatabase(host, defaultDatabaseName),
    };
    host.databases.push(database);
    discoveredDatabaseAdded = true;
  }

  setActiveSelection(config, host.name, database.name);

  const suffix = discoveredDatabaseAdded
    ? database.schema
      ? ` Added it to the stored config with schema '${database.schema}'.`
      : " Added it to the stored config."
    : "";

  return saveOutcome(previousConfig, config, `Active database switched to '${database.name}' under host '${host.name}'.${suffix}`);
}
