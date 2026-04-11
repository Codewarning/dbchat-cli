// Factory functions keep driver-specific imports lazy so non-db commands stay lightweight.
import type { DatabaseConfig } from "../types/index.js";
import type { DatabaseAdapter } from "./adapter.js";

/**
 * Instantiate the correct database adapter for the configured dialect.
 */
export async function createDatabaseAdapter(config: DatabaseConfig): Promise<DatabaseAdapter> {
  switch (config.dialect) {
    case "postgres": {
      // Lazy loading avoids pulling in both client libraries on every process start.
      const { PostgresAdapter } = await import("./postgres.js");
      return new PostgresAdapter(config);
    }
    case "mysql": {
      const { MySqlAdapter } = await import("./mysql.js");
      return new MySqlAdapter(config);
    }
    default:
      throw new Error(`Unsupported database dialect: ${String(config.dialect)}`);
  }
}
