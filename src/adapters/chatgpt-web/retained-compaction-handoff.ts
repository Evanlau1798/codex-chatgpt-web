import type { CodexParsedRequest } from "../../types";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { requestActiveCompactionHandoff } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";
import type { TurnBroker } from "./turn-broker";
import { chatGptConversationKey, type ChatGptTurnSession } from "./turn-execution";

const RETAINED_CONVERSATION_UNAVAILABLE = "The retained ChatGPT conversation is no longer available";

export class RetainedCompactionSourceUnavailableError extends Error {
  constructor() {
    super(RETAINED_CONVERSATION_UNAVAILABLE);
    this.name = "RetainedCompactionSourceUnavailableError";
  }
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  namespace: string,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<string | undefined> {
  const usageInput = source.runtime.usageInput;
  if (!usageInput) return undefined;
  const conversationKey = chatGptConversationKey(usageInput, namespace);
  if (!conversationKey) return undefined;
  const transaction = await broker.beginCompactionTransaction(traceId, timeoutMs);
  const instruction = structuredCompactionHandoffInstruction(transaction);
  const structuredHandoff = broker.waitForCompactionHandoff(transaction.token, signal);
  try {
    const browserCompleted = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare: async () => ({ text: instruction, images: [], release: () => {} }),
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: signal,
      onTextDelta: () => {},
    });
    const [handoff] = await Promise.all([structuredHandoff, browserCompleted]);
    console.info("[chatgpt-web] Web session mode=enhanced path=retained_handoff result=completed");
    return handoff;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.message.includes(RETAINED_CONVERSATION_UNAVAILABLE)) {
      throw new RetainedCompactionSourceUnavailableError();
    }
    console.warn(`[chatgpt-web] retained compact handoff unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    broker.abortCompactionTransaction(transaction.token);
  }
}

export function requestCompactionHandoff(
  worker: ChatGptBrowserWorker, parsed: CodexParsedRequest, source: ChatGptTurnSession,
  broker: TurnBroker, namespace: string, capabilities: ChatGptWebCapabilities,
  traceId: string, signal?: AbortSignal, timeoutMs?: number,
): Promise<string | undefined> {
  return source.isActive()
    ? requestActiveCompactionHandoff(parsed, source, broker, signal, timeoutMs)
    : requestRetainedCompactionHandoff(worker, parsed, source, broker, namespace, capabilities, traceId, signal, timeoutMs);
}
