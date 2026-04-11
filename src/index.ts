#!/usr/bin/env node

// Entrypoint that wires Commander to the repository's command registration layer.
import { Command } from "commander";
import { registerCommands } from "./commands/register.js";

/**
 * Build the CLI program and delegate argument parsing to Commander.
 */
async function main(): Promise<void> {
  const program = new Command();
  registerCommands(program);
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  // Surface a clean one-line error while preserving a failing exit code.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
