import os from "node:os";
import path from "node:path";

/**
 * Return the directory used for on-disk CLI configuration.
 */
export function getConfigDirectory(): string {
  return path.join(os.homedir(), ".db-chat-cli");
}

/**
 * Return the full path to the persisted CLI config file.
 */
export function getConfigPath(): string {
  return path.join(getConfigDirectory(), "config.json");
}
