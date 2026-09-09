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

export function prepareBrowserPrompt(
  turn: PromptPreparers,
  mode: BrowserPromptMode,
): Promise<CompiledChatGptWebPrompt & { release: () => void }> {
  const prepare = mode === "refresh" ? turn.prepareRefresh
    : mode === "resume" ? turn.prepareResume : turn.prepare;
  if (!prepare) throw new Error(`ChatGPT ${mode} prompt is unavailable`);
  return prepare();
}
