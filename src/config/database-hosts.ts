import type { DatabaseConfig, StoredConfig, StoredDatabaseEntry, StoredDatabaseHost } from "../types/index.js";
import { DEFAULT_DATABASE_OPERATION_ACCESS } from "../db/operation-access.js";

/**
 * Stored config shape used by CLI config commands after normalization.
 */
export interface NormalizedStoredConfig extends Omit<StoredConfig, "database"> {
  databaseHosts: StoredDatabaseHost[];
  activeDatabaseHost?: string;
  activeDatabasePort?: number;
  activeDatabaseName?: string;
}

function matchesActiveHostSelection(
  config: Pick<NormalizedStoredConfig, "activeDatabaseHost" | "activeDatabasePort">,
  host: Pick<StoredDatabaseHost, "name" | "port">,
): boolean {
  return host.name === config.activeDatabaseHost && (config.activeDatabasePort == null || host.port === config.activeDatabasePort);
}

/**
 * Clone one database entry so config mutation helpers do not share references accidentally.
 */
function cloneDatabaseEntry(entry: StoredDatabaseEntry): StoredDatabaseEntry {
  return {
    name: entry.name,
    schema: entry.schema,
  };
}

/**
 * Clone one host config plus all of its database entries.
 */
function cloneDatabaseHost(host: StoredDatabaseHost): StoredDatabaseHost {
  return {
    name: host.name,
    dialect: host.dialect,
    host: host.host,
    port: host.port,
    username: host.username,
    password: host.password,
    ssl: host.ssl,
    databases: host.databases.map(cloneDatabaseEntry),
  };
}

/**
 * Ensure the active host/database pointers always reference an existing stored entry.
 */
function normalizeActiveSelection(config: NormalizedStoredConfig): void {
  const fallbackHost = config.databaseHosts[0];
  const activeHost = config.databaseHosts.find((host) => matchesActiveHostSelection(config, host)) ?? fallbackHost;

  if (!activeHost) {
    config.activeDatabaseHost = undefined;
    config.activeDatabasePort = undefined;
    config.activeDatabaseName = undefined;
    return;
  }

  config.activeDatabaseHost = activeHost.name;
  config.activeDatabasePort = activeHost.port;

  const fallbackDatabase = activeHost.databases[0];
  const activeDatabase = activeHost.databases.find((database) => database.name === config.activeDatabaseName) ?? fallbackDatabase;
  config.activeDatabaseName = activeDatabase?.name;
}

/**
 * Convert stored config into the normalized multi-host shape used by CLI config commands.
 */
export function normalizeStoredConfig(stored: StoredConfig): NormalizedStoredConfig {
  const normalized: NormalizedStoredConfig = {
    llm: stored.llm ? { ...stored.llm } : undefined,
    embedding: stored.embedding ? { ...stored.embedding } : undefined,
    app: stored.app ? { ...stored.app } : undefined,
    databaseHosts: (stored.databaseHosts ?? []).map(cloneDatabaseHost),
    activeDatabaseHost: stored.activeDatabaseHost,
    activeDatabasePort: stored.activeDatabasePort,
    activeDatabaseName: stored.activeDatabaseName,
  };

  normalizeActiveSelection(normalized);
  return normalized;
}

/**
 * Convert a normalized config back into the persisted shape.
 */
export function toStoredConfig(config: NormalizedStoredConfig): StoredConfig {
  return {
    llm: config.llm ? { ...config.llm } : undefined,
    embedding: config.embedding ? { ...config.embedding } : undefined,
    app: config.app ? { ...config.app } : undefined,
    databaseHosts: config.databaseHosts.map(cloneDatabaseHost),
    activeDatabaseHost: config.activeDatabaseHost,
    activeDatabasePort: config.activeDatabasePort,
    activeDatabaseName: config.activeDatabaseName,
  };
}

/**
 * Deep-clone the normalized config shape so callers can keep safe before/after snapshots.
 */
export function cloneNormalizedStoredConfig(config: NormalizedStoredConfig): NormalizedStoredConfig {
  return normalizeStoredConfig(toStoredConfig(config));
}

/**
 * Find one host configuration by its stored name.
 */
export function findDatabaseHost(config: NormalizedStoredConfig, hostName: string): StoredDatabaseHost | undefined {
  return config.databaseHosts.find((host) => host.name === hostName);
}

/**
 * Find one stored host configuration by its physical connection target.
 */
export function findDatabaseHostByConnection(
  config: NormalizedStoredConfig,
  target: Pick<DatabaseConfig, "dialect" | "host" | "port">,
): StoredDatabaseHost | undefined {
  return config.databaseHosts.find(
    (host) => host.dialect === target.dialect && host.host === target.host && host.port === target.port,
  );
}

/**
 * Return whether one stored host matches the active selection, including port when that pointer is present.
 */
export function isActiveDatabaseHostSelection(
  config: Pick<NormalizedStoredConfig, "activeDatabaseHost" | "activeDatabasePort">,
  host: Pick<StoredDatabaseHost, "name" | "port">,
): boolean {
  return matchesActiveHostSelection(config, host);
}

/**
 * Return the currently active host configuration, if any.
 */
export function getActiveDatabaseHost(config: NormalizedStoredConfig): StoredDatabaseHost | undefined {
  return config.databaseHosts.find((host) => matchesActiveHostSelection(config, host));
}

/**
 * Find one database entry under one host by database name.
 */
export function findDatabaseEntry(host: StoredDatabaseHost, databaseName: string): StoredDatabaseEntry | undefined {
  return host.databases.find((database) => database.name === databaseName);
}

/**
 * Update the active host/database selection explicitly.
 */
export function setNormalizedActiveSelection(config: NormalizedStoredConfig, hostName: string, databaseName?: string): void {
  const host = findDatabaseHost(config, hostName);
  if (!host) {
    throw new Error(`Unknown host config: ${hostName}`);
  }

  config.activeDatabaseHost = host.name;
  config.activeDatabasePort = host.port;
  config.activeDatabaseName = databaseName ?? host.databases[0]?.name;
}

export interface PersistedDatabaseSelectionOutcome {
  persisted: boolean;
  addedDatabase: boolean;
  updatedSchema: boolean;
  hostName?: string;
  databaseName?: string;
}

/**
 * Persist a runtime-selected database under the matching stored host and make it active for future sessions.
 */
export function persistNormalizedDatabaseSelectionForConnection(
  config: NormalizedStoredConfig,
  target: Pick<DatabaseConfig, "dialect" | "host" | "port" | "database" | "schema">,
): PersistedDatabaseSelectionOutcome {
  const host = findDatabaseHostByConnection(config, target);
  if (!host) {
    return {
      persisted: false,
      addedDatabase: false,
      updatedSchema: false,
    };
  }

  let database = findDatabaseEntry(host, target.database);
  let addedDatabase = false;
  let updatedSchema = false;
  const nextSchema = target.dialect === "postgres" ? target.schema ?? host.databases[0]?.schema ?? "public" : undefined;

  if (!database) {
    database = {
      name: target.database,
      schema: nextSchema,
    };
    host.databases.push(database);
    addedDatabase = true;
  } else if (target.dialect === "postgres" && nextSchema && database.schema !== nextSchema) {
    database.schema = nextSchema;
    updatedSchema = true;
  }

  setNormalizedActiveSelection(config, host.name, database.name);
  return {
    persisted: true,
    addedDatabase,
    updatedSchema,
    hostName: host.name,
    databaseName: database.name,
  };
}

/**
 * Resolve the active normalized host/database pair into the runtime DatabaseConfig shape.
 */
export function resolveNormalizedDatabaseConfig(config: NormalizedStoredConfig): DatabaseConfig | undefined {
  const activeHost = getActiveDatabaseHost(config);
  const activeDatabase = activeHost ? findDatabaseEntry(activeHost, config.activeDatabaseName ?? "") : undefined;

  if (!activeHost || !activeDatabase) {
    return undefined;
  }

  return {
    dialect: activeHost.dialect,
    host: activeHost.host,
    port: activeHost.port,
    database: activeDatabase.name,
    username: activeHost.username,
    password: activeHost.password,
    schema: activeDatabase.schema,
    ssl: activeHost.ssl,
    operationAccess: DEFAULT_DATABASE_OPERATION_ACCESS,
  };
}

/**
 * Resolve the active stored host/database pair into the runtime DatabaseConfig shape.
 */
export function resolveStoredDatabaseConfig(stored: StoredConfig): Partial<DatabaseConfig> {
  return resolveNormalizedDatabaseConfig(normalizeStoredConfig(stored)) ?? {};
}
