import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationTurn, createSessionContextMemory } from "../agent/memory.js";
import { buildSessionMessages } from "../agent/message-builder.js";
import {
  getDatabaseInstructionPath,
  getDatabaseTableInstructionsDirectory,
  getGlobalInstructionPath,
  getHostInstructionPath,
  getTableInstructionPath,
  loadScopedInstructionBundle,
} from "../instructions/scoped.js";
import { initializeScopedInstructionFilesForDatabase } from "../services/scoped-instructions.js";
import { syncSchemaCatalog } from "../schema/catalog.js";
import { RunTest, createDatabaseStub, createTestConfig } from "./support.js";

async function withTemporaryHome(test: () => Promise<void>): Promise<void> {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-instructions-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = temporaryHome;
  process.env.USERPROFILE = temporaryHome;

  try {
    await test();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }

    await rm(temporaryHome, { recursive: true, force: true });
  }
}

async function writeInstruction(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function registerScopedInstructionTests(runTest: RunTest): Promise<void> {
  await runTest("scoped instruction bootstrap uses AGENTS.md names and creates missing table markdown files only once", async () => {
    await withTemporaryHome(async () => {
      const config = createTestConfig();
      const globalPath = getGlobalInstructionPath();
      const hostPath = getHostInstructionPath(config.database);
      const databasePath = getDatabaseInstructionPath(config.database);
      const usersTablePath = getTableInstructionPath(config.database, "users");
      const auditTablePath = getTableInstructionPath(config.database, "Audit.Log");

      assert.match(globalPath, /agents[\\/]AGENTS\.md$/i);
      assert.match(hostPath, /agents[\\/]localhost-5432[\\/]AGENTS\.md$/i);
      assert.doesNotMatch(hostPath, /postgres/i);
      assert.match(databasePath, /localhost-5432[\\/]testdb[\\/]AGENTS\.md$/i);
      assert.match(usersTablePath, /tables[\\/]users\.md$/i);
      assert.match(auditTablePath, /tables[\\/]audit\.log\.md$/i);
      assert.match(getDatabaseTableInstructionsDirectory(config.database), /localhost-5432[\\/]testdb[\\/]tables$/i);

      const firstBootstrap = await initializeScopedInstructionFilesForDatabase(
        config.database,
        createDatabaseStub({
          async getSchemaSummary() {
            return {
              dialect: "postgres",
              database: "testdb",
              schema: "public",
              tables: [{ tableName: "users" }, { tableName: "Audit.Log" }],
            };
          },
        }),
      );

      assert.ok(firstBootstrap.createdPaths.includes(globalPath));
      assert.ok(firstBootstrap.createdPaths.includes(hostPath));
      assert.ok(firstBootstrap.createdPaths.includes(databasePath));
      assert.ok(firstBootstrap.createdPaths.includes(usersTablePath));
      assert.ok(firstBootstrap.createdPaths.includes(auditTablePath));
      assert.equal(await readFile(globalPath, "utf8"), "");
      assert.equal(await readFile(usersTablePath, "utf8"), "");

      await writeFile(databasePath, "db specific instructions", "utf8");
      const secondBootstrap = await initializeScopedInstructionFilesForDatabase(
        config.database,
        createDatabaseStub({
          async getSchemaSummary() {
            return {
              dialect: "postgres",
              database: "testdb",
              schema: "public",
              tables: [{ tableName: "users" }, { tableName: "Audit.Log" }],
            };
          },
        }),
      );

      assert.deepEqual(secondBootstrap.createdPaths, []);
      assert.equal(await readFile(databasePath, "utf8"), "db specific instructions");
    });
  });

  await runTest("scoped instruction bootstrap ignores missing or blank table names from schema summaries", async () => {
    await withTemporaryHome(async () => {
      const config = createTestConfig();
      const usersTablePath = getTableInstructionPath(config.database, "users");

      const bootstrap = await initializeScopedInstructionFilesForDatabase(
        config.database,
        createDatabaseStub({
          async getSchemaSummary() {
            return {
              dialect: "postgres",
              database: "testdb",
              schema: "public",
              tables: [
                { tableName: undefined as unknown as string },
                { tableName: " users " },
                { tableName: "" as string },
                { tableName: "users" },
              ],
            };
          },
        }),
      );

      assert.ok(bootstrap.createdPaths.includes(usersTablePath));
      const tableFiles = (await readdir(getDatabaseTableInstructionsDirectory(config.database))).filter((fileName) => fileName.toLowerCase().endsWith(".md"));
      assert.deepEqual(tableFiles, ["users.md"]);
      assert.equal(await readFile(usersTablePath, "utf8"), "");
    });
  });

  await runTest("scoped instructions merge global host and database layers with audience-specific sections", async () => {
    await withTemporaryHome(async () => {
      const config = createTestConfig();
      await writeInstruction(
        getGlobalInstructionPath(),
        ["# Global", "## Shared", "global shared note", "## Runtime", "global runtime note", "## Catalog", "global catalog note"].join("\n\n"),
      );
      await writeInstruction(
        getHostInstructionPath(config.database),
        ["# Host", "## Shared", "host shared note", "## Runtime", "host runtime note", "## Catalog", "host catalog note"].join("\n\n"),
      );
      await writeInstruction(
        getDatabaseInstructionPath(config.database),
        [
          "# Database",
          "## Shared",
          "database shared note",
          "## Runtime",
          "database runtime note",
          "## Catalog",
          "database catalog note",
        ].join("\n\n"),
      );

      const runtimeBundle = await loadScopedInstructionBundle(config.database, "runtime");
      assert.match(runtimeBundle.mergedText ?? "", /global shared note/i);
      assert.match(runtimeBundle.mergedText ?? "", /host shared note/i);
      assert.match(runtimeBundle.mergedText ?? "", /database runtime note/i);
      assert.doesNotMatch(runtimeBundle.mergedText ?? "", /catalog note/i);
      assert.ok((runtimeBundle.mergedText ?? "").indexOf("Global instructions:") < (runtimeBundle.mergedText ?? "").indexOf("Host instructions:"));
      assert.ok((runtimeBundle.mergedText ?? "").indexOf("Host instructions:") < (runtimeBundle.mergedText ?? "").indexOf("Database instructions:"));

      const catalogBundle = await loadScopedInstructionBundle(config.database, "catalog");
      assert.match(catalogBundle.mergedText ?? "", /global catalog note/i);
      assert.match(catalogBundle.mergedText ?? "", /host catalog note/i);
      assert.match(catalogBundle.mergedText ?? "", /database catalog note/i);
      assert.doesNotMatch(catalogBundle.mergedText ?? "", /runtime note/i);
      assert.ok(catalogBundle.fingerprint);
    });
  });

  await runTest("message builder inserts scoped instructions as a separate system message", () => {
    const messages = buildSessionMessages(
      createTestConfig(),
      [],
      null,
      createSessionContextMemory(),
      [],
      createConversationTurn("show users"),
      "show users",
      "Scoped database instructions are active.\n\nDatabase instructions:\nPrefer business names from the CRM team.",
    );
    const systemMessages = messages.filter((message) => message.role === "system");

    assert.equal(systemMessages.length, 2);
    assert.match(systemMessages[0]?.content ?? "", /You are a database CLI assistant/i);
    assert.match(systemMessages[1]?.content ?? "", /Scoped database instructions are active/i);
    assert.match(systemMessages[1]?.content ?? "", /CRM team/i);
  });

  await runTest("schema catalog sync records catalog instruction context in persisted table documents", async () => {
    await withTemporaryHome(async () => {
      const config = createTestConfig();
      config.embedding.apiKey = "";
      await writeInstruction(
        getGlobalInstructionPath(),
        ["## Shared", "shared glossary", "## Catalog", "global settlement ledger"].join("\n\n"),
      );
      await writeInstruction(
        getHostInstructionPath(config.database),
        ["## Catalog", "host treasury mappings"].join("\n\n"),
      );
      await writeInstruction(
        getDatabaseInstructionPath(config.database),
        ["## Runtime", "runtime only wording", "## Catalog", "vipsettlement semantic anchor"].join("\n\n"),
      );

      const synced = await syncSchemaCatalog(
        config,
        createDatabaseStub({
          async getAllTableSchemas() {
            return [
              {
                tableName: "orders",
                comment: "Order records",
                columns: [
                  { name: "id", dataType: "integer", isNullable: false, defaultValue: null },
                  { name: "customer_id", dataType: "integer", isNullable: false, defaultValue: null },
                ],
                relations: [],
              },
            ];
          },
        }),
      );

      assert.ok(synced.catalog.instructionFingerprint);
      assert.match(synced.catalog.tables[0]?.instructionContext ?? "", /vipsettlement semantic anchor/i);
      assert.match(synced.catalog.tables[0]?.instructionContext ?? "", /host treasury mappings/i);
      assert.doesNotMatch(synced.catalog.tables[0]?.instructionContext ?? "", /runtime only wording/i);
      assert.ok(synced.catalog.documents.some((document) => /vipsettlement semantic anchor/i.test(document.content)));
    });
  });

  await runTest("catalog sync backfills missing table markdown files and archives stale ones without overwriting current files", async () => {
    await withTemporaryHome(async () => {
      const config = createTestConfig();
      config.embedding.apiKey = "";
      const existingUsersTablePath = getTableInstructionPath(config.database, "users");
      const staleLegacyTablePath = getTableInstructionPath(config.database, "legacy");
      await writeInstruction(existingUsersTablePath, "keep this users note");
      await writeInstruction(staleLegacyTablePath, "archive this legacy note");

      await syncSchemaCatalog(
        config,
        createDatabaseStub({
          async getAllTableSchemas() {
            return [
              {
                tableName: "users",
                comment: "Users table",
                columns: [{ name: "id", dataType: "integer", isNullable: false, defaultValue: null }],
                relations: [],
              },
              {
                tableName: "orders",
                comment: "Orders table",
                columns: [{ name: "id", dataType: "integer", isNullable: false, defaultValue: null }],
                relations: [],
              },
            ];
          },
        }),
      );

      assert.equal(await readFile(existingUsersTablePath, "utf8"), "keep this users note");
      const tableFiles = await readdir(getDatabaseTableInstructionsDirectory(config.database));
      const archivedLegacyFile = tableFiles.find((fileName) => /^legacy-delete-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/i.test(fileName));
      assert.ok(archivedLegacyFile);
      assert.equal(await readFile(path.join(getDatabaseTableInstructionsDirectory(config.database), archivedLegacyFile!), "utf8"), "archive this legacy note");
      await assert.rejects(readFile(staleLegacyTablePath, "utf8"), /ENOENT/i);
      assert.equal(await readFile(getTableInstructionPath(config.database, "orders"), "utf8"), "");
      assert.equal(await readFile(getDatabaseInstructionPath(config.database), "utf8"), "");
      assert.equal(await readFile(getHostInstructionPath(config.database), "utf8"), "");
      assert.equal(await readFile(getGlobalInstructionPath(), "utf8"), "");
    });
  });
}
