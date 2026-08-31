import type { CodexParsedRequest } from "../../types";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { requestActiveCompactionHandoff } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";
import type { TurnBroker } from "./turn-broker";
import { chatGptConversationKey, type ChatGptTurnSession } from "./turn-execution";

const RETAINED_CONVERSATION_UNAVAILABLE = "The retained ChatGPT conversation is no longer available";
const RETAINED_BROWSER_CLEANUP_TIMEOUT_MS = 15_000;

async function rejectOnBrowserFailure(browser: Promise<string>): Promise<never> {
  try {
    await browser;
  } catch (error) {
    throw error;
  }
  // A clean Web completion can race the local structured submission. The transaction owns the
  // bounded deadline, so let its result decide whether a checkpoint exists.
  return new Promise<never>(() => {});
}

async function waitForBrowserCleanup(browser: Promise<string>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = browser.then(() => true, () => true);
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), Math.min(timeoutMs, RETAINED_BROWSER_CLEANUP_TIMEOUT_MS));
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RetainedCompactionSourceUnavailableError extends Error {
  constructor() {
    super(RETAINED_CONVERSATION_UNAVAILABLE);
    this.name = "RetainedCompactionSourceUnavailableError";
  }
}

export async function requestRetainedCompactionHandoff(
  worker: Pick<ChatGptBrowserWorker, "run">,
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
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort();
  let browserCompleted: Promise<string> | undefined;
  if (signal?.aborted) browserAbort.abort();
  else signal?.addEventListener("abort", abortBrowser, { once: true });
  try {
    browserCompleted = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare: async () => ({ text: instruction, images: [], release: () => {} }),
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    const handoff = await Promise.race([
      structuredHandoff,
      rejectOnBrowserFailure(browserCompleted),
    ]);
    console.info("[chatgpt-web] Web session mode=enhanced path=retained_handoff result=checkpoint_submitted");
    return handoff;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.message.includes(RETAINED_CONVERSATION_UNAVAILABLE)) {
      throw new RetainedCompactionSourceUnavailableError();
    }
    console.warn(`[chatgpt-web] retained compact handoff unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    browserAbort.abort();
    broker.abortCompactionTransaction(transaction.token);
    if (browserCompleted && !await waitForBrowserCleanup(browserCompleted, timeoutMs)) {
      console.warn(`[chatgpt-web] retained compact browser cleanup exceeded ${Math.min(timeoutMs, RETAINED_BROWSER_CLEANUP_TIMEOUT_MS)}ms`);
    }
    signal?.removeEventListener("abort", abortBrowser);
  }
}

export function requestCompactionHandoff(
  worker: Pick<ChatGptBrowserWorker, "run">, parsed: CodexParsedRequest, source: ChatGptTurnSession,
  broker: TurnBroker, namespace: string, capabilities: ChatGptWebCapabilities,
  traceId: string, signal?: AbortSignal, timeoutMs?: number,
): Promise<string | undefined> {
  return source.isActive()
    ? requestActiveCompactionHandoff(parsed, source, broker, signal, timeoutMs)
    : requestRetainedCompactionHandoff(worker, parsed, source, broker, namespace, capabilities, traceId, signal, timeoutMs);
}
