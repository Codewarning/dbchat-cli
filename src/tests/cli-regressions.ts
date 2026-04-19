import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeMySqlExplainPlan } from "../db/mysql.js";
import { shouldTreatReadlineQuestionErrorAsExit } from "../repl/chat-readline.js";
import { TerminalLogger } from "../ui/logger.js";
import type { RunTest } from "./support.js";

async function withCapturedConsoleLogs(test: (lines: string[]) => Promise<void> | void): Promise<void> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map((value) => String(value)).join(" "));
  };

  try {
    await test(lines);
  } finally {
    console.log = originalLog;
  }
}

async function runCliWithInput(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input: string;
    timeoutMs?: number;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist", "index.js"), ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI test timed out after ${options.timeoutMs ?? 20_000}ms.`));
    }, options.timeoutMs ?? 20_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

export async function registerCliRegressionTests(runTest: RunTest): Promise<void> {
  await runTest("compact logger prints result preview and artifact blocks", async () => {
    await withCapturedConsoleLogs((lines) => {
      const logger = new TerminalLogger("compact");
      logger.logBlock("Result Preview", "SQL result rows 1-1 of 1:\nid | name\n1  | demo");
      logger.logBlock("Artifacts", "HTML view: file:///tmp/demo.html");

      assert.ok(lines.some((line) => /Result Preview/.test(line)));
      assert.ok(lines.some((line) => /SQL result rows 1-1 of 1:/.test(line)));
      assert.ok(lines.some((line) => /Artifacts/.test(line)));
      assert.ok(lines.some((line) => /HTML view:/.test(line)));
    });
  });

  await runTest("compact logger prints blocked SQL messages", async () => {
    await withCapturedConsoleLogs((lines) => {
      const logger = new TerminalLogger("compact");
      logger.log("SQL blocked by database access 'read-only': CREATE is not allowed.");

      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /SQL blocked by database access/i);
    });
  });

  await runTest("mysql explain JSON normalization parses structured plans", () => {
    assert.deepEqual(normalizeMySqlExplainPlan('{"query_block":{"select_id":1,"message":"No tables used"}}'), {
      query_block: {
        select_id: 1,
        message: "No tables used",
      },
    });
    assert.equal(normalizeMySqlExplainPlan("not json"), "not json");
  });

  await runTest("readline shutdown errors are treated as clean exits", () => {
    assert.equal(shouldTreatReadlineQuestionErrorAsExit(new Error("readline was closed")), true);
    assert.equal(shouldTreatReadlineQuestionErrorAsExit(new Error("The operation was aborted")), true);
    assert.equal(shouldTreatReadlineQuestionErrorAsExit(new Error("boom")), false);
  });

  await runTest("default prompt runtime can drive init from piped stdin", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-cli-home-"));
    const temporaryWorkspace = await mkdtemp(path.join(os.tmpdir(), "dbchat-cli-workspace-"));

    try {
      const answers = [
        "",
        "",
        "llm-test-key",
        "",
        "",
        "",
        "embedding-test-key",
        "",
        "",
        "local",
        "127.0.0.1",
        "",
        "",
        "database-secret",
        "",
        "appdb",
        "",
        "",
        "",
        "",
        "",
        "",
      ].join("\n");
      const result = await runCliWithInput(["init"], {
        cwd: temporaryWorkspace,
        env: {
          ...process.env,
          HOME: temporaryHome,
          USERPROFILE: temporaryHome,
          NO_COLOR: "1",
        },
        input: answers,
      });
      const configPath = path.join(temporaryHome, ".db-chat-cli", "config.json");
      const stored = JSON.parse(await readFile(configPath, "utf8")) as {
        llm?: { provider?: string; apiKey?: string };
        embedding?: { provider?: string; apiKey?: string };
        databaseHosts?: Array<{ name?: string; host?: string; databases?: Array<{ name?: string }> }>;
      };

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Configuration saved to:/);
      assert.equal(stored.llm?.provider, "openai");
      assert.equal(stored.llm?.apiKey, "llm-test-key");
      assert.equal(stored.embedding?.provider, "aliyun");
      assert.equal(stored.embedding?.apiKey, "embedding-test-key");
      assert.equal(stored.databaseHosts?.[0]?.name, "local");
      assert.equal(stored.databaseHosts?.[0]?.host, "127.0.0.1");
      assert.equal(stored.databaseHosts?.[0]?.databases?.[0]?.name, "appdb");
    } finally {
      await rm(temporaryWorkspace, { recursive: true, force: true });
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });

  await runTest("database commands show a friendly error when database config is incomplete", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-cli-home-"));
    const temporaryWorkspace = await mkdtemp(path.join(os.tmpdir(), "dbchat-cli-workspace-"));

    try {
      const schemaResult = await runCliWithInput(["schema"], {
        cwd: temporaryWorkspace,
        env: {
          ...process.env,
          HOME: temporaryHome,
          USERPROFILE: temporaryHome,
          NO_COLOR: "1",
        },
        input: "",
      });
      const catalogResult = await runCliWithInput(["catalog", "search", "users"], {
        cwd: temporaryWorkspace,
        env: {
          ...process.env,
          HOME: temporaryHome,
          USERPROFILE: temporaryHome,
          NO_COLOR: "1",
        },
        input: "",
      });

      assert.equal(schemaResult.code, 1);
      assert.equal(catalogResult.code, 1);
      assert.match(schemaResult.stderr, /Database configuration is incomplete/i);
      assert.match(catalogResult.stderr, /Database configuration is incomplete/i);
      assert.doesNotMatch(schemaResult.stderr, /"code": "too_small"/);
      assert.doesNotMatch(catalogResult.stderr, /"code": "too_small"/);
    } finally {
      await rm(temporaryWorkspace, { recursive: true, force: true });
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });
}
