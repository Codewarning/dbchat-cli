// Shared plan formatters used by both the terminal UI and prompt construction.
import type { PlanItem, PlanStatus } from "../types/index.js";

const TERMINAL_PLAN_STATUSES = new Set<PlanStatus>(["completed", "skipped", "cancelled"]);

/**
 * Map one plan status to a compact terminal-friendly icon.
 */
export function getPlanStatusIcon(status: PlanStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[-]";
    case "skipped":
      return "[/]";
    case "cancelled":
      return "[!]";
    case "pending":
    default:
      return "[ ]";
  }
}

/**
 * Render the current plan into a stable text format for both the CLI and the model.
 */
export function formatPlan(plan: PlanItem[]): string {
  if (!plan.length) {
    // Keep the empty-plan case explicit so the CLI and model see the same sentinel text.
    return "No active plan.";
  }

  return plan
    .map((item) => `${item.status.toUpperCase()} | ${item.id} | ${item.content}`)
    .join("\n");
}

/**
 * Render the current plan in a more readable terminal format for human-facing output.
 */
export function formatPlanForDisplay(plan: PlanItem[]): string {
  if (!plan.length) {
    return "No active plan.";
  }

  return plan
    .map((item) => `${getPlanStatusIcon(item.status)} ${item.content} [${item.id}]`)
    .join("\n");
}

/**
 * Decide whether one plan has fully reached terminal state and can be removed from active turn state.
 */
export function isPlanResolved(plan: PlanItem[]): boolean {
  return plan.length > 0 && plan.every((item) => TERMINAL_PLAN_STATUSES.has(item.status));
}
