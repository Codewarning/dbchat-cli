// SQL safety helpers enforce the project's single-statement and confirmation invariants.
import type { SqlExecutionCategory, SqlOperation, SqlSafetyAssessment } from "../types/index.js";

const READ_ONLY_OPERATIONS = new Set<SqlOperation>(["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"]);
const MUTATION_OPERATIONS = new Set<SqlOperation>(["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"]);
const DML_OPERATIONS = new Set<SqlOperation>(["INSERT", "UPDATE", "DELETE"]);
const DDL_OPERATIONS = new Set<SqlOperation>(["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"]);

function skipWhitespace(value: string, index: number): number {
  let nextIndex = index;
  while (nextIndex < value.length && /\s/.test(value[nextIndex] ?? "")) {
    nextIndex += 1;
  }

  return nextIndex;
}

function readKeyword(value: string, index: number): { keyword: string; nextIndex: number } | null {
  const startIndex = skipWhitespace(value, index);
  const match = value.slice(startIndex).match(/^([a-zA-Z]+)/);
  if (!match?.[1]) {
    return null;
  }

  return {
    keyword: match[1].toUpperCase(),
    nextIndex: startIndex + match[1].length,
  };
}

function skipQuotedIdentifier(value: string, index: number, quote: "\"" | "`"): number {
  let nextIndex = index + 1;
  while (nextIndex < value.length) {
    const character = value[nextIndex];
    if (character === quote) {
      if ((quote === "\"" && value[nextIndex + 1] === "\"") || (quote === "`" && value[nextIndex + 1] === "`")) {
        nextIndex += 2;
        continue;
      }

      return nextIndex + 1;
    }

    nextIndex += 1;
  }

  return nextIndex;
}

function skipIdentifier(value: string, index: number): number {
  const startIndex = skipWhitespace(value, index);
  const firstCharacter = value[startIndex];
  if (!firstCharacter) {
    return startIndex;
  }

  if (firstCharacter === "\"" || firstCharacter === "`") {
    return skipQuotedIdentifier(value, startIndex, firstCharacter);
  }

  let nextIndex = startIndex;
  while (nextIndex < value.length && /[a-zA-Z0-9_$]/.test(value[nextIndex] ?? "")) {
    nextIndex += 1;
  }

  return nextIndex;
}

function readDollarQuoteTag(value: string, index: number): string | null {
  const match = value.slice(index).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] ?? null;
}

function skipDollarQuotedString(value: string, index: number, tag: string): number {
  const closingIndex = value.indexOf(tag, index + tag.length);
  return closingIndex === -1 ? value.length : closingIndex + tag.length;
}

function skipLineComment(value: string, index: number): number {
  let nextIndex = index + 2;
  while (nextIndex < value.length && value[nextIndex] !== "\n") {
    nextIndex += 1;
  }

  return nextIndex;
}

function skipBlockComment(value: string, index: number): number {
  let depth = 1;
  let nextIndex = index + 2;

  while (nextIndex < value.length) {
    if (value.startsWith("/*", nextIndex)) {
      depth += 1;
      nextIndex += 2;
      continue;
    }

    if (value.startsWith("*/", nextIndex)) {
      depth -= 1;
      nextIndex += 2;
      if (depth === 0) {
        return nextIndex;
      }
      continue;
    }

    nextIndex += 1;
  }

  return nextIndex;
}

function skipQuotedString(value: string, index: number, quote: "'" | "\""): number {
  let nextIndex = index + 1;
  while (nextIndex < value.length) {
    const character = value[nextIndex];
    if (character === "\\") {
      nextIndex += 2;
      continue;
    }

    if (character === quote) {
      if (quote === "'" && value[nextIndex + 1] === "'") {
        nextIndex += 2;
        continue;
      }

      if (quote === "\"" && value[nextIndex + 1] === "\"") {
        nextIndex += 2;
        continue;
      }

      return nextIndex + 1;
    }

    nextIndex += 1;
  }

  return nextIndex;
}

function skipParenthesizedExpression(value: string, index: number): number {
  let depth = 0;
  let nextIndex = index;
  while (nextIndex < value.length) {
    if (value.startsWith("--", nextIndex)) {
      nextIndex = skipLineComment(value, nextIndex);
      continue;
    }

    if (value.startsWith("/*", nextIndex)) {
      nextIndex = skipBlockComment(value, nextIndex);
      continue;
    }

    const dollarQuoteTag = readDollarQuoteTag(value, nextIndex);
    if (dollarQuoteTag) {
      nextIndex = skipDollarQuotedString(value, nextIndex, dollarQuoteTag);
      continue;
    }

    const character = value[nextIndex];
    if (character === "'" || character === "\"") {
      nextIndex = skipQuotedString(value, nextIndex, character);
      continue;
    }

    if (character === "`") {
      nextIndex = skipQuotedIdentifier(value, nextIndex, "`");
      continue;
    }

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return nextIndex + 1;
      }
    }

    nextIndex += 1;
  }

  return nextIndex;
}

function inferOperationAfterWith(sql: string, index: number): SqlOperation {
  let nextIndex = index;
  const recursiveKeyword = readKeyword(sql, nextIndex);
  if (recursiveKeyword?.keyword === "RECURSIVE") {
    nextIndex = recursiveKeyword.nextIndex;
  }

  while (nextIndex < sql.length) {
    nextIndex = skipIdentifier(sql, nextIndex);
    nextIndex = skipWhitespace(sql, nextIndex);
    if (sql[nextIndex] === "(") {
      nextIndex = skipParenthesizedExpression(sql, nextIndex);
    }

    const asKeyword = readKeyword(sql, nextIndex);
    if (asKeyword?.keyword !== "AS") {
      return "UNKNOWN";
    }

    nextIndex = skipWhitespace(sql, asKeyword.nextIndex);
    if (sql[nextIndex] !== "(") {
      return "UNKNOWN";
    }

    nextIndex = skipParenthesizedExpression(sql, nextIndex);
    nextIndex = skipWhitespace(sql, nextIndex);
    if (sql[nextIndex] === ",") {
      nextIndex += 1;
      continue;
    }

    const statementKeyword = readKeyword(sql, nextIndex);
    if (!statementKeyword) {
      return "UNKNOWN";
    }

    return normalizeOperationKeyword(statementKeyword.keyword);
  }

  return "UNKNOWN";
}

function normalizeOperationKeyword(keyword: string | undefined): SqlOperation {
  switch (keyword) {
    case "SELECT":
    case "SHOW":
    case "DESCRIBE":
    case "EXPLAIN":
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "CREATE":
    case "ALTER":
    case "DROP":
    case "TRUNCATE":
    case "RENAME":
      return keyword;
    default:
      return "UNKNOWN";
  }
}

/**
 * Remove line and block comments before doing lightweight SQL inspection.
 */
export function stripSqlComments(sql: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const dollarQuoteTag = readDollarQuoteTag(sql, index);
    if (dollarQuoteTag) {
      const nextIndex = skipDollarQuotedString(sql, index, dollarQuoteTag);
      result += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    const character = sql[index] ?? "";
    if (character === "'" || character === "\"") {
      const nextIndex = skipQuotedString(sql, index, character);
      result += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    if (character === "`") {
      const nextIndex = skipQuotedIdentifier(sql, index, "`");
      result += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    if (sql.startsWith("--", index)) {
      if (result && !/\s$/.test(result)) {
        result += " ";
      }
      index = skipLineComment(sql, index);
      continue;
    }

    if (sql.startsWith("/*", index)) {
      if (result && !/\s$/.test(result)) {
        result += " ";
      }
      index = skipBlockComment(sql, index);
      continue;
    }

    result += character;
    index += 1;
  }

  return result.trim();
}

/**
 * Split SQL into statements while respecting quoted string boundaries.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = "";
  let index = 0;

  // This scanner is comment-aware and quote-aware so delimiters inside literals do not split statements.
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      const nextIndex = skipLineComment(sql, index);
      buffer += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    if (sql.startsWith("/*", index)) {
      const nextIndex = skipBlockComment(sql, index);
      buffer += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    const dollarQuoteTag = readDollarQuoteTag(sql, index);
    if (dollarQuoteTag) {
      const nextIndex = skipDollarQuotedString(sql, index, dollarQuoteTag);
      buffer += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    const character = sql[index] ?? "";
    if (character === "'" || character === "\"") {
      const nextIndex = skipQuotedString(sql, index, character);
      buffer += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    if (character === "`") {
      const nextIndex = skipQuotedIdentifier(sql, index, "`");
      buffer += sql.slice(index, nextIndex);
      index = nextIndex;
      continue;
    }

    if (character === ";") {
      const statement = stripSqlComments(buffer);
      if (statement) {
        statements.push(statement);
      }
      buffer = "";
      index += 1;
      continue;
    }

    buffer += character;
    index += 1;
  }

  const tail = stripSqlComments(buffer);
  if (tail) {
    statements.push(tail);
  }

  return statements;
}

/**
 * Infer the leading SQL operation keyword used by one statement.
 */
export function inferSqlOperation(sql: string): SqlOperation {
  const normalized = stripSqlComments(sql).replace(/^\(+/, "").trim();
  const leadingKeyword = readKeyword(normalized, 0);
  if (!leadingKeyword) {
    return "UNKNOWN";
  }

  if (leadingKeyword.keyword === "WITH") {
    return inferOperationAfterWith(normalized, leadingKeyword.nextIndex);
  }

  return normalizeOperationKeyword(leadingKeyword.keyword);
}

/**
 * Report whether an operation should be treated as mutating.
 */
export function isMutationOperation(operation: SqlOperation): boolean {
  return MUTATION_OPERATIONS.has(operation);
}

/**
 * Report whether an operation is considered read-only.
 */
export function isReadOnlyOperation(operation: SqlOperation): boolean {
  return READ_ONLY_OPERATIONS.has(operation);
}

/**
 * Group SQL operations into higher-level execution paths used by approval and runtime orchestration.
 */
export function categorizeSqlOperation(operation: SqlOperation): SqlExecutionCategory {
  if (isReadOnlyOperation(operation)) {
    return "read_only";
  }

  if (DML_OPERATIONS.has(operation)) {
    return "dml";
  }

  if (DDL_OPERATIONS.has(operation)) {
    return "ddl";
  }

  return "unknown";
}

/**
 * Produce warnings and a mutation flag for one SQL statement.
 */
export function assessSqlSafety(sql: string): SqlSafetyAssessment {
  const statements = splitSqlStatements(sql);
  const operation = inferSqlOperation(statements[0] ?? sql);
  const executionCategory = categorizeSqlOperation(operation);
  const warnings: string[] = [];

  // Multi-statement detection is treated as a warning here so callers can decide whether to reject outright.
  if (statements.length > 1) {
    warnings.push("Multiple SQL statements were detected. Only a single statement is allowed.");
  }

  if ((operation === "UPDATE" || operation === "DELETE") && !/\bwhere\b/i.test(sql)) {
    warnings.push(`${operation} does not include a WHERE clause. This may affect the entire table.`);
  }

  if (/\bselect\s+\*/i.test(sql)) {
    warnings.push("SELECT * was detected. This may increase unnecessary IO and network cost.");
  }

  if (/\border\s+by\b/i.test(sql) && !/\blimit\b/i.test(sql) && operation === "SELECT") {
    warnings.push("ORDER BY without LIMIT was detected. This may trigger a large sort.");
  }

  return {
    operation,
    executionCategory,
    isMutation: isMutationOperation(operation),
    warnings,
  };
}

/**
 * Reject any SQL input that contains zero or multiple statements.
 */
export function ensureSingleStatement(sql: string): void {
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1) {
    // Fail hard at execution boundaries so callers never accidentally run batches.
    throw new Error("Only a single SQL statement can be executed in the current version.");
  }
}
