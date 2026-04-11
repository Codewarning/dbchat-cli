import { Box, Text, useFocus, useFocusManager, useInput } from "ink";
import { useEffect, type ReactNode } from "react";
import type { SlashCommandCompletion } from "./slash-commands.js";
import type { DatabaseSuggestion } from "./chat-ui-types.js";

const SLASH_SUGGESTION_USAGE_WIDTH = 58;
const DATABASE_SUGGESTION_NAME_WIDTH = 34;

/**
 * A lightweight Ink text input for chat and prompt flows.
 */
export function InlineTextInput({
  label,
  value,
  placeholder,
  active,
  secret = false,
  beforeInput,
  afterInput,
  onChange,
  onSubmit,
  onCancel,
}: {
  label: string;
  value: string;
  placeholder: string;
  active: boolean;
  secret?: boolean;
  beforeInput?: ReactNode;
  afterInput?: ReactNode;
  onChange(value: string): void;
  onSubmit(): void;
  onCancel?: () => void;
}) {
  useInput((input, key) => {
    if (!active) {
      return;
    }

    if (key.ctrl && input === "c") {
      onCancel?.();
      return;
    }

    if (key.return) {
      onSubmit();
      return;
    }

    if (key.escape) {
      onChange("");
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    if (input) {
      onChange(`${value}${input}`);
    }
  });

  const displayValue = secret ? "*".repeat(value.length) : value;
  const borderColor = active ? "cyan" : "gray";
  const hasLabel = Boolean(label);
  const displayDimmed = !value;

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} width="100%" flexDirection="column">
      {beforeInput ? (
        <Box width="100%" flexDirection="column">
          {beforeInput}
        </Box>
      ) : null}

      <Box width="100%">
        {hasLabel ? (
          <Box flexShrink={0} marginRight={1}>
            <Text color="cyan" wrap="truncate-end">
              {label}
            </Text>
          </Box>
        ) : null}
        <Box flexGrow={1} flexShrink={1} overflowX="hidden">
          <Text dimColor={displayDimmed} wrap="truncate-end">
            {displayValue || placeholder}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color="cyan">{active ? "_" : " "}</Text>
        </Box>
      </Box>

      {afterInput ? (
        <Box width="100%" flexDirection="column">
          {afterInput}
        </Box>
      ) : null}
    </Box>
  );
}

function SlashSuggestionList({
  suggestions,
  selectedIndex,
}: {
  suggestions: SlashCommandCompletion[];
  selectedIndex: number;
}) {
  const maxVisible = 8;
  const windowStart = Math.max(0, Math.min(selectedIndex - 2, suggestions.length - maxVisible));
  const visibleSuggestions = suggestions.slice(windowStart, windowStart + maxVisible);

  return (
    <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Text dimColor>Slash commands</Text>
      {visibleSuggestions.map((suggestion, index) => {
        const absoluteIndex = windowStart + index;
        const selected = absoluteIndex === selectedIndex;

        return (
          <Box key={suggestion.usage}>
            <Box width={SLASH_SUGGESTION_USAGE_WIDTH} flexShrink={0}>
              <Text color={selected ? "cyan" : undefined}>{selected ? `> ${suggestion.usage}` : `  ${suggestion.usage}`}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor={!selected}>{suggestion.description}</Text>
            </Box>
          </Box>
        );
      })}
      {suggestions.length > maxVisible ? <Text dimColor>{`Showing ${visibleSuggestions.length} of ${suggestions.length} matches`}</Text> : null}
    </Box>
  );
}

/**
 * Extract the active `@database` picker query from the composer input.
 */
export function getDatabasePickerQuery(input: string): string | null {
  if (!input.startsWith("@")) {
    return null;
  }

  const query = input.slice(1);
  return /\s/.test(query) ? null : query;
}

/**
 * Filter the available database suggestions for one `@` query.
 */
export function filterDatabaseSuggestions(suggestions: DatabaseSuggestion[], query: string): DatabaseSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return suggestions;
  }

  return suggestions.filter((suggestion) => {
    const databaseName = suggestion.databaseName.toLowerCase();
    const schemaName = suggestion.schema?.toLowerCase() ?? "";
    return databaseName.includes(normalizedQuery) || schemaName.includes(normalizedQuery);
  });
}

function DatabaseSuggestionList({
  hostName,
  query,
  error,
  suggestions,
  selectedIndex,
}: {
  hostName: string | null;
  query: string;
  error: string | null;
  suggestions: DatabaseSuggestion[];
  selectedIndex: number;
}) {
  const maxVisible = 5;
  const windowStart = Math.max(0, Math.min(selectedIndex - 2, suggestions.length - maxVisible));
  const visibleSuggestions = suggestions.slice(windowStart, windowStart + maxVisible);

  return (
    <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Text dimColor>{hostName ? `Databases on ${hostName}` : "Database switcher"}</Text>
      {!hostName ? (
        <Text dimColor>No active database connection is configured.</Text>
      ) : error ? (
        <Text color="red">{error}</Text>
      ) : !suggestions.length ? (
        <Text dimColor>{query ? `No databases match "${query}".` : "No visible databases were returned by the current host."}</Text>
      ) : (
        <>
          {visibleSuggestions.map((suggestion, index) => {
            const absoluteIndex = windowStart + index;
            const selected = absoluteIndex === selectedIndex;
            const detailParts = [suggestion.schema ? `schema=${suggestion.schema}` : null, suggestion.isActive ? "current" : null].filter(Boolean);

            return (
              <Box key={`${suggestion.hostName}:${suggestion.databaseName}:${suggestion.schema ?? "default"}`}>
                <Box width={DATABASE_SUGGESTION_NAME_WIDTH} flexShrink={0}>
                  <Text color={selected ? "cyan" : undefined}>{selected ? `> ${suggestion.databaseName}` : `  ${suggestion.databaseName}`}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text dimColor={!selected}>{detailParts.join("  ") || " "}</Text>
                </Box>
              </Box>
            );
          })}
          {suggestions.length > maxVisible ? <Text dimColor>{`Showing ${visibleSuggestions.length} of ${suggestions.length} matches`}</Text> : null}
        </>
      )}
    </Box>
  );
}

export function ComposerInput({
  value,
  placeholder,
  active,
  focusId,
  databasePickerMode,
  databaseSuggestionHostName,
  databaseSuggestionError,
  databaseSuggestions,
  selectedDatabaseSuggestionIndex,
  slashSuggestions,
  selectedSlashSuggestionIndex,
  onChange,
  onDatabaseSuggestionChange,
  onAcceptDatabaseSuggestion,
  onSlashSuggestionChange,
  onAcceptSlashSuggestion,
  historyBrowsingActive,
  onHistoryPrevious,
  onHistoryNext,
  onSubmit,
  onCancel,
}: {
  value: string;
  placeholder: string;
  active: boolean;
  focusId: string;
  databasePickerMode: boolean;
  databaseSuggestionHostName: string | null;
  databaseSuggestionError: string | null;
  databaseSuggestions: DatabaseSuggestion[];
  selectedDatabaseSuggestionIndex: number;
  slashSuggestions: SlashCommandCompletion[];
  selectedSlashSuggestionIndex: number;
  onChange(value: string): void;
  onDatabaseSuggestionChange(index: number): void;
  onAcceptDatabaseSuggestion(suggestion: DatabaseSuggestion): void;
  onSlashSuggestionChange(index: number): void;
  onAcceptSlashSuggestion(suggestion: SlashCommandCompletion): void;
  historyBrowsingActive: boolean;
  onHistoryPrevious(): void;
  onHistoryNext(): void;
  onSubmit(): void;
  onCancel?: () => void;
}) {
  const { focus } = useFocusManager();
  const { isFocused } = useFocus({ id: focusId, isActive: active, autoFocus: true });
  const acceptingInput = active && isFocused;
  const selectedDatabaseSuggestion = databaseSuggestions[selectedDatabaseSuggestionIndex] ?? null;
  const hasDatabaseSuggestions = acceptingInput && databasePickerMode && databaseSuggestions.length > 0;
  const selectedSuggestion = slashSuggestions[selectedSlashSuggestionIndex] ?? null;
  const hasSlashSuggestions = acceptingInput && !databasePickerMode && slashSuggestions.length > 0;

  useEffect(() => {
    if (active) {
      focus(focusId);
    }
  }, [active, focus, focusId]);

  useInput((input, key) => {
    if (!acceptingInput) {
      return;
    }

    if (databasePickerMode && key.upArrow && databaseSuggestions.length > 0) {
      onDatabaseSuggestionChange(selectedDatabaseSuggestionIndex === 0 ? databaseSuggestions.length - 1 : selectedDatabaseSuggestionIndex - 1);
      return;
    }

    if (databasePickerMode && key.downArrow && databaseSuggestions.length > 0) {
      onDatabaseSuggestionChange(selectedDatabaseSuggestionIndex === databaseSuggestions.length - 1 ? 0 : selectedDatabaseSuggestionIndex + 1);
      return;
    }

    if (hasDatabaseSuggestions && (key.tab || key.return) && selectedDatabaseSuggestion) {
      onAcceptDatabaseSuggestion(selectedDatabaseSuggestion);
      return;
    }

    if (hasSlashSuggestions && key.upArrow) {
      onSlashSuggestionChange(selectedSlashSuggestionIndex === 0 ? slashSuggestions.length - 1 : selectedSlashSuggestionIndex - 1);
      return;
    }

    if (hasSlashSuggestions && key.downArrow) {
      onSlashSuggestionChange(selectedSlashSuggestionIndex === slashSuggestions.length - 1 ? 0 : selectedSlashSuggestionIndex + 1);
      return;
    }

    if (hasSlashSuggestions && key.tab && selectedSuggestion) {
      onAcceptSlashSuggestion(selectedSuggestion);
      return;
    }

    if (!databasePickerMode && !hasSlashSuggestions && key.upArrow && (!value || historyBrowsingActive)) {
      onHistoryPrevious();
      return;
    }

    if (!databasePickerMode && !hasSlashSuggestions && key.downArrow && historyBrowsingActive) {
      onHistoryNext();
      return;
    }

    if (key.ctrl && input === "c") {
      onCancel?.();
      return;
    }

    if (key.return) {
      if (selectedSuggestion && selectedSuggestion.insertText !== value) {
        onAcceptSlashSuggestion(selectedSuggestion);
        return;
      }

      onSubmit();
      return;
    }

    if (key.escape) {
      onChange("");
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    if (input) {
      onChange(`${value}${input}`);
    }
  });

  const promptColor = acceptingInput ? "cyan" : "gray";

  return (
    <Box width="100%" flexDirection="column">
      <Box width="100%">
        <Box flexShrink={0} marginRight={1}>
          <Text color={promptColor}>{">"}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflowX="hidden">
          <Box>
            {value ? (
              <>
                <Text>{value}</Text>
                {acceptingInput ? <Text color="cyan">|</Text> : null}
              </>
            ) : (
              <>
                {acceptingInput ? <Text color="cyan">|</Text> : null}
                <Text dimColor wrap="truncate-end">
                  {placeholder}
                </Text>
              </>
            )}
          </Box>
        </Box>
      </Box>
      {databasePickerMode ? (
        <DatabaseSuggestionList
          hostName={databaseSuggestionHostName}
          query={value.slice(1)}
          error={databaseSuggestionError}
          suggestions={databaseSuggestions}
          selectedIndex={selectedDatabaseSuggestionIndex}
        />
      ) : null}
      {hasSlashSuggestions ? <SlashSuggestionList suggestions={slashSuggestions} selectedIndex={selectedSlashSuggestionIndex} /> : null}
    </Box>
  );
}
