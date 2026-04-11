import type { TableColumn, TableDdlSource, TableSchema } from "../types/index.js";
import { buildCreateTableDdl } from "../schema/table-ddl.js";

export interface TableConstraintDefinition {
  constraintName: string;
  constraintType: "PRIMARY KEY" | "UNIQUE";
  columns: string[];
}

function compareConstraintPriority(left: TableConstraintDefinition, right: TableConstraintDefinition): number {
  const leftPriority = left.constraintType === "PRIMARY KEY" ? 0 : 1;
  const rightPriority = right.constraintType === "PRIMARY KEY" ? 0 : 1;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return left.constraintName.localeCompare(right.constraintName);
}

export function buildConstraintDdlLines(constraints: TableConstraintDefinition[]): string[] {
  return [...constraints]
    .sort(compareConstraintPriority)
    .map((constraint) => `${constraint.constraintType} (${constraint.columns.join(", ")})`);
}

export function buildTableSchema(
  tableName: string,
  columns: TableColumn[],
  constraints: TableConstraintDefinition[] = [],
  ddlPreview = buildCreateTableDdl(tableName, columns, buildConstraintDdlLines(constraints)),
  ddlSource: TableDdlSource = "reconstructed",
): TableSchema {
  return {
    tableName,
    columns,
    ddlPreview,
    ddlSource,
  };
}
