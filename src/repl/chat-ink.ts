import { render } from "ink";
import { createElement } from "react";
import type { AgentIO } from "../types/index.js";
import type { ChatRuntimeState } from "./runtime.js";
import { ChatApp } from "./chat-app.js";

/**
 * Start the Ink-based interactive chat session.
 */
export async function startInkChatRepl(state: ChatRuntimeState, io: AgentIO): Promise<void> {
  const app = render(createElement(ChatApp, { state, io, clearScreen: () => app.clear() }));
  await app.waitUntilExit();
}
