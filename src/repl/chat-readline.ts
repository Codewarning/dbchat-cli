import { createInterface } from "node:readline/promises";
import process from "node:process";
import { AgentSession } from "../agent/session.js";
import type { AgentIO } from "../types/index.js";
import { createReadlinePromptRuntime } from "../ui/prompts.js";
import { buildResultArtifactDisplayText } from "../ui/result-artifacts.js";
import { formatDatabaseTarget, type ChatRuntimeState } from "./runtime.js";
import {
  handleClearCommand,
  handleDatabaseCommand,
  handleHostCommand,
  handlePlanCommand,
  handleSchemaCommand,
  parseSlashCommand,
  printHelp,
  type SlashCommandPresenter,
} from "./slash-commands.js";

export function shouldTreatReadlineQuestionErrorAsExit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /readline was closed|operation was aborted|aborted/i.test(message);
}

function printReadlineBanner(target: string): void {
  console.log("dbchat is ready. Enter a natural-language request, or type /help.");
  console.log(`Active database: ${target}`);
  console.log("The session stays open until you enter /exit or press Ctrl+C.");
}

/**
 * Start the fallback readline-based interactive chat session.
 */
export async function startReadlineChatRepl(state: ChatRuntimeState, io: AgentIO): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompts = createReadlinePromptRuntime(rl);
  const chatIo: AgentIO = {
    ...io,
    async confirm(message: string) {
      return prompts.confirm(message, false);
    },
    async approveSql(message: string) {
      return prompts.approveSql(message);
    },
  };
  if (!state.config || !state.db) {
    throw new Error("No active database is configured. Add or switch to a database first.");
  }

  state.session = new AgentSession(state.config, state.db, chatIo);
  const presenter: SlashCommandPresenter = {
    line(message) {
      console.log(message);
    },
    block(title, body) {
      io.logBlock(title, body);
    },
  };
  const resetReadlineViewForDatabaseChange = async () => {
    console.clear();
    printReadlineBanner(formatDatabaseTarget(state.config?.database));
  };

  printReadlineBanner(formatDatabaseTarget(state.config.database));

  try {
    while (true) {
      let line = "";
      try {
        line = (await rl.question("dbchat> ")).trim();
      } catch (error) {
        if (shouldTreatReadlineQuestionErrorAsExit(error)) {
          return;
        }

        throw error;
      }

      if (!line) {
        continue;
      }

      try {
        if (line.startsWith("/")) {
          const parsed = parseSlashCommand(line);

          switch (parsed.command) {
            case "exit":
              return;
            case "help":
              printHelp(presenter);
              continue;
            case "clear":
              handleClearCommand(state);
              console.clear();
              continue;
            case "plan":
              handlePlanCommand(state, presenter);
              continue;
            case "schema":
              await handleSchemaCommand(parsed, state, presenter);
              continue;
            case "host":
              await handleHostCommand(parsed, state, prompts, chatIo, io, presenter, {
                beforePresentingRuntimeChange: resetReadlineViewForDatabaseChange,
              });
              continue;
            case "database":
              await handleDatabaseCommand(parsed, state, prompts, chatIo, io, presenter, {
                beforePresentingRuntimeChange: resetReadlineViewForDatabaseChange,
              });
              continue;
            default:
              throw new Error("Unknown slash command. Type /help.");
          }
        }

        if (!state.session) {
          console.log("No active database is configured. Add or switch to a database first.");
          continue;
        }

        const result = await state.session.run(line);
        io.logBlock("Final answer", result.content);
        for (const block of result.displayBlocks) {
          io.logBlock(block.title, block.body);
        }
        const artifactDisplay = buildResultArtifactDisplayText(result.lastResult?.htmlArtifact);
        if (artifactDisplay) {
          io.logBlock("Artifacts", artifactDisplay);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.log(`Error: ${message}`);
      }
    }
  } finally {
    try {
      rl.close();
    } catch {
      // Ignore duplicate close races during non-interactive shutdown.
    }
  }
}
