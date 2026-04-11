import { DEFAULT_MYSQL_PORT, DEFAULT_POSTGRES_PORT } from "../config/defaults.js";
import type { NormalizedStoredConfig } from "../config/database-hosts.js";
import { findDatabaseEntry, findDatabaseHost, getActiveDatabaseHost, setNormalizedActiveSelection } from "../config/database-hosts.js";
import { createDatabaseAdapter } from "../db/factory.js";
import {
  DEFAULT_DATABASE_OPERATION_ACCESS,
  getDatabaseOperationAccessDefinitions,
} from "../db/operation-access.js";
import type { DatabaseConfig, DatabaseDialect, DatabaseOperationAccess, StoredDatabaseEntry, StoredDatabaseHost } from "../types/index.js";
import type { PromptRuntime, SelectChoice } from "../ui/prompts.js";
import { buildDatabaseConfigRows } from "../ui/rows.js";

/**
 * Return the default TCP port for one supported database dialect.
 */
function getDefaultPortForDialect(dialect: DatabaseDialect): number {
  return dialect === "postgres" ? DEFAULT_POSTGRES_PORT : DEFAULT_MYSQL_PORT;
}

/**
 * Build one runtime connection config from a stored host plus one seed database entry.
 */
function buildDatabaseConfigFromHost(host: StoredDatabaseHost, database: StoredDatabaseEntry): DatabaseConfig {
  return {
    dialect: host.dialect,
    host: host.host,
    port: host.port,
    database: database.name,
    username: host.username,
    password: host.password,
    schema: database.schema,
    ssl: host.ssl,
    operationAccess: DEFAULT_DATABASE_OPERATION_ACCESS,
  };
}

/**
 * Reject empty strings for required config fields.
 */
function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} cannot be empty.`);
  }

  return normalized;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

/**
 * Keep the currently active database at the top of a live-switch list while preserving the rest of the order.
 */
export function orderDatabaseNamesForSelection(databaseNames: string[], preferredDatabaseName?: string): string[] {
  if (!preferredDatabaseName) {
    return [...databaseNames];
  }

  const exactMatch = databaseNames.find((databaseName) => databaseName === preferredDatabaseName);
  const caseInsensitiveMatch = exactMatch
    ? exactMatch
    : databaseNames.find((databaseName) => databaseName.toLowerCase() === preferredDatabaseName.toLowerCase());
  if (!caseInsensitiveMatch) {
    return [...databaseNames];
  }

  return [caseInsensitiveMatch, ...databaseNames.filter((databaseName) => databaseName !== caseInsensitiveMatch)];
}

/**
 * Ensure that one host config name is unique across the stored host list.
 */
export function ensureUniqueHostName(config: NormalizedStoredConfig, hostName: string, ignoreName?: string): void {
  if (config.databaseHosts.some((host) => host.name === hostName && host.name !== ignoreName)) {
    throw new Error(`A host config named '${hostName}' already exists.`);
  }
}

/**
 * Ensure that one physical host is configured only once so additional databases stay grouped under it.
 */
export function ensureUniqueHostAddress(
  config: NormalizedStoredConfig,
  hostValue: Pick<StoredDatabaseHost, "dialect" | "host" | "port">,
  ignoreName?: string,
): void {
  if (
    config.databaseHosts.some(
      (host) =>
        host.host === hostValue.host &&
        host.port === hostValue.port &&
        host.dialect === hostValue.dialect &&
        host.name !== ignoreName,
    )
  ) {
    throw new Error(
      `A host config for '${hostValue.dialect} ${hostValue.host}:${hostValue.port}' already exists. Add another database under that host instead.`,
    );
  }
}

/**
 * Ensure that database names stay unique within one host config.
 */
export function ensureUniqueDatabaseName(host: StoredDatabaseHost, databaseName: string, ignoreName?: string): void {
  if (host.databases.some((database) => database.name === databaseName && database.name !== ignoreName)) {
    throw new Error(`A database named '${databaseName}' already exists under host '${host.name}'.`);
  }
}

/**
 * Resolve one host config by name or fail with a user-facing error.
 */
export function requireDatabaseHost(config: NormalizedStoredConfig, hostName: string): StoredDatabaseHost {
  const host = findDatabaseHost(config, hostName);
  if (!host) {
    throw new Error(`Unknown host config: ${hostName}`);
  }

  return host;
}

/**
 * Resolve the host targeted by a config command, defaulting to the active host when omitted.
 */
export function resolveCommandHost(config: NormalizedStoredConfig, hostName?: string): StoredDatabaseHost {
  if (hostName) {
    return requireDatabaseHost(config, hostName);
  }

  const activeHost = getActiveDatabaseHost(config);
  if (!activeHost) {
    throw new Error("There is no active host config. Add one first or pass --host.");
  }

  return activeHost;
}

/**
 * Resolve one database entry under a host config or fail with a user-facing error.
 */
export function requireDatabaseEntry(host: StoredDatabaseHost, databaseName: string): StoredDatabaseEntry {
  const database = findDatabaseEntry(host, databaseName);
  if (!database) {
    throw new Error(`Unknown database '${databaseName}' under host '${host.name}'.`);
  }

  return database;
}

/**
 * Update the active host/database selection after a successful switch or mutation.
 */
export function setActiveSelection(config: NormalizedStoredConfig, hostName: string, databaseName?: string): void {
  setNormalizedActiveSelection(config, hostName, databaseName);
}

/**
 * Choose a valid fallback active selection after host removal.
 */
export function syncSelectionAfterHostRemoval(config: NormalizedStoredConfig): void {
  const fallbackHost = config.databaseHosts[0];
  if (!fallbackHost) {
    config.activeDatabaseHost = undefined;
    config.activeDatabaseName = undefined;
    return;
  }

  config.activeDatabaseHost = fallbackHost.name;
  config.activeDatabaseName = fallbackHost.databases[0]?.name;
}

/**
 * Render the configured host/database combinations in a table-friendly format.
 */
export function printDatabaseConfigList(config: NormalizedStoredConfig): void {
  if (!config.databaseHosts.length) {
    console.log("No database host configs are stored.");
    return;
  }

  const rows = buildDatabaseConfigRows(config);

  console.table(rows);
  console.log(`Active host: ${config.activeDatabaseHost ?? "(none)"}`);
  console.log(`Active database: ${config.activeDatabaseName ?? "(none)"}`);
}

/**
 * Build labeled choices for one current/default pair while avoiding duplicate values.
 */
export function buildCommonValueChoices(defaultValue: string, currentValue?: string): Array<SelectChoice<string>> {
  const choices: Array<SelectChoice<string>> = [
    { label: `Default (${defaultValue})`, value: defaultValue },
  ];

  if (currentValue && currentValue !== defaultValue) {
    choices.unshift({
      label: `Current (${currentValue})`,
      value: currentValue,
    });
  }

  return choices;
}

/**
 * Prompt the user to select one stored host config from the current config.
 */
async function promptForExistingHost(
  prompts: PromptRuntime,
  config: NormalizedStoredConfig,
  message: string,
): Promise<StoredDatabaseHost> {
  if (!config.databaseHosts.length) {
    throw new Error("No host configs are stored.");
  }

  const selectedHostName = await prompts.select(
    message,
    config.databaseHosts.map((host) => ({
      label: `${host.name} (${host.dialect} ${host.host}:${host.port})`,
      value: host.name,
    })),
    config.activeDatabaseHost,
  );

  return requireDatabaseHost(config, selectedHostName);
}

/**
 * Resolve the host targeted by an interactive config command, prompting when no explicit host name is provided.
 */
export async function resolveInteractiveCommandHost(
  prompts: PromptRuntime,
  config: NormalizedStoredConfig,
  hostName: string | undefined,
  message: string,
): Promise<StoredDatabaseHost> {
  if (hostName) {
    return requireDatabaseHost(config, hostName);
  }

  return promptForExistingHost(prompts, config, message);
}

/**
 * Prompt the user to select one database entry under a specific host config.
 */
export async function promptForExistingDatabase(
  prompts: PromptRuntime,
  host: StoredDatabaseHost,
  message: string,
  defaultDatabaseName?: string,
): Promise<StoredDatabaseEntry> {
  if (!host.databases.length) {
    throw new Error(`Host '${host.name}' does not contain any stored databases.`);
  }

  const selectedDatabaseName = await prompts.select(
    message,
    host.databases.map((database) => ({
      label: database.schema
        ? `${database.name} (schema: ${database.schema})`
        : database.name,
      value: database.name,
    })),
    defaultDatabaseName,
  );

  return requireDatabaseEntry(host, selectedDatabaseName);
}

/**
 * Query the selected host directly for the databases visible to the configured user.
 */
export async function listLiveDatabaseNamesForHost(
  host: StoredDatabaseHost,
  preferredDatabaseName?: string,
): Promise<string[]> {
  const seedDatabase =
    (preferredDatabaseName ? findDatabaseEntry(host, preferredDatabaseName) : undefined) ??
    host.databases[0];

  if (!seedDatabase) {
    throw new Error(`Host '${host.name}' does not contain a stored seed database for discovery.`);
  }

  const db = await createDatabaseAdapter(buildDatabaseConfigFromHost(host, seedDatabase));
  try {
    await db.testConnection();
    return await db.listDatabases();
  } finally {
    await db.close();
  }
}

/**
 * Prompt the user to choose one live database name fetched from the target host.
 */
export async function promptForLiveDatabaseName(
  prompts: PromptRuntime,
  host: StoredDatabaseHost,
  databaseNames: string[],
  message: string,
  defaultDatabaseName?: string,
): Promise<string> {
  if (!databaseNames.length) {
    throw new Error(`Host '${host.name}' did not return any visible databases.`);
  }

  const orderedDatabaseNames = orderDatabaseNamesForSelection(databaseNames, defaultDatabaseName);
  const defaultSelection = defaultDatabaseName && orderedDatabaseNames.includes(defaultDatabaseName) ? defaultDatabaseName : undefined;

  return prompts.select(
    message,
    orderedDatabaseNames.map((databaseName) => ({
      label: databaseName,
      value: databaseName,
    })),
    defaultSelection,
  );
}

/**
 * Prompt for one host config, using an optional existing config as the default source.
 */
export async function promptDatabaseHostConfig(
  prompts: PromptRuntime,
  existing?: Partial<StoredDatabaseHost>,
): Promise<Omit<StoredDatabaseHost, "databases">> {
  const dialect = await prompts.select<DatabaseDialect>(
    "Select a database dialect",
    [
      { label: "PostgreSQL", value: "postgres" },
      { label: "MySQL", value: "mysql" },
    ],
    existing?.dialect ?? "postgres",
  );
  const defaultPort = String(getDefaultPortForDialect(dialect));
  const currentPort = existing?.port ? String(existing.port) : undefined;

  return {
    name: requireNonEmpty(await prompts.input("Host config name", existing?.name ?? ""), "Host config name"),
    dialect,
    host: requireNonEmpty(await prompts.input("Database host", existing?.host ?? "127.0.0.1"), "Database host"),
    port: parsePositiveInteger(
      await prompts.selectOrInput(
        "Database port",
        buildCommonValueChoices(defaultPort, currentPort),
        currentPort ?? defaultPort,
        "Enter a custom database port",
        "Custom port",
      ),
      "Database port",
    ),
    username: requireNonEmpty(await prompts.input("Database username", existing?.username ?? ""), "Database username"),
    password: requireNonEmpty((await prompts.password("Database password")) || existing?.password || "", "Database password"),
    ssl: await prompts.confirm("Enable SSL?", existing?.ssl ?? false),
  };
}

/**
 * Prompt for the database operation-access level used to gate SQL execution.
 */
export async function promptDatabaseOperationAccess(
  prompts: PromptRuntime,
  existing?: DatabaseOperationAccess,
  databaseName?: string,
): Promise<DatabaseOperationAccess> {
  return prompts.select<DatabaseOperationAccess>(
    databaseName ? `Select database operation access for '${databaseName}'` : "Select database operation access",
    getDatabaseOperationAccessDefinitions().map((definition) => ({
      label: definition.selectLabel,
      value: definition.value,
    })),
    existing ?? DEFAULT_DATABASE_OPERATION_ACCESS,
  );
}

/**
 * Prompt for one database entry under a host config.
 */
export async function promptDatabaseEntryConfig(
  prompts: PromptRuntime,
  dialect: DatabaseDialect,
  existing?: Partial<StoredDatabaseEntry>,
): Promise<StoredDatabaseEntry> {
  const name = requireNonEmpty(await prompts.input("Database name", existing?.name ?? ""), "Database name");
  const schema =
    dialect === "postgres"
      ? requireNonEmpty(
          await prompts.selectOrInput(
            "Database schema",
            buildCommonValueChoices("public", existing?.schema),
            existing?.schema ?? "public",
            "Enter a custom database schema",
            "Custom schema",
          ),
          "Database schema",
        )
      : undefined;
  return {
    name,
    schema,
  };
}
