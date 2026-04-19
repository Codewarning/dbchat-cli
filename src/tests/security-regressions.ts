import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfigDirectory } from "../config/paths.js";
import { getPostgresFieldNames } from "../db/postgres.js";
import { exportQueryResult } from "../export/csv.js";
import { createWorkspaceTempArtifactPath, cleanupExpiredWorkspaceTempArtifacts, getWorkspaceTempArtifactsDirectory } from "../fs/temp-artifacts.js";
import { refreshSchemaCatalogAfterSqlIfNeeded } from "../schema/catalog-refresh.js";
import { attachQueryResultHtmlArtifact, writeQueryResultHtmlArtifact } from "../ui/query-result-html.js";
import { buildQueryResultPreview } from "../ui/query-result-preview.js";
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

  await runTest("exports are written under the config temp directory and return a file URL", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-export-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const cwd = path.join(temporaryHome, "workspace");
      await mkdir(cwd, { recursive: true });
      const exported = await exportQueryResult(
        {
          sql: "select id, email from users",
          operation: "SELECT",
          rowCount: 1,
          rows: [{ id: 1, email: "a@example.com" }],
          rowsTruncated: false,
          fields: ["id", "email"],
          elapsedMs: 1,
        },
        "csv",
        "users.csv",
        cwd,
      );

      assert.equal(path.dirname(exported.outputPath), await getWorkspaceTempArtifactsDirectory());
      assert.equal(path.dirname(exported.outputPath), path.join(getConfigDirectory(), "tmp"));
      assert.match(exported.outputPath, /\.csv$/i);
      assert.match(exported.fileUrl, /^file:\/\//i);
      const content = await readFile(exported.outputPath, "utf8");
      assert.match(content, /^id,email/m);
      assert.match(content, /a@example\.com/);
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
  });

  await runTest("config temp cleanup removes files older than the retention window", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-temp-cleanup-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const stalePath = await createWorkspaceTempArtifactPath({
        prefix: "stale-result",
        extension: ".html",
      });
      await writeFile(stalePath, "<html></html>", "utf8");

      await cleanupExpiredWorkspaceTempArtifacts({
        now: Date.now() + 8 * 24 * 60 * 60 * 1000,
      });

      await assert.rejects(() => access(stalePath), /ENOENT|no such file/i);
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
  });

  await runTest("config temp cleanup defaults to 3 retention days", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-temp-default-retention-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const stalePath = await createWorkspaceTempArtifactPath({
        prefix: "stale-default-result",
        extension: ".html",
      });
      await writeFile(stalePath, "<html></html>", "utf8");

      await cleanupExpiredWorkspaceTempArtifacts({
        now: Date.now() + 4 * 24 * 60 * 60 * 1000,
      });

      await assert.rejects(() => access(stalePath), /ENOENT|no such file/i);
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
  });

  await runTest("generated temp artifact names normalize underscores to hyphens", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-temp-name-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const artifactPath = await createWorkspaceTempArtifactPath({
        prefix: "result_cache",
        extension: ".csv",
        suggestedName: "bookmarks_export_file.csv",
      });

      const fileName = path.basename(artifactPath);
      assert.doesNotMatch(fileName, /_/);
      assert.match(fileName, /^result-cache-bookmarks-export-file-/);
      assert.match(fileName, /\.csv$/i);
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
  });

  await runTest("query result HTML constrains cell content width and adds expandable overflow controls", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-html-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const cwd = path.join(temporaryHome, "workspace");
      await mkdir(cwd, { recursive: true });
      const artifact = await writeQueryResultHtmlArtifact(
        {
          sql: "select title, url from bookmarks",
          operation: "SELECT",
          rowCount: 1,
          rows: [
            {
              title: "A very long title that should stay inside the constrained field content container",
              url: "https://example.com/really/long/path/that/should/wrap/in/the/exported/html/view",
            },
          ],
          rowsTruncated: false,
          fields: ["title", "url"],
          elapsedMs: 1,
        },
        cwd,
      );

      const html = await readFile(artifact.outputPath, "utf8");
      assert.match(html, /\.cell-content\s*\{/);
      assert.match(html, /max-width:\s*180px;/);
      assert.match(html, /\.cell-content__inner\s*\{/);
      assert.match(html, /max-height:\s*var\(--cell-max-height\);/);
      assert.match(html, /<td><div class="cell-content" data-expandable-cell><div class="cell-content__inner" data-cell-inner>/);
      assert.match(html, /class="cell-toggle" type="button" hidden aria-expanded="false">Expand<\/button>/);
      assert.match(html, /querySelectorAll\('\[data-expandable-cell\]'\)/);
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
  });

  await runTest("empty query results do not create HTML or CSV artifacts", async () => {
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "dbchat-empty-html-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = temporaryHome;
    process.env.USERPROFILE = temporaryHome;

    try {
      const cwd = path.join(temporaryHome, "workspace");
      await mkdir(cwd, { recursive: true });
      const result = await attachQueryResultHtmlArtifact(
        {
          sql: "select article_id, title from articles where published = true",
          operation: "SELECT",
          rowCount: 0,
          rows: [],
          rowsTruncated: false,
          fields: ["article_id", "title"],
          elapsedMs: 1,
        },
        cwd,
      );

      assert.equal(result.htmlArtifact, undefined);
      const artifactFiles = await readdir(await getWorkspaceTempArtifactsDirectory());
      assert.equal(artifactFiles.length, 0);
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
  });

  await runTest("empty query result preview does not suggest opening a missing HTML artifact", () => {
    const preview = buildQueryResultPreview(
      {
        sql: "select article_id, title, sub_title, category, status, publish_status, create_time, update_time, content_type, copy_from, article_content, source_name from articles where published = true",
        operation: "SELECT",
        rowCount: 0,
        rows: [],
        rowsTruncated: false,
        fields: [
          "article_id",
          "title",
          "sub_title",
          "category",
          "status",
          "publish_status",
          "create_time",
          "update_time",
          "content_type",
          "copy_from",
          "article_content",
          "source_name",
        ],
        elapsedMs: 1,
      },
      {
        tableRendering: createTestConfig().app.tableRendering,
      },
    );

    assert.match(preview.renderedText, /SQL result rows 0-0 of 0:/);
    assert.match(preview.renderedText, /Showing 8 of 12 columns in the terminal preview\./);
    assert.doesNotMatch(preview.renderedText, /Open the HTML view for all columns/i);
    assert.doesNotMatch(preview.renderedText, /Open full table in a browser/i);
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
