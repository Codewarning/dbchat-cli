import type { ToolSpec } from "../specs.js";
import { exportLastResultTool } from "./export.js";
import { inspectHistoryEntryTool } from "./history.js";
import { updatePlanTool } from "./plan.js";
import { inspectLastExplainTool, inspectLastResultTool, renderLastResultTool, searchLastResultTool } from "./result.js";
import { describeTableTool, getSchemaSummaryTool, listLiveTablesTool, searchSchemaCatalogTool } from "./schema.js";
import { explainSqlTool, runSqlTool } from "./sql.js";

export const BUILTIN_TOOL_SPECS: ToolSpec[] = [
  updatePlanTool,
  inspectHistoryEntryTool,
  getSchemaSummaryTool,
  listLiveTablesTool,
  searchSchemaCatalogTool,
  describeTableTool,
  runSqlTool,
  inspectLastResultTool,
  searchLastResultTool,
  renderLastResultTool,
  explainSqlTool,
  inspectLastExplainTool,
  exportLastResultTool,
];
