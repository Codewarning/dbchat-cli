import assert from "node:assert/strict";
import { buildSystemPrompt } from "../agent/prompts.js";
import { applyResultRowLimit } from "../db/query-results.js";
import { assessSqlSafety, ensureSingleStatement } from "../db/safety.js";
import { shouldRefreshSchemaCatalogAfterSql } from "../schema/catalog.js";
import { executeSqlStatement } from "../sql/execution.js";
import { serializeToolResultForModel } from "../tools/model-payload.js";
import type { AgentIO } from "../types/index.js";
import { RunTest, createDatabaseStub, createTestConfig } from "./support.js";

export async function registerSqlExecutionTests(runTest: RunTest): Promise<void> {
  await runTest("CTE mutation statements are classified as mutations", () => {
    const safety = assessSqlSafety(`
      WITH inactive_users AS (
        SELECT id
        FROM users
        WHERE last_seen_at < now() - interval '90 days'
      )
      UPDATE users
         SET active = false
       WHERE id IN (SELECT id FROM inactive_users)
    `);

    assert.equal(safety.operation, "UPDATE");
    assert.equal(safety.isMutation, true);
    assert.equal(safety.executionCategory, "dml");
  });

  await runTest("CTE select statements stay read-only", () => {
    const safety = assessSqlSafety(`
      WITH recent_orders AS (
        SELECT id, created_at
        FROM orders
        ORDER BY created_at DESC
        LIMIT 5
      )
      SELECT *
      FROM recent_orders
    `);

    assert.equal(safety.operation, "SELECT");
    assert.equal(safety.isMutation, false);
    assert.equal(safety.executionCategory, "read_only");
  });

  await runTest("DDL statements are classified separately from DML", () => {
    const safety = assessSqlSafety("create table audit_log(id int)");
    assert.equal(safety.operation, "CREATE");
    assert.equal(safety.executionCategory, "ddl");
  });

  await runTest("table schema changes trigger schema catalog refresh checks", () => {
    assert.equal(shouldRefreshSchemaCatalogAfterSql("create table audit_log(id int)", "CREATE"), true);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("alter table users add column nickname text", "ALTER"), true);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("drop table temp_users", "DROP"), true);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("create index idx_users_email on users(email)", "CREATE"), false);
    assert.equal(shouldRefreshSchemaCatalogAfterSql("truncate table users", "TRUNCATE"), false);
  });

  await runTest("single-statement guard still rejects multiple statements", () => {
    assert.throws(() => ensureSingleStatement("select 1; select 2"), /Only a single SQL statement/i);
  });

  await runTest("single-statement guard allows a trailing comment after the terminator", () => {
    assert.doesNotThrow(() => ensureSingleStatement("select 1; -- trailing comment"));
  });

  await runTest("single-statement guard allows semicolons inside Postgres dollar-quoted strings", () => {
    assert.doesNotThrow(() => ensureSingleStatement("select $$a;b$$"));
  });

  await runTest("comment markers inside strings do not break CTE classification", () => {
    const safety = assessSqlSafety("with x as (select '--not comment' as value) select * from x");
    assert.equal(safety.operation, "SELECT");
    assert.equal(safety.executionCategory, "read_only");
  });

  await runTest("applyResultRowLimit trims cached rows and marks truncation", () => {
    const result = applyResultRowLimit(
      "select * from users",
      "SELECT",
      4,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      ["id"],
      12.5,
      { maxRows: 2 },
    );

    assert.equal(result.rowCount, 4);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rowsTruncated, true);
  });

  await runTest("applyResultRowLimit keeps all rows when the cache limit is not exceeded", () => {
    const result = applyResultRowLimit("select 1", "SELECT", 1, [{ value: 1 }], ["value"], 1.2, { maxRows: 10 });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rowsTruncated, false);
  });

  await runTest("system prompt explains that blocked SQL does not reach approval", () => {
    const prompt = buildSystemPrompt(createTestConfig());
    assert.match(prompt, /blocked before execution and no terminal approval prompt will appear/i);
    assert.match(prompt, /Do not tell the user to confirm in the terminal in that case/i);
  });

  await runTest("Approve Once executes one DML statement without unlocking later approvals", async () => {
    const approveSqlCalls: string[] = [];
    let executeCount = 0;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql(message: string) {
        approveSqlCalls.push(message);
        return "approve_once";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = createDatabaseStub({
      async execute(sql: string) {
        executeCount += 1;
        return {
          sql,
          operation: "UPDATE" as const,
          rowCount: 1,
          rows: [],
          rowsTruncated: false,
          fields: [],
          elapsedMs: 1,
        };
      },
    });

    const approvalState = { allowAllForCurrentTurn: false };
    const first = await executeSqlStatement({
      db,
      io,
      sql: "update users set active = false where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update_delete",
      approvalState,
    });
    const second = await executeSqlStatement({
      db,
      io,
      sql: "delete from users where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update_delete",
      approvalState,
    });

    assert.equal(first.status, "executed");
    assert.equal(second.status, "executed");
    assert.equal(executeCount, 2);
    assert.equal(approveSqlCalls.length, 2);
    assert.equal(approvalState.allowAllForCurrentTurn, false);
  });

  await runTest("Approve All For Turn skips later prompts in the same request", async () => {
    let approveSqlCallCount = 0;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        approveSqlCallCount += 1;
        return "approve_all";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = createDatabaseStub({
      async execute(sql: string) {
        return {
          sql,
          operation: "ALTER" as const,
          rowCount: 0,
          rows: [],
          rowsTruncated: false,
          fields: [],
          elapsedMs: 1,
        };
      },
    });

    const approvalState = { allowAllForCurrentTurn: false };
    await executeSqlStatement({
      db,
      io,
      sql: "alter table users add column nickname text",
      resultRowLimit: 20,
      operationAccess: "select_update_delete_ddl",
      approvalState,
    });
    await executeSqlStatement({
      db,
      io,
      sql: "drop table temp_users",
      resultRowLimit: 20,
      operationAccess: "select_update_delete_ddl",
      approvalState,
    });

    assert.equal(approveSqlCallCount, 1);
    assert.equal(approvalState.allowAllForCurrentTurn, true);
  });

  await runTest("Reject cancels a mutating statement", async () => {
    let executeCalled = false;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        return "reject";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = createDatabaseStub({
      async execute() {
        executeCalled = true;
        throw new Error("not used");
      },
    });

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "delete from users where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update_delete",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "cancelled");
    assert.equal(executeCalled, false);
  });

  await runTest("read-only database access blocks UPDATE without approval", async () => {
    let executeCalled = false;
    let approveSqlCalled = false;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        approveSqlCalled = true;
        return "approve_once";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = createDatabaseStub({
      async execute() {
        executeCalled = true;
        throw new Error("not used");
      },
    });

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "update users set active = false where id = 1",
      resultRowLimit: 20,
      operationAccess: "read_only",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "cancelled");
    assert.match(outcome.reason, /read-only/i);
    assert.equal(executeCalled, false);
    assert.equal(approveSqlCalled, false);
  });

  await runTest("SELECT + INSERT + UPDATE access still blocks DELETE", async () => {
    let executeCalled = false;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        throw new Error("approveSql should not be called when access blocks the statement");
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = createDatabaseStub({
      async execute() {
        executeCalled = true;
        throw new Error("not used");
      },
    });

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "delete from users where id = 1",
      resultRowLimit: 20,
      operationAccess: "select_update",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "cancelled");
    assert.match(outcome.reason, /DELETE is not allowed/i);
    assert.equal(executeCalled, false);
  });

  await runTest("SELECT + INSERT + UPDATE access allows INSERT with approval", async () => {
    let approveSqlCallCount = 0;
    let executeCallCount = 0;
    const io: AgentIO = {
      cwd: process.cwd(),
      log() {},
      logBlock() {},
      async confirm() {
        throw new Error("confirm should not be used for SQL approval");
      },
      async approveSql() {
        approveSqlCallCount += 1;
        return "approve_once";
      },
      async withLoading(_message, task) {
        return task();
      },
    };

    const db = createDatabaseStub({
      async execute(sql: string) {
        executeCallCount += 1;
        return {
          sql,
          operation: "INSERT" as const,
          rowCount: 1,
          rows: [],
          rowsTruncated: false,
          fields: [],
          elapsedMs: 1,
        };
      },
    });

    const outcome = await executeSqlStatement({
      db,
      io,
      sql: "insert into users(id, name) values (1, 'alice')",
      resultRowLimit: 20,
      operationAccess: "select_update",
      approvalState: { allowAllForCurrentTurn: false },
    });

    assert.equal(outcome.status, "executed");
    assert.equal(approveSqlCallCount, 1);
    assert.equal(executeCallCount, 1);
  });

  await runTest("cancelled SQL payload tells the model when access policy blocked execution", () => {
    const serialized = serializeToolResultForModel(
      "run_sql",
      {
        status: "cancelled",
        cancelledBy: "database_access",
        approvalPromptShown: false,
        reason: "SQL blocked by database access 'read-only': CREATE is not allowed.",
        sql: "create table users(id int)",
        operation: "CREATE",
        executionCategory: "ddl",
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.cancelledBy, "database_access");
    assert.equal(payload.approvalPromptShown, false);
    assert.match(serialized.summary, /blocked by database access policy/i);
  });

  await runTest("successful SQL payload includes a plain-text preview table", () => {
    const serialized = serializeToolResultForModel(
      "run_sql",
      {
        status: "executed",
        sql: "select email, bookmark_count from users limit 2",
        operation: "SELECT",
        rowCount: 2,
        rows: [
          { email: "admin@123.com", bookmark_count: 64 },
          { email: "test@example.com", bookmark_count: 0 },
        ],
        rowsTruncated: false,
        fields: ["email", "bookmark_count"],
        elapsedMs: 3.2,
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.equal(typeof payload.previewTable, "string");
    assert.match(String(payload.previewTable), /email/);
    assert.match(String(payload.previewTable), /bookmark_count/);
    assert.match(String(payload.previewTable), /admin@123\.com/);
  });

  await runTest("wide SQL payload trims fields and can omit the text table preview", () => {
    const serialized = serializeToolResultForModel(
      "run_sql",
      {
        status: "executed",
        sql: "select * from wide_users limit 2",
        operation: "SELECT",
        rowCount: 2,
        rows: [
          {
            c1: 1,
            c2: 2,
            c3: 3,
            c4: 4,
            c5: 5,
            c6: 6,
            c7: 7,
            c8: 8,
            c9: 9,
          },
          {
            c1: 11,
            c2: 12,
            c3: 13,
            c4: 14,
            c5: 15,
            c6: 16,
            c7: 17,
            c8: 18,
            c9: 19,
          },
        ],
        rowsTruncated: false,
        fields: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"],
        elapsedMs: 3.2,
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.deepEqual(payload.fields, ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
    assert.equal(payload.omittedFieldCount, 1);
    assert.equal(payload.previewTable, undefined);
  });

  await runTest("explain payload is clipped because detailed inspection can use the cache tool", () => {
    const serialized = serializeToolResultForModel(
      "explain_sql",
      {
        sql: "select * from users where id = 1",
        operation: "SELECT",
        elapsedMs: 12,
        warnings: [],
        rawPlan: "Node ".repeat(800),
      },
      createTestConfig().app,
    );

    const payload = JSON.parse(serialized.content) as Record<string, unknown>;
    assert.ok(String(payload.planPreview).length <= 1200);
  });
}
