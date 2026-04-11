import type { ToolSpec } from "../specs.js";
import { exportLastResultTool } from "./export.js";
import { updatePlanTool } from "./plan.js";
import { describeTableTool, getSchemaSummaryTool, listLiveTablesTool, searchSchemaCatalogTool } from "./schema.js";
import { explainSqlTool, runSqlTool } from "./sql.js";

export const BUILTIN_TOOL_SPECS: ToolSpec[] = [
  updatePlanTool,
  getSchemaSummaryTool,
  listLiveTablesTool,
  searchSchemaCatalogTool,
  describeTableTool,
  runSqlTool,
  explainSqlTool,
  exportLastResultTool,
];
