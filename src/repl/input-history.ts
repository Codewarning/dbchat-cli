export interface ComposerHistoryState {
  entries: string[];
  index: number | null;
  value: string;
}

/**
 * Move to the previous submitted input, starting from the latest one when the composer is empty.
 */
export function selectPreviousComposerHistoryEntry(state: ComposerHistoryState): ComposerHistoryState {
  if (!state.entries.length) {
    return state;
  }

  const nextIndex = state.index === null ? state.entries.length - 1 : Math.max(0, state.index - 1);
  return {
    ...state,
    index: nextIndex,
    value: state.entries[nextIndex] ?? "",
  };
}

/**
 * Move to the next submitted input and eventually back to the local empty composer value.
 */
export function selectNextComposerHistoryEntry(state: ComposerHistoryState): ComposerHistoryState {
  if (state.index === null) {
    return state;
  }

  const nextIndex = state.index + 1;
  if (nextIndex >= state.entries.length) {
    return {
      ...state,
      index: null,
      value: "",
    };
  }

  return {
    ...state,
    index: nextIndex,
    value: state.entries[nextIndex] ?? "",
  };
}
