import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { canonicalizeCompactionHandoff } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import {
  requestCompactionHandoff,
  RetainedCompactionSourceUnavailableError,
} from "./retained-compaction-handoff";
import type { TurnBroker } from "./turn-broker";
import { chatGptTurnSessions } from "./turn-execution";
import { emitBrowserCompletion } from "./turn-events";
import { estimateChatGptWebUsage } from "./usage";

interface EnhancedCompactionOptions {
  worker: ChatGptBrowserWorker;
  parsed: CodexParsedRequest;
  broker: TurnBroker;
  executionNamespace: string;
  capabilities: ChatGptWebCapabilities;
  responseExecutionKey: string;
  nativeConnectorAvailable: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  emit: (event: AdapterEvent) => void;
}

export async function runEnhancedCompaction(
  options: EnhancedCompactionOptions,
): Promise<"completed" | "rebuild"> {
  const {
    worker, parsed, broker, executionNamespace, capabilities, responseExecutionKey,
    nativeConnectorAvailable, abortSignal, timeoutMs, emit,
  } = options;
  if (!nativeConnectorAvailable) {
    throw new ChatGptWebAdapterError(
      "Enhanced Web structured compaction requires the Codex Native2 connector.",
      {
        status: 409,
        errorType: "invalid_request_error",
        code: "compaction_handoff_unavailable",
        retryable: false,
      },
    );
  }
  const sourceSession = chatGptTurnSessions.find(responseExecutionKey);
  if (!sourceSession) {
    console.info(
      "[chatgpt-web] Web session mode=enhanced path=active_handoff"
      + " result=source_session_unavailable action=rebuild",
    );
    return "rebuild";
  }
  const traceId = createHash("sha256")
    .update(`${responseExecutionKey}:handoff`)
    .digest("hex")
    .slice(0, 12);
  let activeHandoff: string | undefined;
  try {
    activeHandoff = await requestCompactionHandoff(
      worker, parsed, sourceSession, broker, executionNamespace, capabilities,
      traceId, abortSignal, timeoutMs,
    );
  } catch (error) {
    if (!(error instanceof RetainedCompactionSourceUnavailableError)) throw error;
    await chatGptTurnSessions.retireAndWait(responseExecutionKey);
    console.info(
      "[chatgpt-web] Web session mode=enhanced path=active_handoff"
      + " result=retained_source_unavailable action=rebuild",
    );
    return "rebuild";
  }
  const handoff = canonicalizeCompactionHandoff(parsed, activeHandoff ?? "");
  if (handoff) {
    await chatGptTurnSessions.retireAndWait(responseExecutionKey);
    console.info("[chatgpt-web] Web session mode=enhanced path=active_handoff result=completed");
    emit({ type: "text_delta", text: handoff, phase: "final_answer" });
    emitBrowserCompletion(
      { type: "final", answer: handoff },
      estimateChatGptWebUsage(parsed, { answer: handoff, reasoning: [] }, capabilities),
      emit,
    );
    return "completed";
  }
  // The source-side handoff is an optimization. If its bounded attempt cannot produce a validated
  // checkpoint, retire that surface and rebuild once from Codex's canonical request in this same
  // HTTP compact operation. This is the exact recovery a client reconnect previously triggered,
  // without surfacing a false failure or asking Codex to repeat an ambiguous request.
  await chatGptTurnSessions.retireAndWait(responseExecutionKey);
  console.warn(
    "[chatgpt-web] Web session mode=enhanced path=active_handoff"
    + " result=checkpoint_unavailable action=rebuild",
  );
  return "rebuild";
}
