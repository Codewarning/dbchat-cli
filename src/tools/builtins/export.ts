import { z } from "zod";
import { exportQueryResult } from "../../export/csv.js";
import type { ExportResult } from "../../types/index.js";
import { stringifyCompact } from "../serialize-helpers.js";
import { defineTool } from "../specs.js";

const exportSchema = z.object({
  format: z.enum(["json", "csv"]),
  outputPath: z.string().min(1),
});

export const exportLastResultTool = defineTool(
  {
    name: "export_last_result",
    description: "Export the most recent query result to a file.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: {
          type: "string",
          enum: ["json", "csv"],
        },
        outputPath: {
          type: "string",
          description: "The output path. Relative paths are resolved inside the current working directory.",
        },
      },
      required: ["format", "outputPath"],
    },
  },
  exportSchema,
  async (args, context) => {
    const lastResult = context.getLastResult();
    if (!lastResult) {
      throw new Error("There is no query result available to export.");
    }

    context.io.log(`Exporting last result as ${args.format}`);
    const exported = await context.io.withLoading(`Writing ${args.format.toUpperCase()} export`, () =>
      exportQueryResult(lastResult, args.format, args.outputPath, context.io.cwd),
    );
    context.io.log(`Export completed: ${exported.outputPath}`);
    return exported satisfies ExportResult;
  },
  (result) => {
    const exported = result as ExportResult;
    const payload = {
      format: exported.format,
      outputPath: exported.outputPath,
      rowCount: exported.rowCount,
      truncated: exported.truncated,
    };

    return {
      content: stringifyCompact(payload),
      summary: `Export completed: ${exported.format.toUpperCase()} to ${exported.outputPath}.${exported.truncated ? " The export contains cached rows only." : ""}`,
    };
  },
);
