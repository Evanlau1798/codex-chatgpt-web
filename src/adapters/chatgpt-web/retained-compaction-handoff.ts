import type { CodexParsedRequest } from "../../types";
import {
  CHATGPT_RETAINED_SURFACE_UNAVAILABLE,
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
} from "./adapter-error";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { MAX_COMPACTION_HANDOFF_TIMEOUT_MS, withCompactionAbort } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";
import type { TurnBroker } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";

export class RetainedCompactionSourceUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(CHATGPT_RETAINED_SURFACE_UNAVAILABLE, cause === undefined ? undefined : { cause });
    this.name = "RetainedCompactionSourceUnavailableError";
  }
}

export async function requestRetainedCompactionHandoff(
  worker: Pick<ChatGptBrowserWorker, "run">,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requireAutomaticAdmission?: (traceId: string) => void,
  retainOwnershipUntil?: (settlement: Promise<void>) => void,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new RetainedCompactionSourceUnavailableError();
  const operationTimeoutMs = Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  timer.unref?.();
  const operationSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: Awaited<ReturnType<TurnBroker["beginCompactionTransaction"]>> | undefined;
  let browser: Promise<string> | undefined;
  let settlement: Promise<void> | undefined;
  let completed = false;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(lateTransaction => {
      if (operationSignal.aborted && transaction !== lateTransaction) {
        broker.abortCompactionTransaction(lateTransaction.token);
      }
    }, () => {});
    transaction = await withCompactionAbort(
      transactionPromise,
      operationSignal,
    );
    const instruction = structuredCompactionHandoffInstruction(transaction);
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    requireAutomaticAdmission?.(traceId);
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      compaction: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    settlement = browser.then(() => undefined, () => undefined);
    retainOwnershipUntil?.(settlement);
    const accepted = broker.waitForCompactionHandoff(transaction.token, operationSignal);
    const browserWithoutHandoff = browser.then<never>(() => {
      throw new ChatGptWebAdapterError(
        "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false },
      );
    });
    const handoff = await withCompactionAbort(Promise.race([accepted, browserWithoutHandoff]), operationSignal);
    browserAbort.abort(new ChatGptCompactionHandoffAccepted());
    await withCompactionAbort(settlement, operationSignal);
    completed = true;
    console.info("[chatgpt-web] Web session mode=enhanced path=retained_handoff result=checkpoint_and_response_settled");
    return handoff;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if ((error instanceof ChatGptWebAdapterError && error.code === "chatgpt_retained_surface_unavailable")
      || (error instanceof Error && error.message.includes(CHATGPT_RETAINED_SURFACE_UNAVAILABLE))) {
      throw new RetainedCompactionSourceUnavailableError(error);
    }
    throw error;
  } finally {
    if (!completed) browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    // Cancellation waits for cleanup, but never past the deadline. The owner retains
    // physical settlement independently so timeout cannot admit an overlapping run.
    if (settlement) await withCompactionAbort(settlement, deadline.signal).catch(() => {});
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(timer);
  }
}
