import { createRequire } from "node:module";
import { Box, Text } from "ink";
import { getPlanStatusIcon } from "../agent/plan.js";
import type { PlanItem } from "../types/index.js";
import type { ChatEntry, EntryTone, LoadingTask } from "./chat-ui-types.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version?: string };

const CHAT_PRODUCT_NAME = "DB Chat CLI";
const CHAT_PRODUCT_VERSION = typeof packageMetadata.version === "string" ? `v${packageMetadata.version}` : null;
const METADATA_LABEL_WIDTH = 11;
const LOG_ENTRY_MARGIN_BOTTOM = 0;
const MESSAGE_ENTRY_MARGIN_BOTTOM = 1;

/**
 * Generate a stable unique UI id for Ink list keys and async state handles.
 */
export function createUiId(prefix: string, sequence: number): string {
  return `${prefix}-${Date.now()}-${sequence}`;
}

/**
 * Build the initial welcome splash as a chat-history entry so later turns append below it.
 */
export function createWelcomeEntry(model: string, database: string, permission: string): ChatEntry {
  return {
    id: createUiId("welcome", 0),
    body: "",
    tone: "welcome",
    meta: {
      model,
      database,
      permission,
    },
  };
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let normalized = value / 1024;
  let unitIndex = 0;
  while (normalized >= 1024 && unitIndex < units.length - 1) {
    normalized /= 1024;
    unitIndex += 1;
  }

  return `${normalized.toFixed(normalized >= 100 ? 0 : normalized >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatLoadingTaskElapsed(startedAt: number): string {
  return `${Math.max(1, Math.ceil((Date.now() - startedAt) / 1000))}s`;
}

export function formatLoadingTaskLabel(task: LoadingTask): string {
  if (task.unit === "bytes" && typeof task.completed === "number") {
    const sizeText =
      typeof task.total === "number" && task.total > 0
        ? `${formatBytes(task.completed)} / ${formatBytes(task.total)}`
        : `${formatBytes(task.completed)} downloaded`;
    const percentText =
      typeof task.total === "number" && task.total > 0
        ? ` (${Math.min(100, Math.round((task.completed / task.total) * 100))}%)`
        : "";
    return `${task.message} ${sizeText}${percentText} ${formatLoadingTaskElapsed(task.startedAt)}`;
  }

  return `${task.message} ${formatLoadingTaskElapsed(task.startedAt)}`;
}

function getToneColor(tone: EntryTone): string | undefined {
  switch (tone) {
    case "muted":
      return "gray";
    case "info":
      return "cyan";
    case "success":
      return "green";
    case "warning":
      return "yellow";
    case "error":
      return "red";
    case "accent":
      return "magenta";
    case "user":
      return "blue";
    case "assistant":
      return "green";
    default:
      return undefined;
  }
}

/**
 * Infer a UI tone for log-like lines based on message content.
 */
export function inferLineTone(message: string): EntryTone {
  if (/(failed|error|rejected|cancelled)/i.test(message)) {
    return "error";
  }

  if (/(warning|warnings)/i.test(message)) {
    return "warning";
  }

  if (/(done|ready|completed|saved|loaded|granted)/i.test(message)) {
    return "success";
  }

  if (/(tool call|running|loading|fetching|executing|exporting|closing|creating|waiting|refreshing)/i.test(message)) {
    return "info";
  }

  return "normal";
}

/**
 * Infer a UI tone for titled blocks.
 */
export function inferBlockTone(title: string): EntryTone {
  if (/final answer/i.test(title)) {
    return "assistant";
  }

  if (/(warning|warnings)/i.test(title)) {
    return "warning";
  }

  if (/(failed|error)/i.test(title)) {
    return "error";
  }

  if (/(plan|sql|schema|available commands|stored database configs)/i.test(title)) {
    return "accent";
  }

  return "info";
}

/**
 * Limit special plan rendering to plan-focused blocks so normal content keeps the generic layout.
 */
export function isPlanBlockTitle(title: string | undefined): boolean {
  if (!title) {
    return false;
  }

  return /^(current plan|plan updated)$/i.test(title);
}

function getPlanStatusColor(status: PlanItem["status"]): string {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "yellow";
    case "cancelled":
      return "red";
    case "skipped":
      return "gray";
    case "pending":
    default:
      return "gray";
  }
}

function shouldShowPlanStepId(item: PlanItem): boolean {
  const normalizedId = item.id.trim().toLowerCase();
  const normalizedContent = item.content.trim().toLowerCase();
  return Boolean(normalizedId) && normalizedId !== normalizedContent;
}

export function formatPlanProgressSummary(items: PlanItem[]): string {
  const completedCount = items.filter((item) => item.status === "completed").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  const cancelledCount = items.filter((item) => item.status === "cancelled").length;
  const activeCount = items.filter((item) => item.status === "in_progress").length;
  const resolvedCount = completedCount + skippedCount + cancelledCount;

  if (!activeCount) {
    if (skippedCount || cancelledCount) {
      return `${resolvedCount}/${items.length} resolved`;
    }

    return `${completedCount}/${items.length} completed`;
  }

  return `${resolvedCount}/${items.length} resolved, ${activeCount} active`;
}

export function PlanList({ items }: { items: PlanItem[] }) {
  return (
    <Box width="100%" flexDirection="column">
      {items.map((item) => {
        const completed = item.status === "completed";
        const skipped = item.status === "skipped";
        const cancelled = item.status === "cancelled";
        const pending = item.status === "pending";
        const active = item.status === "in_progress";
        const resolved = completed || skipped || cancelled;
        const color = getPlanStatusColor(item.status);

        return (
          <Box key={`${item.id}:${item.content}`} width="100%">
            <Box width={4} flexShrink={0}>
              <Text color={color}>{getPlanStatusIcon(item.status)}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={active ? "yellow" : cancelled ? "red" : completed ? "gray" : undefined} dimColor={pending || completed || skipped} bold={active} strikethrough={resolved}>
                {item.content}
              </Text>
              {shouldShowPlanStepId(item) ? <Text dimColor>{`  [${item.id}]`}</Text> : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function MetadataRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <Box width="100%" alignItems="flex-start">
      <Box width={METADATA_LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={valueColor}>{` ${value}`}</Text>
      </Box>
    </Box>
  );
}

function WelcomeHeader({ model, database, permission }: { model: string; database: string; permission: string }) {
  return (
    <Box width="100%" flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {">_"}
        </Text>
        <Text bold>{` ${CHAT_PRODUCT_NAME}`}</Text>
        {CHAT_PRODUCT_VERSION ? <Text color="gray">{` (${CHAT_PRODUCT_VERSION})`}</Text> : null}
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} width="100%" flexDirection="column">
        <MetadataRow label="model:" value={model} valueColor="green" />
        <MetadataRow label="database:" value={database} valueColor="cyan" />
        <MetadataRow label="permission:" value={permission} valueColor="yellow" />
      </Box>
    </Box>
  );
}

/**
 * Render one historical chat entry.
 */
export function ChatEntryView({ entry }: { entry: ChatEntry }) {
  const color = getToneColor(entry.tone);
  const lines = entry.body.split("\n");
  const plan = entry.meta?.plan;

  if (entry.tone === "welcome") {
    return <WelcomeHeader model={entry.meta?.model ?? ""} database={entry.meta?.database ?? ""} permission={entry.meta?.permission ?? ""} />;
  }

  if (entry.tone === "user") {
    return (
      <Box width="100%" flexDirection="column" marginBottom={MESSAGE_ENTRY_MARGIN_BOTTOM}>
        {lines.map((line, index) => (
          <Text key={`${entry.id}-${index}`} color="cyan">
            {index === 0 ? `> ${line || " "}` : `  ${line || " "}`}
          </Text>
        ))}
      </Box>
    );
  }

  if (entry.tone === "assistant") {
    return (
      <Box width="100%" flexDirection="column" marginBottom={MESSAGE_ENTRY_MARGIN_BOTTOM}>
        {lines.map((line, index) => (
          <Text key={`${entry.id}-${index}`}>{line || " "}</Text>
        ))}
      </Box>
    );
  }

  if (entry.title && plan?.length) {
    return (
      <Box width="100%" flexDirection="column" marginBottom={LOG_ENTRY_MARGIN_BOTTOM}>
        <Text color={color} bold>
          {`${entry.title} (${formatPlanProgressSummary(plan)})`}
        </Text>
        <Box paddingLeft={1}>
          <PlanList items={plan} />
        </Box>
      </Box>
    );
  }

  if (!entry.title) {
    const prefix =
      entry.tone === "error"
        ? "error"
        : entry.tone === "warning"
          ? "warning"
          : entry.tone === "success"
            ? "done"
            : entry.tone === "info"
              ? "info"
              : "log";

    return (
      <Box width="100%" flexDirection="column" marginBottom={LOG_ENTRY_MARGIN_BOTTOM}>
        {lines.map((line, index) => (
          <Text key={`${entry.id}-${index}`} color={color} dimColor={entry.tone === "muted"}>
            {index === 0 ? `${prefix} ${line || " "}` : `  ${line || " "}`}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box width="100%" flexDirection="column" marginBottom={LOG_ENTRY_MARGIN_BOTTOM}>
      {entry.title ? (
        <Text color={color} bold>
          {entry.title}
        </Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={`${entry.id}-${index}`} color={entry.title ? "gray" : color} dimColor={entry.tone === "muted"}>
          {`  ${line || " "}`}
        </Text>
      ))}
    </Box>
  );
}
