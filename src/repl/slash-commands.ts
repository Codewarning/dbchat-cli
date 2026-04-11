import { formatPlanForDisplay } from "../agent/plan.js";
import {
  addDatabaseConfig,
  addHostConfig,
  loadDatabaseConfigList,
  removeDatabaseConfig,
  removeHostConfig,
  updateDatabaseConfig,
  updateHostConfig,
  useDatabaseConfig,
  useHostConfig,
  type DatabaseConfigCommandOutcome,
} from "../commands/database-config.js";
import { promptDatabaseOperationAccess } from "../commands/database-config-helpers.js";
import { formatDatabaseConfigListText, formatSchemaSummaryText, formatTableSchemaText } from "../ui/text-formatters.js";
import type { AgentIO, DatabaseConfig, DatabaseOperationAccess } from "../types/index.js";
import type { PromptRuntime } from "../ui/prompts.js";
import type { ChatRuntimeState } from "./runtime.js";
import { synchronizeRuntimeAfterConfigChange, type RuntimeSwitchOutcome } from "./runtime.js";

export interface ParsedSlashCommand {
  command: string;
  action?: string;
  args: string[];
  hostName?: string;
}

interface ParsedSchemaArgs {
  tableName?: string;
  includeRowCount: boolean;
}

export interface SlashCommandPresenter {
  line(message: string): void;
  block(title: string, body: string): void;
}

export interface SlashCommandDefinition {
  usage: string;
  insertText: string;
  description: string;
}

export interface SlashCommandCompletion {
  usage: string;
  insertText: string;
  description: string;
}

interface RuntimeChangeHooks {
  beforePresentingRuntimeChange?(result: RuntimeSwitchOutcome): void | Promise<void>;
}

const SLASH_COMMAND_DEFINITIONS: SlashCommandDefinition[] = [
  {
    usage: "/help",
    insertText: "/help",
    description: "Show help",
  },
  {
    usage: "/schema [table] [--count]",
    insertText: "/schema ",
    description: "Show the schema summary or one table definition; use --count for live row counts",
  },
  {
    usage: "/plan",
    insertText: "/plan",
    description: "Show the current plan",
  },
  {
    usage: "/clear",
    insertText: "/clear",
    description: "Clear the current session and screen",
  },
  {
    usage: "/host",
    insertText: "/host",
    description: "List stored host/database configs",
  },
  {
    usage: "/host add [name]",
    insertText: "/host add ",
    description: "Add a host config and its first database",
  },
  {
    usage: "/host update [name]",
    insertText: "/host update ",
    description: "Update a host config",
  },
  {
    usage: "/host remove [name]",
    insertText: "/host remove ",
    description: "Remove a host config",
  },
  {
    usage: "/host use [name]",
    insertText: "/host use ",
    description: "Switch the active host config",
  },
  {
    usage: "/database",
    insertText: "/database",
    description: "List stored host/database configs",
  },
  {
    usage: "/database add [name] [--host <hostName>]",
    insertText: "/database add ",
    description: "Add a database under one host config",
  },
  {
    usage: "/database update [name] [--host <hostName>]",
    insertText: "/database update ",
    description: "Update one database under one host config",
  },
  {
    usage: "/database remove [name] [--host <hostName>]",
    insertText: "/database remove ",
    description: "Remove one database from one host config",
  },
  {
    usage: "/database use [name] [--host <hostName>]",
    insertText: "/database use ",
    description: "Switch the active database",
  },
  {
    usage: "/exit",
    insertText: "/exit",
    description: "Exit the REPL",
  },
];

/**
 * Match slash-command tokens by prefix so `/da u` can suggest `/database use`.
 */
function matchesCompletionPrefix(input: string, definition: SlashCommandDefinition): boolean {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput.startsWith("/")) {
    return false;
  }

  if (normalizedInput === "/") {
    return true;
  }

  const inputTokens = normalizedInput.slice(1).split(/\s+/).filter(Boolean);
  const candidateTokens = definition.insertText.trim().slice(1).split(/\s+/).filter(Boolean);

  if (!inputTokens.length) {
    return true;
  }

  if (inputTokens.length > candidateTokens.length) {
    return false;
  }

  return inputTokens.every((token, index) => candidateTokens[index]?.startsWith(token));
}

/**
 * Return ordered slash-command completion candidates for one partial input.
 */
export function getSlashCommandCompletions(input: string): SlashCommandCompletion[] {
  return SLASH_COMMAND_DEFINITIONS.filter((definition) => matchesCompletionPrefix(input, definition)).map((definition) => ({
    usage: definition.usage,
    insertText: definition.insertText,
    description: definition.description,
  }));
}

/**
 * Print the local slash-command help for the interactive REPL.
 */
export function printHelp(presenter: SlashCommandPresenter): void {
  presenter.block(
    "Available commands",
    [
      ...SLASH_COMMAND_DEFINITIONS.map((definition) => `${definition.usage.padEnd(32, " ")} ${definition.description}`),
      "",
      "@<database>".padEnd(32, " ") + "Open the live database picker for the current host and switch targets",
    ].join("\n"),
  );
}

/**
 * Tokenize one slash-command string while honoring basic single/double-quoted arguments.
 */
function tokenizeSlashCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new Error("Slash command contains an unterminated quote.");
  }

  if (escaped) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parse one slash-command line into a command name plus positional/flag arguments.
 */
export function parseSlashCommand(line: string): ParsedSlashCommand {
  const tokens = tokenizeSlashCommand(line.startsWith("/") ? line.slice(1) : line);
  if (!tokens.length) {
    throw new Error("Empty slash command.");
  }

  const [command, action, ...rest] = tokens;
  const args: string[] = [];
  let hostName: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--host" || token === "-H") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("Missing value for --host.");
      }

      hostName = value;
      index += 1;
      continue;
    }

    args.push(token);
  }

  return {
    command,
    action,
    args,
    hostName,
  };
}

/**
 * Normalize slash-command action aliases so `/delete` and `/switch` behave like the config subcommands.
 */
function normalizeAction(action?: string): string {
  switch (action) {
    case undefined:
      return "list";
    case "delete":
      return "remove";
    case "switch":
      return "use";
    default:
      return action;
  }
}

/**
 * Enforce a bounded number of positional arguments for one local slash command.
 */
function expectMaxArgs(args: string[], maxArgs: number, usage: string): void {
  if (args.length > maxArgs) {
    throw new Error(`Too many arguments. Usage: ${usage}`);
  }
}

/**
 * Parse `/schema` arguments so optional flags do not get treated as table names.
 */
export function parseSchemaCommandArgs(args: string[]): ParsedSchemaArgs {
  let includeRowCount = false;
  const positionalArgs: string[] = [];

  for (const arg of args) {
    if (arg === "--count" || arg === "-c") {
      includeRowCount = true;
      continue;
    }
    positionalArgs.push(arg);
  }

  expectMaxArgs(positionalArgs, 1, "/schema [table] [--count]");
  return {
    tableName: positionalArgs[0],
    includeRowCount,
  };
}

function sameDatabaseTarget(left: DatabaseConfig | null | undefined, right: DatabaseConfig | null | undefined): boolean {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.dialect === right.dialect &&
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database &&
    left.schema === right.schema
  );
}

async function promptRuntimeOperationAccessForSwitch(
  prompts: PromptRuntime,
  state: ChatRuntimeState,
  nextTarget: DatabaseConfig | null,
): Promise<DatabaseOperationAccess | undefined> {
  if (!nextTarget) {
    return undefined;
  }

  const currentAccess = sameDatabaseTarget(state.config?.database, nextTarget) ? state.config?.database.operationAccess : undefined;
  return promptDatabaseOperationAccess(prompts, currentAccess, nextTarget.database);
}

/**
 * Execute one `/host ...` command locally inside the chat session.
 */
export async function handleHostCommand(
  parsed: ParsedSlashCommand,
  state: ChatRuntimeState,
  prompts: PromptRuntime,
  chatIo: AgentIO,
  io: AgentIO,
  presenter: SlashCommandPresenter,
  hooks?: RuntimeChangeHooks,
): Promise<void> {
  const action = normalizeAction(parsed.action);
  expectMaxArgs(parsed.args, 1, "/host [list|add|update|remove|use] [name]");

  if (action === "list") {
    presenter.block("Stored database configs", formatDatabaseConfigListText(await loadDatabaseConfigList()));
    return;
  }

  let outcome: DatabaseConfigCommandOutcome;
  switch (action) {
    case "add":
      outcome = await addHostConfig(prompts, parsed.args[0]);
      break;
    case "update":
      outcome = await updateHostConfig(prompts, parsed.args[0]);
      break;
    case "remove":
      outcome = await removeHostConfig(prompts, parsed.args[0]);
      break;
    case "use":
      outcome = await useHostConfig(prompts, parsed.args[0]);
      break;
    default:
      throw new Error("Unknown /host action. Use /host list|add|update|remove|use.");
  }

  const operationAccess = action === "use" ? await promptRuntimeOperationAccessForSwitch(prompts, state, outcome.nextActiveTarget) : undefined;
  const syncResult = await synchronizeRuntimeAfterConfigChange(outcome, state, chatIo, io, operationAccess);
  if (syncResult.clearedConversation) {
    await hooks?.beforePresentingRuntimeChange?.(syncResult);
  }
  presenter.line(outcome.message);
  syncResult.notices.forEach((notice) => presenter.line(notice));
}

/**
 * Execute one `/database ...` command locally inside the chat session.
 */
export async function handleDatabaseCommand(
  parsed: ParsedSlashCommand,
  state: ChatRuntimeState,
  prompts: PromptRuntime,
  chatIo: AgentIO,
  io: AgentIO,
  presenter: SlashCommandPresenter,
  hooks?: RuntimeChangeHooks,
): Promise<void> {
  const action = normalizeAction(parsed.action);
  expectMaxArgs(parsed.args, 1, "/database [list|add|update|remove|use] [name] [--host <hostName>]");

  if (action === "list") {
    presenter.block("Stored database configs", formatDatabaseConfigListText(await loadDatabaseConfigList()));
    return;
  }

  let outcome: DatabaseConfigCommandOutcome;
  switch (action) {
    case "add":
      outcome = await addDatabaseConfig(prompts, parsed.args[0], parsed.hostName);
      break;
    case "update":
      outcome = await updateDatabaseConfig(prompts, parsed.args[0], parsed.hostName);
      break;
    case "remove":
      outcome = await removeDatabaseConfig(prompts, parsed.args[0], parsed.hostName);
      break;
    case "use":
      outcome = await useDatabaseConfig(prompts, parsed.args[0], parsed.hostName);
      break;
    default:
      throw new Error("Unknown /database action. Use /database list|add|update|remove|use.");
  }

  const operationAccess = action === "use" ? await promptRuntimeOperationAccessForSwitch(prompts, state, outcome.nextActiveTarget) : undefined;
  const syncResult = await synchronizeRuntimeAfterConfigChange(outcome, state, chatIo, io, operationAccess);
  if (syncResult.clearedConversation) {
    await hooks?.beforePresentingRuntimeChange?.(syncResult);
  }
  presenter.line(outcome.message);
  syncResult.notices.forEach((notice) => presenter.line(notice));
}

/**
 * Execute one `/schema ...` command locally inside the chat session.
 */
export async function handleSchemaCommand(parsed: ParsedSlashCommand, state: ChatRuntimeState, presenter: SlashCommandPresenter): Promise<void> {
  if (!state.db) {
    presenter.line("No active database is configured. Add or switch to a database first.");
    return;
  }

  const schemaArgs = parsed.action ? [parsed.action, ...parsed.args] : parsed.args;
  const { tableName, includeRowCount } = parseSchemaCommandArgs(schemaArgs);
  if (tableName) {
    const schema = await state.db.describeTable(tableName);
    presenter.block("Table schema", formatTableSchemaText(schema));
    return;
  }

  presenter.block("Schema summary", formatSchemaSummaryText(await state.db.getSchemaSummary({ includeRowCount })));
}

/**
 * Print the current in-memory execution plan.
 */
export function handlePlanCommand(state: ChatRuntimeState, presenter: SlashCommandPresenter): void {
  if (!state.session) {
    presenter.line("There is no active conversation plan.");
    return;
  }

  presenter.block("Current plan", formatPlanForDisplay(state.session.getPlan()));
}

/**
 * Clear the current conversation state and return whether a session existed.
 */
export function handleClearCommand(state: ChatRuntimeState, presenter?: SlashCommandPresenter): boolean {
  if (!state.session) {
    presenter?.line("There is no active conversation to clear.");
    return false;
  }

  state.session.clearConversation();
  presenter?.line("Session cleared.");
  return true;
}
