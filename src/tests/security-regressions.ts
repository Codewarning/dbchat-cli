import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPostgresFieldNames } from "../db/postgres.js";
import { resolveOutputPathForExport } from "../export/csv.js";
import { refreshSchemaCatalogAfterSqlIfNeeded } from "../schema/catalog-refresh.js";
import { createDatabaseStub, createTestConfig, createTestIo, type RunTest } from "./support.js";

export async function registerSecurityRegressionTests(runTest: RunTest): Promise<void> {
  await runTest("Postgres field metadata keeps columns for empty result sets", () => {
    assert.deepEqual(
      getPostgresFieldNames({
        rows: [],
        fields: [{ name: "id" }, { name: "email" }],
      }),
      ["id", "email"],
    );
  });

  await runTest("export path resolution rejects symlinked directory escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dbchat-export-"));
    try {
      const cwd = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      const escapedLink = path.join(cwd, "escaped");
      await mkdir(cwd, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, escapedLink, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(() => resolveOutputPathForExport(cwd, "escaped/result.json"), /current working directory/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await runTest("schema-changing SQL marks the local catalog as manually refreshable instead of auto-refreshing it", async () => {
    let inspectedLiveSchema = false;
    const config = createTestConfig();
    const ioMessages: string[] = [];
    const db = createDatabaseStub({
      async getAllTableSchemas() {
        inspectedLiveSchema = true;
        return [];
      },
    });
    const io = {
      ...createTestIo(),
      log(message: string) {
        ioMessages.push(message);
      },
    };

    const outcome = await refreshSchemaCatalogAfterSqlIfNeeded(
      config,
      db,
      io,
      "create table users(id int)",
      "CREATE",
      true,
    );

    assert.equal(outcome.status, "manual_required");
    assert.match(outcome.reason, /run `dbchat catalog sync` manually/i);
    assert.equal(inspectedLiveSchema, false);
    assert.match(ioMessages.join("\n"), /automatic schema catalog refresh is disabled/i);
  });
}
