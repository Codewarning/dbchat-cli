import { Command } from "commander";
import {
  handleAskCommand,
  handleCatalogSearchCommand,
  handleCatalogSyncCommand,
  handleChatCommand,
  handleConfigDbAddDatabaseCommand,
  handleConfigDbAddHostCommand,
  handleConfigDbListCommand,
  handleConfigDbRemoveDatabaseCommand,
  handleConfigDbRemoveHostCommand,
  handleConfigDbUpdateDatabaseCommand,
  handleConfigDbUpdateHostCommand,
  handleConfigDbUseDatabaseCommand,
  handleConfigDbUseHostCommand,
  handleConfigEmbeddingUpdateCommand,
  handleConfigShowCommand,
  handleExplainCommand,
  handleSchemaCommand,
  handleSqlCommand,
} from "./handlers.js";
import { handleInitCommand } from "./init.js";

/**
 * Register all CLI commands exposed by the project.
 */
export function registerCommands(program: Command): void {
  program
    .name("dbchat")
    .description("A database-focused natural-language CLI assistant")
    .version("0.1.0");

  program.command("init").description("Initialize local configuration").action(() => handleInitCommand());

  program.command("chat").description("Start an interactive chat session").action(handleChatCommand);

  program
    .command("ask")
    .description("Run a one-shot natural-language database task")
    .argument("<prompt...>", "Natural-language prompt")
    .action((parts: string[]) => handleAskCommand(parts.join(" ")));

  program
    .command("sql")
    .description("Execute a single SQL statement directly")
    .argument("<sql...>", "SQL statement")
    .action((parts: string[]) => handleSqlCommand(parts.join(" ")));

  program
    .command("explain")
    .description("Show the execution plan for a SQL statement")
    .argument("<sql...>", "SQL statement")
    .action((parts: string[]) => handleExplainCommand(parts.join(" ")));

  program
    .command("schema")
    .description("Show the schema summary or a single table definition")
    .option("-t, --table <tableName>", "Table name")
    .option("-c, --count", "Include live row counts in the schema summary")
    .action((options: { table?: string; count?: boolean }) => handleSchemaCommand(options.table, options.count ?? false));

  const catalogCommand = program.command("catalog").description("Manage the local schema catalog used for schema retrieval");
  catalogCommand.command("sync").description("Refresh the local schema catalog from the active database").action(handleCatalogSyncCommand);
  catalogCommand
    .command("search")
    .description("Search the local schema catalog")
    .argument("<query...>", "Search text")
    .option("-n, --limit <count>", "Maximum number of matches", "5")
    .action((parts: string[], options: { limit: string }) => handleCatalogSearchCommand(parts.join(" "), Number(options.limit)));

  const configCommand = program.command("config").description("Inspect local configuration");
  configCommand.command("show").description("Show the current configuration with secrets masked").action(handleConfigShowCommand);
  const embeddingConfigCommand = configCommand.command("embedding").description("Manage the stored embedding API configuration");
  embeddingConfigCommand.command("update").description("Update the stored embedding API configuration").action(handleConfigEmbeddingUpdateCommand);

  const databaseConfigCommand = configCommand.command("db").description("Manage stored database host and database configs");
  databaseConfigCommand.command("list").description("List all stored host and database configs").action(handleConfigDbListCommand);

  databaseConfigCommand.command("add-host").description("Add a host config and its first database").argument("<name>", "Host config name").action(handleConfigDbAddHostCommand);
  databaseConfigCommand.command("update-host").description("Update one host config").argument("[name]", "Host config name").action(handleConfigDbUpdateHostCommand);
  databaseConfigCommand.command("remove-host").description("Remove one host config").argument("[name]", "Host config name").action(handleConfigDbRemoveHostCommand);
  databaseConfigCommand.command("use-host").description("Switch the active host config").argument("[name]", "Host config name").action(handleConfigDbUseHostCommand);

  databaseConfigCommand
    .command("add-database")
    .description("Add a database under one host config")
    .argument("<name>", "Database name")
    .option("-H, --host <hostName>", "Host config name")
    .action((name: string, options: { host?: string }) => handleConfigDbAddDatabaseCommand(name, options.host));

  databaseConfigCommand
    .command("update-database")
    .description("Update one database under one host config")
    .argument("[name]", "Database name")
    .option("-H, --host <hostName>", "Host config name")
    .action((name: string | undefined, options: { host?: string }) => handleConfigDbUpdateDatabaseCommand(name, options.host));

  databaseConfigCommand
    .command("remove-database")
    .description("Remove one database from one host config")
    .argument("[name]", "Database name")
    .option("-H, --host <hostName>", "Host config name")
    .action((name: string | undefined, options: { host?: string }) => handleConfigDbRemoveDatabaseCommand(name, options.host));

  databaseConfigCommand
    .command("use-database")
    .description("Switch the active database under one host config")
    .argument("[name]", "Database name")
    .option("-H, --host <hostName>", "Host config name")
    .action((name: string | undefined, options: { host?: string }) => handleConfigDbUseDatabaseCommand(name, options.host));
}
