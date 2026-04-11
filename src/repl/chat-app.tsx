import { Box, Static, Text } from "ink";
import type { AgentIO } from "../types/index.js";
import { ChatEntryView, formatLoadingTaskLabel, formatPlanProgressSummary, PlanList } from "./chat-entry-view.js";
import { ComposerInput } from "./chat-composer.js";
import { CHAT_COMPOSER_FOCUS_ID, CHAT_SPINNER_FRAMES, useChatController } from "./chat-controller.js";
import { PromptModal } from "./chat-prompts.js";
import type { ChatRuntimeState } from "./runtime.js";

interface ChatAppProps {
  state: ChatRuntimeState;
  io: AgentIO;
  clearScreen(): void;
}

/**
 * Build the Ink-based interactive chat experience.
 */
export function ChatApp({ state, io, clearScreen }: ChatAppProps) {
  const controller = useChatController({ state, io, clearScreen });

  return (
    <Box flexDirection="column" width="100%">
      {controller.planItems.length ? (
        <Box width="100%" flexDirection="column" marginBottom={1}>
          <Text color="magenta" bold>
            {`Current plan (${formatPlanProgressSummary(controller.planItems)})`}
          </Text>
          <Box paddingLeft={1}>
            <PlanList items={controller.planItems} />
          </Box>
        </Box>
      ) : null}

      <Static items={controller.entries}>{(entry) => <ChatEntryView key={entry.id} entry={entry} />}</Static>

      {controller.loadingTasks.length ? (
        <Box width="100%" flexDirection="column" marginBottom={1}>
          <Text color="yellow" bold>
            Active tasks
          </Text>
          {controller.loadingTasks.map((task) => (
            <Text key={task.id} color="yellow">
              {`  ${CHAT_SPINNER_FRAMES[controller.spinnerFrame]} ${formatLoadingTaskLabel(task)}`}
            </Text>
          ))}
        </Box>
      ) : null}

      <PromptModal
        key={controller.pendingPrompt?.id ?? "none"}
        prompt={controller.pendingPrompt}
        onResolve={(value) => {
          controller.resolvePendingPrompt(value as string | boolean);
        }}
        onReject={(error) => {
          controller.rejectPendingPrompt(error);
        }}
      />

      <Box marginTop={1}>
        <ComposerInput
          value={controller.composerValue}
          placeholder={controller.composerPlaceholder}
          active={controller.composerActive}
          focusId={CHAT_COMPOSER_FOCUS_ID}
          databasePickerMode={controller.databasePickerMode}
          databaseSuggestionHostName={controller.databaseSuggestionHostName}
          databaseSuggestionError={controller.databaseSuggestionError}
          databaseSuggestions={controller.filteredDatabaseSuggestions}
          selectedDatabaseSuggestionIndex={controller.selectedDatabaseSuggestionIndex}
          slashSuggestions={controller.slashSuggestions}
          selectedSlashSuggestionIndex={controller.selectedSlashSuggestionIndex}
          onChange={controller.handleComposerChange}
          onDatabaseSuggestionChange={controller.setSelectedDatabaseSuggestionIndex}
          onAcceptDatabaseSuggestion={controller.acceptDatabaseSuggestion}
          onSlashSuggestionChange={controller.setSelectedSlashSuggestionIndex}
          onAcceptSlashSuggestion={controller.acceptSlashSuggestion}
          historyBrowsingActive={controller.historyBrowsingActive}
          onHistoryPrevious={controller.showPreviousComposerHistoryEntry}
          onHistoryNext={controller.showNextComposerHistoryEntry}
          onSubmit={() => {
            void controller.submitComposer();
          }}
          onCancel={controller.closeAndExit}
        />
      </Box>
    </Box>
  );
}
