import type { DatabaseOperationAccess, SqlOperation } from "../types/index.js";

export interface DatabaseOperationAccessDefinition {
  value: DatabaseOperationAccess;
  selectLabel: string;
  displayLabel: string;
  allowedOperations: readonly SqlOperation[];
}

export const DEFAULT_DATABASE_OPERATION_ACCESS: DatabaseOperationAccess = "read_only";

const DATABASE_OPERATION_ACCESS_DEFINITIONS: DatabaseOperationAccessDefinition[] = [
  {
    value: "read_only",
    selectLabel: "1. Read only (Recommended)",
    displayLabel: "read-only",
    allowedOperations: ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"],
  },
  {
    value: "select_update",
    selectLabel: "2. SELECT + INSERT + UPDATE",
    displayLabel: "select+insert+update",
    allowedOperations: ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "INSERT", "UPDATE"],
  },
  {
    value: "select_update_delete",
    selectLabel: "3. SELECT + INSERT + UPDATE + DELETE",
    displayLabel: "select+insert+update+delete",
    allowedOperations: ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "INSERT", "UPDATE", "DELETE"],
  },
  {
    value: "select_update_delete_ddl",
    selectLabel: "4. SELECT + INSERT + UPDATE + DELETE + DDL",
    displayLabel: "select+insert+update+delete+ddl",
    allowedOperations: ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"],
  },
];

const DATABASE_OPERATION_ACCESS_BY_VALUE = new Map(
  DATABASE_OPERATION_ACCESS_DEFINITIONS.map((definition) => [definition.value, definition]),
);

/**
 * Return the static definition for one operation-access level.
 */
export function getDatabaseOperationAccessDefinition(access: DatabaseOperationAccess): DatabaseOperationAccessDefinition {
  return DATABASE_OPERATION_ACCESS_BY_VALUE.get(access)!;
}

/**
 * Return all selectable operation-access definitions in UI order.
 */
export function getDatabaseOperationAccessDefinitions(): readonly DatabaseOperationAccessDefinition[] {
  return DATABASE_OPERATION_ACCESS_DEFINITIONS;
}

/**
 * Format one access level for config tables and runtime labels.
 */
export function formatDatabaseOperationAccess(access: DatabaseOperationAccess): string {
  return getDatabaseOperationAccessDefinition(access).displayLabel;
}

/**
 * Render the allowed SQL operations for one access level in a user-facing format.
 */
export function formatAllowedOperationsForDatabaseOperationAccess(access: DatabaseOperationAccess): string {
  return getDatabaseOperationAccessDefinition(access).allowedOperations.join(", ");
}

/**
 * Render the union of operations enabled by any built-in access preset.
 */
export function formatSupportedOperationsAcrossDatabaseOperationAccessPresets(): string {
  return [...new Set(DATABASE_OPERATION_ACCESS_DEFINITIONS.flatMap((definition) => definition.allowedOperations))].join(", ");
}

/**
 * Return whether one SQL operation is permitted under the active database access level.
 */
export function isSqlOperationAllowedForDatabaseOperationAccess(
  access: DatabaseOperationAccess,
  operation: SqlOperation,
): boolean {
  return getDatabaseOperationAccessDefinition(access).allowedOperations.includes(operation);
}

/**
 * Return whether at least one built-in access preset allows the SQL operation.
 */
export function isSqlOperationSupportedByAnyDatabaseOperationAccessPreset(operation: SqlOperation): boolean {
  return DATABASE_OPERATION_ACCESS_DEFINITIONS.some((definition) => definition.allowedOperations.includes(operation));
}
