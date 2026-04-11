import { useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { AgentSession } from "../agent/session.js";
import { orderDatabaseNamesForSelection, promptDatabaseOperationAccess } from "../commands/database-config-helpers.js";
import { findDatabaseEntry, findDatabaseHostByConnection } from "../config/database-hosts.js";
import { loadNormalizedStoredConfig } from "../config/store.js";
import type { AgentIO, DatabaseOperationAccess, PlanItem } from "../types/index.js";
import type { PromptRuntime, SelectChoice } from "../ui/prompts.js";
import { selectNextComposerHistoryEntry, selectPreviousComposerHistoryEntry } from "./input-history.js";
import {
  createUiId,
  createWelcomeEntry,
  inferBlockTone,
  inferLineTone,
  isPlanBlockTitle,
} from "./chat-entry-view.js";
import { filterDatabaseSuggestions, getDatabasePickerQuery } from "./chat-composer.js";
import type { ChatRuntimeState, RuntimeSwitchOutcome } from "./runtime.js";
import {
  formatDatabaseConnectionTarget,
  formatDatabasePermission,
  formatDatabaseTarget,
  switchRuntimeToDatabase,
} from "./runtime.js";
import {
  getSlashCommandCompletions,
  handleClearCommand,
  handleDatabaseCommand,
  handleHostCommand,
  handlePlanCommand,
  handleSchemaCommand,
  parseSlashCommand,
  printHelp,
  type SlashCommandCompletion,
  type SlashCommandPresenter,
} from "./slash-commands.js";
import type { ChatEntry, DatabaseSuggestion, LoadingTask, PromptRequest } from "./chat-ui-types.js";

export const CHAT_SPINNER_FRAMES = ["-", "\\", "|", "/"];
export const CHAT_COMPOSER_FOCUS_ID = "chat-composer";

const MAX_TIMELINE_ENTRIES = 240;

interface UseChatControllerArgs {
  state: ChatRuntimeState;
  io: AgentIO;
  clearScreen(): void;
}

export interface ChatController {
  entries: ChatEntry[];
  loadingTasks: LoadingTask[];
  spinnerFrame: number;
  planItems: PlanItem[];
  pendingPrompt: PromptRequest | null;
  composerValue: string;
  composerPlaceholder: string;
  composerActive: boolean;
  databasePickerMode: boolean;
  databaseSuggestionHostName: string | null;
  databaseSuggestionError: string | null;
  filteredDatabaseSuggestions: DatabaseSuggestion[];
  selectedDatabaseSuggestionIndex: number;
  slashSuggestions: SlashCommandCompletion[];
  selectedSlashSuggestionIndex: number;
  historyBrowsingActive: boolean;
  setSelectedDatabaseSuggestionIndex(index: number): void;
  setSelectedSlashSuggestionIndex(index: number): void;
  handleComposerChange(nextValue: string): void;
  acceptSlashSuggestion(suggestion: SlashCommandCompletion): void;
  acceptDatabaseSuggestion(suggestion: DatabaseSuggestion): void;
  showPreviousComposerHistoryEntry(): void;
  showNextComposerHistoryEntry(): void;
  resolvePendingPrompt(value: string | boolean): void;
  rejectPendingPrompt(error: Error): void;
  submitComposer(): Promise<void>;
  closeAndExit(): void;
}

function buildWelcomeEntries(state: ChatRuntimeState, fallbackModel: string): ChatEntry[] {
  return [
    createWelcomeEntry(
      state.config?.llm.model ?? fallbackModel,
      formatDatabaseConnectionTarget(state.config?.database),
      formatDatabasePermission(state.config?.database),
    ),
  ];
}

/**
 * Drive the non-visual chat REPL state so ChatApp can stay focused on rendering.
 */
export function useChatController({ state, io, clearScreen }: UseChatControllerArgs): ChatController {
  const { exit } = useApp();
  if (!state.config || !state.db) {
    throw new Error("No active database is configured. Add or switch to a database first.");
  }

  const initialConfig = state.config;
  const initialDb = state.db;

  const [entries, setEntries] = useState<ChatEntry[]>(() => buildWelcomeEntries(state, initialConfig.llm.model));
  const [composerValue, setComposerValue] = useState("");
  const [databaseSuggestionHostName, setDatabaseSuggestionHostName] = useState<string | null>(null);
  const [databaseSuggestionError, setDatabaseSuggestionError] = useState<string | null>(null);
  const [databaseSuggestions, setDatabaseSuggestions] = useState<DatabaseSuggestion[]>([]);
  const [selectedDatabaseSuggestionIndex, setSelectedDatabaseSuggestionIndex] = useState(0);
  const [selectedSlashSuggestionIndex, setSelectedSlashSuggestionIndex] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<PromptRequest | null>(null);
  const [loadingTasks, setLoadingTasks] = useState<LoadingTask[]>([]);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activeDatabaseLabel, setActiveDatabaseLabel] = useState(formatDatabaseTarget(initialConfig.database));
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [composerHistory, setComposerHistory] = useState<string[]>([]);
  const [composerHistoryIndex, setComposerHistoryIndex] = useState<number | null>(null);
  const runtimeStateRef = useRef(state);
  const uiSequenceRef = useRef(0);
  const chatIoRef = useRef<AgentIO | null>(null);
  const pendingPromptRef = useRef<PromptRequest | null>(null);

  useEffect(() => {
    if (!loadingTasks.length) {
      return;
    }

    const timer = setInterval(() => {
      setSpinnerFrame((current) => (current + 1) % CHAT_SPINNER_FRAMES.length);
    }, 120);

    return () => {
      clearInterval(timer);
    };
  }, [loadingTasks.length]);

  const nextUiId = (prefix: string): string => {
    uiSequenceRef.current += 1;
    return createUiId(prefix, uiSequenceRef.current);
  };

  const appendEntry = (entry: Omit<ChatEntry, "id">) => {
    setEntries((current) => {
      const nextEntries = [...current, { id: nextUiId("entry"), ...entry }];
      if (nextEntries.length <= MAX_TIMELINE_ENTRIES) {
        return nextEntries;
      }

      const welcomeEntry = nextEntries[0];
      const recentEntries = nextEntries.slice(-(MAX_TIMELINE_ENTRIES - 1));
      return welcomeEntry ? [welcomeEntry, ...recentEntries] : recentEntries;
    });
  };

  const setCurrentPrompt = (prompt: PromptRequest | null) => {
    pendingPromptRef.current = prompt;
    setPendingPrompt(prompt);
  };

  const presenter: SlashCommandPresenter = {
    line(message) {
      appendEntry({ body: message, tone: inferLineTone(message) });
    },
    block(title, body) {
      const plan = isPlanBlockTitle(title) ? (runtimeStateRef.current.session?.getPlan() ?? []) : undefined;
      if (plan) {
        setPlanItems(plan);
      }

      appendEntry({
        title,
        body,
        tone: inferBlockTone(title),
        meta: plan ? { plan } : undefined,
      });
    },
  };

  const requestPrompt = <TValue,>(
    build: (id: string, resolve: (value: TValue) => void, reject: (error: Error) => void) => PromptRequest,
  ): Promise<TValue> =>
    new Promise<TValue>((resolve, reject) => {
      if (pendingPromptRef.current) {
        reject(new Error("Another prompt is already active."));
        return;
      }

      setCurrentPrompt(build(nextUiId("prompt"), resolve, reject));
    });

  const promptRuntime: PromptRuntime = {
    input(message, defaultValue = "") {
      return requestPrompt<string>((id, resolve, reject) => ({
        id,
        kind: "input",
        message,
        defaultValue,
        secret: false,
        resolve,
        reject,
      }));
    },
    password(message, defaultValue = "") {
      return requestPrompt<string>((id, resolve, reject) => ({
        id,
        kind: "input",
        message,
        defaultValue,
        secret: true,
        resolve,
        reject,
      }));
    },
    confirm(message, defaultValue = false) {
      return requestPrompt<boolean>((id, resolve, reject) => ({
        id,
        kind: "confirm",
        message,
        defaultValue,
        resolve,
        reject,
      }));
    },
    approveSql(message) {
      return promptRuntime.select(
        message,
        [
          { label: "Approve Once", value: "approve_once" },
          { label: "Approve All For Turn", value: "approve_all" },
          { label: "Reject", value: "reject" },
        ] as const,
        "reject",
      );
    },
    select<T extends string>(message: string, choices: SelectChoice<T>[], defaultValue?: T) {
      return requestPrompt<T>((id, resolve, reject) => ({
        id,
        kind: "select",
        message,
        defaultValue,
        choices: choices as SelectChoice<string>[],
        resolve: resolve as (value: string) => void,
        reject,
      }));
    },
    async selectOrInput(message, choices, defaultValue = "", customPromptMessage = message, customLabel = "Custom value") {
      const deduplicatedChoices = choices.filter((choice, index) => choices.findIndex((candidate) => candidate.value === choice.value) === index);

      if (defaultValue && !deduplicatedChoices.some((choice) => choice.value === defaultValue)) {
        deduplicatedChoices.unshift({
          label: defaultValue,
          value: defaultValue,
        });
      }

      const customValue = "__custom__";
      const selected = await promptRuntime.select(
        message,
        [
          ...deduplicatedChoices,
          {
            label: customLabel,
            value: customValue,
          },
        ],
        defaultValue && deduplicatedChoices.some((choice) => choice.value === defaultValue) ? defaultValue : undefined,
      );

      if (selected === customValue) {
        return promptRuntime.input(customPromptMessage, defaultValue);
      }

      return selected;
    },
  };

  const refreshDatabaseSuggestions = async () => {
    const activeConfig = runtimeStateRef.current.config?.database;
    const activeDb = runtimeStateRef.current.db;

    if (!activeConfig || !activeDb) {
      setDatabaseSuggestionHostName(null);
      setDatabaseSuggestionError(null);
      setDatabaseSuggestions([]);
      return;
    }

    setDatabaseSuggestionHostName(`${activeConfig.host}:${activeConfig.port}`);

    try {
      const storedConfig = await loadNormalizedStoredConfig();
      const storedHost = findDatabaseHostByConnection(storedConfig, activeConfig);
      const visibleDatabases = orderDatabaseNamesForSelection(await activeDb.listDatabases(), activeConfig.database);
      setDatabaseSuggestionError(null);
      setDatabaseSuggestions(
        visibleDatabases.map((databaseName) => ({
          hostName: `${activeConfig.host}:${activeConfig.port}`,
          databaseName,
          schema:
            (databaseName === activeConfig.database ? activeConfig.schema : undefined) ??
            (storedHost ? findDatabaseEntry(storedHost, databaseName)?.schema : undefined),
          isActive: databaseName === activeConfig.database,
        })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDatabaseSuggestions([]);
      setDatabaseSuggestionError(`Failed to load live databases from ${activeConfig.host}:${activeConfig.port}: ${message}`);
    }
  };

  useEffect(() => {
    void refreshDatabaseSuggestions();
  }, []);

  if (!chatIoRef.current) {
    chatIoRef.current = {
      cwd: io.cwd,
      log(message) {
        appendEntry({ body: message, tone: inferLineTone(message) });
      },
      logBlock(title, body) {
        const plan = isPlanBlockTitle(title) ? (runtimeStateRef.current.session?.getPlan() ?? []) : undefined;
        if (plan) {
          setPlanItems(plan);
        }

        appendEntry({
          title,
          body,
          tone: inferBlockTone(title),
          meta: plan ? { plan } : undefined,
        });
      },
      confirm(message) {
        return promptRuntime.confirm(message, false);
      },
      approveSql(message) {
        return promptRuntime.approveSql(message);
      },
      createProgressHandle(message) {
        const taskId = nextUiId("progress");
        const startedAt = Date.now();
        setLoadingTasks((current) => [...current, { id: taskId, message, startedAt }]);

        return {
          update(snapshot) {
            setLoadingTasks((current) =>
              current.map((entry) =>
                entry.id === taskId
                  ? {
                      ...entry,
                      message: snapshot.message ?? entry.message,
                      completed: snapshot.completed,
                      total: snapshot.total ?? entry.total ?? null,
                      unit: snapshot.unit ?? entry.unit,
                    }
                  : entry,
              ),
            );
          },
          complete(messageOverride) {
            setLoadingTasks((current) => current.filter((entry) => entry.id !== taskId));
            if (messageOverride) {
              appendEntry({ body: messageOverride, tone: "muted" });
            }
          },
          fail(messageText) {
            setLoadingTasks((current) => current.filter((entry) => entry.id !== taskId));
            appendEntry({ body: messageText, tone: "error" });
          },
        };
      },
      async withLoading<T>(message: string, task: () => Promise<T>) {
        const taskId = nextUiId("loading");
        const startedAt = Date.now();
        setLoadingTasks((current) => [...current, { id: taskId, message, startedAt }]);

        try {
          const result = await task();
          const seconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
          setLoadingTasks((current) => current.filter((entry) => entry.id !== taskId));
          appendEntry({ body: `${message} done in ${seconds}s`, tone: "muted" });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          setLoadingTasks((current) => current.filter((entry) => entry.id !== taskId));
          appendEntry({ body: `${message} failed: ${errorMessage}`, tone: "error" });
          throw error;
        }
      },
    };
    runtimeStateRef.current.session = new AgentSession(initialConfig, initialDb, chatIoRef.current);
  }

  const chatIo = chatIoRef.current;
  const activeModelLabel = runtimeStateRef.current.config?.llm.model ?? initialConfig.llm.model;
  const databasePickerQuery = !busy && !pendingPrompt ? getDatabasePickerQuery(composerValue) : null;
  const filteredDatabaseSuggestions = databasePickerQuery === null ? [] : filterDatabaseSuggestions(databaseSuggestions, databasePickerQuery);
  const slashSuggestions = !busy && !pendingPrompt ? getSlashCommandCompletions(composerValue) : [];

  useEffect(() => {
    setSelectedDatabaseSuggestionIndex(0);
    setSelectedSlashSuggestionIndex(0);
  }, [composerValue]);

  useEffect(() => {
    if (selectedDatabaseSuggestionIndex >= filteredDatabaseSuggestions.length && filteredDatabaseSuggestions.length > 0) {
      setSelectedDatabaseSuggestionIndex(0);
    }
  }, [filteredDatabaseSuggestions.length, selectedDatabaseSuggestionIndex]);

  useEffect(() => {
    if (selectedSlashSuggestionIndex >= slashSuggestions.length && slashSuggestions.length > 0) {
      setSelectedSlashSuggestionIndex(0);
    }
  }, [selectedSlashSuggestionIndex, slashSuggestions.length]);

  const resetChatViewForDatabaseChange = () => {
    clearScreen();
    setEntries(buildWelcomeEntries(runtimeStateRef.current, initialConfig.llm.model));
    setLoadingTasks([]);
    setPlanItems(runtimeStateRef.current.session?.getPlan() ?? []);
    setComposerHistory([]);
    setComposerHistoryIndex(null);
    setComposerValue("");
  };

  const resetChatViewForClear = () => {
    clearScreen();
    setEntries(buildWelcomeEntries(runtimeStateRef.current, activeModelLabel));
    setLoadingTasks([]);
    setPlanItems([]);
    setComposerHistory([]);
    setComposerHistoryIndex(null);
    setComposerValue("");
  };

  const handleComposerChange = (nextValue: string) => {
    setComposerValue(nextValue);
    setComposerHistoryIndex(null);
  };

  const showPreviousComposerHistoryEntry = () => {
    const nextState = selectPreviousComposerHistoryEntry({
      entries: composerHistory,
      index: composerHistoryIndex,
      value: composerValue,
    });
    if (nextState.index === composerHistoryIndex && nextState.value === composerValue) {
      return;
    }

    setComposerHistoryIndex(nextState.index);
    setComposerValue(nextState.value);
  };

  const showNextComposerHistoryEntry = () => {
    const nextState = selectNextComposerHistoryEntry({
      entries: composerHistory,
      index: composerHistoryIndex,
      value: composerValue,
    });
    if (nextState.index === composerHistoryIndex && nextState.value === composerValue) {
      return;
    }

    setComposerHistoryIndex(nextState.index);
    setComposerValue(nextState.value);
  };

  const acceptSlashSuggestion = (suggestion: SlashCommandCompletion) => {
    setComposerValue(suggestion.insertText);
    setSelectedSlashSuggestionIndex(0);
  };

  const selectDatabaseOperationAccessForSuggestion = async (suggestion: DatabaseSuggestion): Promise<DatabaseOperationAccess> => {
    const currentAccess =
      suggestion.isActive && runtimeStateRef.current.config?.database.database === suggestion.databaseName
        ? runtimeStateRef.current.config.database.operationAccess
        : undefined;
    return promptDatabaseOperationAccess(promptRuntime, currentAccess, suggestion.databaseName);
  };

  const switchDatabaseFromSuggestion = async (suggestion: DatabaseSuggestion) => {
    if (busy || pendingPrompt) {
      return;
    }

    setComposerValue("");
    setBusy(true);
    appendEntry({ title: "You", body: `@${suggestion.databaseName}`, tone: "user" });

    try {
      const operationAccess = await selectDatabaseOperationAccessForSuggestion(suggestion);
      const result = await switchRuntimeToDatabase(
        suggestion.databaseName,
        suggestion.schema,
        operationAccess,
        runtimeStateRef.current,
        chatIo,
        chatIo,
      );
      if (result.clearedConversation) {
        resetChatViewForDatabaseChange();
      }
      result.notices.forEach((notice) => presenter.line(notice));
      setPlanItems(runtimeStateRef.current.session?.getPlan() ?? []);
      setActiveDatabaseLabel(formatDatabaseTarget(runtimeStateRef.current.config?.database));
      await refreshDatabaseSuggestions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEntry({ title: "Error", body: message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const closeAndExit = () => {
    setBusy(true);
    exit();
  };

  const runAgentTurn = async (input: string) => {
    const session = runtimeStateRef.current.session;
    if (!session) {
      appendEntry({ body: "No active database is configured. Add or switch to a database first.", tone: "warning" });
      return;
    }

    appendEntry({ title: "You", body: input, tone: "user" });
    const result = await session.run(input);
    setPlanItems(result.plan);
    appendEntry({ title: "Assistant", body: result.content, tone: "assistant" });
  };

  const runSlashCommand = async (line: string) => {
    const parsed = parseSlashCommand(line);
    const resetForRuntimeChange = async (result: RuntimeSwitchOutcome) => {
      if (!result.clearedConversation) {
        return;
      }

      resetChatViewForDatabaseChange();
    };

    switch (parsed.command) {
      case "exit":
        closeAndExit();
        return;
      case "help":
        printHelp(presenter);
        return;
      case "clear":
        handleClearCommand(runtimeStateRef.current);
        resetChatViewForClear();
        return;
      case "plan":
        handlePlanCommand(runtimeStateRef.current, presenter);
        return;
      case "schema":
        await handleSchemaCommand(parsed, runtimeStateRef.current, presenter);
        return;
      case "host":
        await handleHostCommand(parsed, runtimeStateRef.current, promptRuntime, chatIo, chatIo, presenter, {
          beforePresentingRuntimeChange: resetForRuntimeChange,
        });
        setActiveDatabaseLabel(formatDatabaseTarget(runtimeStateRef.current.config?.database));
        await refreshDatabaseSuggestions();
        return;
      case "database":
        await handleDatabaseCommand(parsed, runtimeStateRef.current, promptRuntime, chatIo, chatIo, presenter, {
          beforePresentingRuntimeChange: resetForRuntimeChange,
        });
        setActiveDatabaseLabel(formatDatabaseTarget(runtimeStateRef.current.config?.database));
        await refreshDatabaseSuggestions();
        return;
      default:
        throw new Error("Unknown slash command. Type /help.");
    }
  };

  const submitComposer = async () => {
    const value = composerValue.trim();
    if (!value || busy || pendingPrompt) {
      return;
    }

    if (databasePickerQuery !== null) {
      const selectedSuggestion = filteredDatabaseSuggestions[selectedDatabaseSuggestionIndex] ?? filteredDatabaseSuggestions[0];
      if (!selectedSuggestion) {
        appendEntry({
          title: "Error",
          body: databaseSuggestionError
            ? databaseSuggestionError
            : databaseSuggestionHostName
              ? `No live database matches '${value}'.`
              : "No active database connection is configured. Use /host or /database to add one first.",
          tone: "error",
        });
        return;
      }

      await switchDatabaseFromSuggestion(selectedSuggestion);
      return;
    }

    if (!value.startsWith("/")) {
      setComposerHistory((current) => [...current, value]);
      setComposerHistoryIndex(null);
    }

    setComposerValue("");
    setBusy(true);

    try {
      if (value.startsWith("/")) {
        await runSlashCommand(value);
      } else {
        await runAgentTurn(value);
      }

      setPlanItems(runtimeStateRef.current.session?.getPlan() ?? []);
      setActiveDatabaseLabel(formatDatabaseTarget(runtimeStateRef.current.config?.database));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEntry({ title: "Error", body: message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return {
    entries,
    loadingTasks,
    spinnerFrame,
    planItems,
    pendingPrompt,
    composerValue,
    composerPlaceholder: busy ? "Busy..." : pendingPrompt ? "Resolve the prompt above" : `Ask the database anything on ${activeDatabaseLabel}, type @ to switch, or /help`,
    composerActive: !busy && !pendingPrompt,
    databasePickerMode: databasePickerQuery !== null,
    databaseSuggestionHostName,
    databaseSuggestionError,
    filteredDatabaseSuggestions,
    selectedDatabaseSuggestionIndex,
    slashSuggestions,
    selectedSlashSuggestionIndex,
    historyBrowsingActive: composerHistoryIndex !== null,
    setSelectedDatabaseSuggestionIndex,
    setSelectedSlashSuggestionIndex,
    handleComposerChange,
    acceptSlashSuggestion,
    acceptDatabaseSuggestion(suggestion) {
      void switchDatabaseFromSuggestion(suggestion);
    },
    showPreviousComposerHistoryEntry,
    showNextComposerHistoryEntry,
    resolvePendingPrompt(value) {
      const currentPrompt = pendingPromptRef.current;
      setCurrentPrompt(null);
      currentPrompt?.resolve(value as never);
    },
    rejectPendingPrompt(error) {
      const currentPrompt = pendingPromptRef.current;
      setCurrentPrompt(null);
      currentPrompt?.reject(error);
    },
    submitComposer,
    closeAndExit,
  };
}
