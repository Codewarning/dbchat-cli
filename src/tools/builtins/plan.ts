import { z } from "zod";
import { formatPlanForDisplay } from "../../agent/plan.js";
import type { PlanItem } from "../../types/index.js";
import { clipText, stringifyCompact, summarizePlanItems } from "../serialize-helpers.js";
import { defineTool } from "../specs.js";

const updatePlanSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      content: z.string().min(1),
      status: z.enum(["pending", "in_progress", "completed", "skipped", "cancelled"]),
    }),
  ),
});

export const updatePlanTool = defineTool(
  {
    name: "update_plan",
    description: "Create, update, or clear the active execution plan for a complex task. Pass an empty items array to clear the plan.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "skipped", "cancelled"],
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
  updatePlanSchema,
  async (args, context) => {
    context.setPlan(args.items);
    context.io.logBlock("Plan updated", formatPlanForDisplay(args.items));
    return { ok: true, plan: args.items };
  },
  (result) => {
    const plan = Array.isArray((result as { plan?: unknown })?.plan) ? ((result as { plan: PlanItem[] }).plan ?? []) : [];
    const payload = {
      ok: true,
      plan: plan.map((item) => ({
        id: item.id,
        content: clipText(item.content, 120),
        status: item.status,
      })),
    };
    return {
      content: stringifyCompact(payload),
      summary: `Plan updated: ${summarizePlanItems(payload.plan)}`,
    };
  },
);
