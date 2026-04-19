import { registerAgentAndReplTests } from "./tests/agent-repl.js";
import { registerCliRegressionTests } from "./tests/cli-regressions.js";
import { registerConfigAndEmbeddingTests } from "./tests/config-embedding.js";
import { registerSecurityRegressionTests } from "./tests/security-regressions.js";
import { registerSchemaAndToolTests } from "./tests/schema-tools.js";
import { registerScopedInstructionTests } from "./tests/scoped-instructions.js";
import { registerSqlExecutionTests } from "./tests/sql-execution.js";
import { runTest } from "./tests/support.js";
import { registerTerminalLinkTests } from "./tests/terminal-links.js";

async function main(): Promise<void> {
  await registerSqlExecutionTests(runTest);
  await registerCliRegressionTests(runTest);
  await registerConfigAndEmbeddingTests(runTest);
  await registerAgentAndReplTests(runTest);
  await registerSchemaAndToolTests(runTest);
  await registerScopedInstructionTests(runTest);
  await registerTerminalLinkTests(runTest);
  await registerSecurityRegressionTests(runTest);
  console.log("All tests passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
