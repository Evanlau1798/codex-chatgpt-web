import type { CodexParsedRequest } from "../../types";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { HANDOFF_INSTRUCTION, parseCompactionHandoff, requestActiveCompactionHandoff } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import type { TurnBroker } from "./turn-broker";
import { chatGptConversationKey, type ChatGptTurnSession } from "./turn-execution";

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  namespace: string,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const usageInput = source.runtime.usageInput;
  if (!usageInput) return undefined;
  const conversationKey = chatGptConversationKey(usageInput, namespace);
  if (!conversationKey) return undefined;
  const answer = await worker.run({
    traceId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    capabilities,
    prepare: async () => ({ text: HANDOFF_INSTRUCTION, images: [], release: () => {} }),
    conversationKey,
    requireRetainedConversation: true,
    abortSignal: signal,
    onTextDelta: () => {},
  });
  const handoff = parseCompactionHandoff(answer);
  console.info("[chatgpt-web] compact mode=beta path=retained_handoff"
    + ` result=${handoff ? "completed" : "unavailable"}`);
  return handoff;
}

export function requestCompactionHandoff(
  worker: ChatGptBrowserWorker, parsed: CodexParsedRequest, source: ChatGptTurnSession,
  broker: TurnBroker, namespace: string, capabilities: ChatGptWebCapabilities,
  traceId: string, signal?: AbortSignal, timeoutMs?: number,
): Promise<string | undefined> {
  return source.isActive()
    ? requestActiveCompactionHandoff(parsed, source, broker, signal, timeoutMs)
    : requestRetainedCompactionHandoff(worker, parsed, source, namespace, capabilities, traceId, signal);
}
