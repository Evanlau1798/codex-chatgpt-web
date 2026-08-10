import type { CompiledChatGptWebPrompt } from "./prompt";
import type { TurnBroker } from "./turn-broker";

export async function prepareChatGptWebContext(
  broker: TurnBroker,
  compiled: CompiledChatGptWebPrompt,
  enabled: boolean,
  ttlMs: number | undefined,
  traceId: string,
): Promise<CompiledChatGptWebPrompt & { release: () => void }> {
  if (!enabled) return { ...compiled, release: () => {} };
  const contextToken = await broker.registerContext(compiled.text, ttlMs, traceId);
  return {
    ...compiled,
    text: [
      "Before acting, use Codex Native2 to call codex_read_context exactly once with the context_token below.",
      `context_token: ${contextToken}`,
      "Read the returned context completely and follow its role and transport contract as the full Codex task prompt.",
      "Do not expose either token or mention this transport step in the answer.",
    ].join("\n"),
    release: () => broker.revokeContext(contextToken),
  };
}
