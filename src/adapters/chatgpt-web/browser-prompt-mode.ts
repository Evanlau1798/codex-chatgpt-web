import type { CompiledChatGptWebPrompt } from "./prompt";

export type BrowserPromptMode = "full" | "resume" | "refresh";

interface PromptPreparers {
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareRefresh?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
}

export function selectBrowserPromptMode(
  requested: BrowserPromptMode,
  nativeConnector: boolean,
  connectorBound: boolean | undefined,
): BrowserPromptMode {
  return requested !== "full" && (!nativeConnector || connectorBound === true) ? requested : "full";
}

export function reuseChatGptConnectorSelection(
  transport: CompiledChatGptWebPrompt["transport"],
  reusedConversation: boolean,
  responseAttempt: number,
): boolean {
  return transport !== "retained-system-archive" && (reusedConversation || responseAttempt > 1);
}

export function prepareBrowserPrompt(
  turn: PromptPreparers,
  mode: BrowserPromptMode,
): Promise<CompiledChatGptWebPrompt & { release: () => void }> {
  const prepare = mode === "refresh" ? turn.prepareRefresh
    : mode === "resume" ? turn.prepareResume : turn.prepare;
  if (!prepare) throw new Error(`ChatGPT ${mode} prompt is unavailable`);
  return prepare();
}
