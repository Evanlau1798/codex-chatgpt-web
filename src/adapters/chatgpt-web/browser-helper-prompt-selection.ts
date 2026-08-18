import type { CompiledChatGptWebPrompt } from "./prompt";

export interface BrowserHelperPromptSelection {
  select(prepared: CompiledChatGptWebPrompt): void;
  cancel(): void;
  wait(): Promise<CompiledChatGptWebPrompt>;
}

/**
 * Coordinate prompt selection without leaving a rejected promise behind when an owning turn is
 * cancelled before the browser worker reaches prompt preparation. The shared state promise only
 * resolves; the consumer-facing wait is where cancellation becomes an AbortError.
 */
export function createBrowserHelperPromptSelection(): BrowserHelperPromptSelection {
  let settle!: (prepared: CompiledChatGptWebPrompt | undefined) => void;
  let settled = false;
  const selected = new Promise<CompiledChatGptWebPrompt | undefined>(resolve => { settle = resolve; });
  const finish = (prepared: CompiledChatGptWebPrompt | undefined): void => {
    if (settled) return;
    settled = true;
    settle(prepared);
  };
  return {
    select: prepared => finish(prepared),
    cancel: () => finish(undefined),
    wait: async () => {
      const prepared = await selected;
      if (!prepared) throw new DOMException("Browser helper prompt selection aborted", "AbortError");
      return prepared;
    },
  };
}
