import { parseDataUrl } from "../image";
import { COMPACT_PROMPT, isUsableCompactionSummary } from "../../responses/compaction";
import type { CodexContentPart, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { BrokerToolResult, TurnBroker } from "./turn-broker";
import type { ChatGptBrowserOutcome, ChatGptTurnSession } from "./turn-execution";

export const COMPACTION_HANDOFF_MARKER = "CODEX_COMPACTION_HANDOFF";
export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";
const ESCAPED_COMPACTION_HANDOFF_MARKER = "CODEX\\_COMPACTION\\_HANDOFF";
const ACTIVE_HANDOFF_ATTEMPTS = 3;
const ACTIVE_HANDOFF_TIMEOUT_MESSAGE = "active browser handoff timed out";
const ACTIVE_HANDOFF_IDLE_TIMEOUT_MS = 60_000;
const ACTIVE_HANDOFF_ACTIVITY_POLL_MS = 1_000;

const HANDOFF_INSTRUCTION = `Automatic Codex context compaction has started. Do not call any more tools.
${COMPACT_PROMPT}
Return only the checkpoint summary. Start the response with exactly ${COMPACTION_HANDOFF_MARKER} on its own line.`;

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function codexToolResultToBrokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function withHandoffInstruction(result: BrokerToolResult): BrokerToolResult {
  return {
    ...result,
    content: [...result.content, { type: "text", text: HANDOFF_INSTRUCTION }],
  };
}

function missingToolResult(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: `Codex did not supply this tool result before compaction. Its execution status is unknown; do not assume success or failure.\n\n${HANDOFF_INSTRUCTION}`,
    }],
    isError: true,
  };
}

export function codexToolResultsById(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return byId;
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text.length > 0 ? text : undefined;
}

export function canonicalizeCompactionHandoff(parsed: CodexParsedRequest, summary: string): string | undefined {
  if (!isUsableCompactionSummary(summary)) return undefined;
  let latestUserPrompt: string | undefined;
  try {
    latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  } catch {
    return undefined;
  }
  if (latestUserPrompt === undefined) return undefined;
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = summary.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset >= 0) {
    return summary.slice(markerOffset + 1).trimEnd() === appendix ? summary.trimEnd() : undefined;
  }
  return `${summary.trimEnd()}\n\n${appendix}`;
}

function handoffSummary(answer: string): string | undefined {
  const normalized = answer.trim();
  const lineEnd = normalized.indexOf("\n");
  if (lineEnd < 0) return undefined;
  const marker = normalized.slice(0, lineEnd).replace(/\r$/, "");
  if (marker !== COMPACTION_HANDOFF_MARKER && marker !== ESCAPED_COMPACTION_HANDOFF_MARKER) return undefined;
  const summary = normalized.slice(lineEnd + 1).trim();
  return isUsableCompactionSummary(summary) ? summary : undefined;
}

export function retryActiveCompactionHandoff(answer: string, attempt: number): string | undefined {
  if (handoffSummary(answer) || attempt >= ACTIVE_HANDOFF_ATTEMPTS) return undefined;
  return `Your checkpoint response was rejected because it did not use the required format. Do not call tools.
Retry the checkpoint summary now and start the response with exactly ${COMPACTION_HANDOFF_MARKER} on its own line.`;
}

export function createActiveCompactionHandoffPrompts() {
  let requested = false;
  let instructionDelivered = false;
  let attempts = 0;
  return {
    request(delivered = false): void {
      requested = true;
      instructionDelivered ||= delivered;
    },
    retryPromptForAnswer(answer: string): string | undefined {
      if (!requested) return undefined;
      if (!instructionDelivered) {
        instructionDelivered = true;
        return HANDOFF_INSTRUCTION;
      }
      attempts += 1;
      return retryActiveCompactionHandoff(answer, attempts);
    },
    retryPromptForError(error: unknown): string | undefined {
      if (!requested || !retryableBrowserFailure(error)) return undefined;
      if (!instructionDelivered) {
        instructionDelivered = true;
        return HANDOFF_INSTRUCTION;
      }
      attempts += 1;
      return attempts < ACTIVE_HANDOFF_ATTEMPTS ? HANDOFF_INSTRUCTION : undefined;
    },
  };
}

function assistantFinalText(parsed: CodexParsedRequest): string | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index]!;
    if (message.role !== "assistant" || message.phase === "commentary") continue;
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("");
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

export function recoverCompactionHandoff(parsed: CodexParsedRequest): string | undefined {
  const text = assistantFinalText(parsed);
  return text ? handoffSummary(text) : undefined;
}

function streamedHandoffBlock(answer: string): string | undefined {
  const markerOffset = Math.max(
    answer.lastIndexOf(COMPACTION_HANDOFF_MARKER),
    answer.lastIndexOf(ESCAPED_COMPACTION_HANDOFF_MARKER),
  );
  if (markerOffset < 0 || (markerOffset > 0 && answer[markerOffset - 1] !== "\n")) return undefined;
  return answer.slice(markerOffset);
}

function streamedHandoffSummary(answer: string): string | undefined {
  const block = streamedHandoffBlock(answer);
  return block ? handoffSummary(block) : undefined;
}

function retryableBrowserFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (!(error instanceof Error)) return false;
  const retryable = (error as Error & { retryable?: unknown }).retryable;
  if (typeof retryable === "boolean") return retryable;
  return error.message.includes("ChatGPT composer did not")
    || error.message.includes("completed-turn action")
    || error.message.includes("completed text block");
}

async function waitForBrowser(
  session: ChatGptTurnSession,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ChatGptBrowserOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(ACTIVE_HANDOFF_TIMEOUT_MESSAGE)), timeoutMs);
  });
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException("ChatGPT web compaction aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    })
    : new Promise<never>(() => {});
  try {
    return await Promise.race([session.browserOutcome, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function requestActiveCompactionHandoff(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  lateCompletionIdleMs = ACTIVE_HANDOFF_IDLE_TIMEOUT_MS,
  activityPollMs = ACTIVE_HANDOFF_ACTIVITY_POLL_MS,
): Promise<string | undefined> {
  const cached = session.compactionHandoff();
  if (cached) return cached;
  if (!session.isActive()) return undefined;
  const handoffTextOffset = session.runtime.text.value().length;
  const recoverStreamed = (): string | undefined => {
    const recovered = streamedHandoffSummary(session.runtime.text.value().slice(handoffTextOffset));
    if (recovered) session.setCompactionHandoff(recovered);
    return recovered;
  };
  try {
    if (session.runtime.mode === "tools") {
      const token = await session.runtime.token;
      const results = codexToolResultsById(parsed, session);
      for (const request of session.outstanding()) {
        const result = results.get(request.callId);
        broker.completeTool(token, request.callId, result
          ? withHandoffInstruction(codexToolResultToBrokerResult(result))
          : missingToolResult());
        session.markResultDelivered(request.callId);
      }
      broker.requestHandoff(token, HANDOFF_INSTRUCTION);
      session.runtime.requestHandoff?.(true);
    } else {
      if (!session.runtime.requestHandoff) return undefined;
      session.runtime.requestHandoff(false);
    }
    let outcome: ChatGptBrowserOutcome;
    try {
      outcome = await waitForBrowser(session, signal, timeoutMs);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (!(error instanceof Error)
        || error.message !== ACTIVE_HANDOFF_TIMEOUT_MESSAGE
        || lateCompletionIdleMs <= 0) throw error;
      const handoffText = () => session.runtime.text.value().slice(handoffTextOffset);
      let handoffChars = streamedHandoffBlock(handoffText())?.length ?? 0;
      let idleDeadline = Date.now() + lateCompletionIdleMs;
      for (;;) {
        try {
          outcome = await waitForBrowser(
            session,
            signal,
            Math.max(1, Math.min(activityPollMs, idleDeadline - Date.now())),
          );
          break;
        } catch (lateError) {
          if (lateError instanceof DOMException && lateError.name === "AbortError") throw lateError;
          if (!(lateError instanceof Error) || lateError.message !== ACTIVE_HANDOFF_TIMEOUT_MESSAGE) throw lateError;
          const currentChars = streamedHandoffBlock(handoffText())?.length ?? 0;
          if (currentChars > handoffChars) {
            handoffChars = currentChars;
            idleDeadline = Date.now() + lateCompletionIdleMs;
          } else if (Date.now() >= idleDeadline) {
            const lateRecovered = recoverStreamed();
            if (lateRecovered) return lateRecovered;
            throw new Error("active browser handoff stopped growing");
          }
        }
      }
    }
    if (outcome.type === "error") {
      const recovered = retryableBrowserFailure(outcome.error)
        ? recoverStreamed()
        : undefined;
      return recovered;
    }
    const summary = handoffSummary(outcome.answer);
    if (summary) session.setCompactionHandoff(summary);
    return summary;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    console.warn(`[chatgpt-web] active compact handoff unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

