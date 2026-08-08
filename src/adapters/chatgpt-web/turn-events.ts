import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "../../types";
import { canonicalizeCompactionHandoff } from "./compaction-handoff";
import type { ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning } from "./prompt";
import type { BrokerToolRequest } from "./turn-broker";
import type {
  ChatGptBrowserOutcome,
  ChatGptTraceEvent,
  ChatGptTurnSession,
} from "./turn-execution";
import { chatGptUsageInputForRound } from "./usage";

export function emitToolBatch(
  requests: BrokerToolRequest[],
  usage: CodexUsage,
  emit: (event: AdapterEvent) => void,
): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

export function emitBrowserCompletion(
  outcome: ChatGptBrowserOutcome,
  usage: CodexUsage,
  emit: (event: AdapterEvent) => void,
): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

export function emitTraceEvents(
  trace: ChatGptTraceEvent[],
  emit: (event: AdapterEvent) => void,
): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

export function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

export function emitProContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

export function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

export function runtimeUsageInput(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): CodexParsedRequest {
  if (!session.runtime.usageInput) {
    throw new Error("ChatGPT browser runtime is missing the exact prepared usage input");
  }
  return chatGptUsageInputForRound(parsed, session.runtime.usageInput);
}

export function appendCompactionUserPrompt(
  parsed: CodexParsedRequest,
  answer: string,
  emit: (event: AdapterEvent) => void,
  useNewCompactMode: boolean,
): string {
  if (!parsed._compactionRequest || !useNewCompactMode) return answer;
  const canonical = canonicalizeCompactionHandoff(parsed, answer);
  if (!canonical || !canonical.startsWith(answer)) {
    throw new Error("ChatGPT compaction could not preserve the latest user prompt");
  }
  if (canonical.length > answer.length) {
    emit({ type: "text_delta", text: canonical.slice(answer.length), phase: "final_answer" });
  }
  return canonical;
}
