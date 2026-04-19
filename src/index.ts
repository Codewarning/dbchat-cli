#!/usr/bin/env node

// Entrypoint that wires Commander to the repository's command registration layer.
import { Command } from "commander";
import { registerCommands } from "./commands/register.js";
import { resolveAppConfig } from "./config/store.js";
import { cleanupExpiredWorkspaceTempArtifacts } from "./fs/temp-artifacts.js";

/**
 * Build the CLI program and delegate argument parsing to Commander.
 */
async function main(): Promise<void> {
  const retentionDays = await resolveAppConfig()
    .then((config) => config.app.tempArtifactRetentionDays)
    .catch(() => undefined);
  await cleanupExpiredWorkspaceTempArtifacts({ retentionDays }).catch(() => undefined);
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
