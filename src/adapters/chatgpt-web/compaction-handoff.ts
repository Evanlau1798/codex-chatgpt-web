import { parseDataUrl } from "../image";
import { COMPACT_PROMPT, isUsableCompactionSummary } from "../../responses/compaction";
import type { CodexContentPart, CodexParsedRequest, CodexToolResultMessage } from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { BrokerToolResult, TurnBroker } from "./turn-broker";
import type { ChatGptBrowserOutcome, ChatGptTurnSession } from "./turn-execution";
import { structuredCompactionHandoffInstruction } from "./native-compaction-control";

export const COMPACTION_HANDOFF_MARKER = "CODEX_COMPACTION_HANDOFF";
export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";

export const HANDOFF_INSTRUCTION = `Automatic Codex context compaction has started. Do not call any more tools.
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

function withHandoffInstruction(result: BrokerToolResult, instruction = HANDOFF_INSTRUCTION): BrokerToolResult {
  return {
    ...result,
    content: [...result.content, { type: "text", text: instruction }],
  };
}

function missingToolResult(instruction?: string): BrokerToolResult {
  const suffix = instruction ? `\n\n${instruction}` : "";
  return {
    content: [{
      type: "text",
      text: `Codex did not supply this tool result before compaction. Its execution status is unknown; do not assume success or failure.${suffix}`,
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

export function createActiveCompactionHandoffPrompts() {
  let requested = false;
  let instruction: string | undefined;
  let instructionDelivered = false;
  return {
    request(nextInstruction: string, delivered = false): void {
      requested = true;
      instruction = nextInstruction;
      instructionDelivered ||= delivered;
    },
    retryPromptForAnswer(_answer: string): string | undefined {
      if (!requested || !instruction || instructionDelivered) return undefined;
      instructionDelivered = true;
      return instruction;
    },
    retryPromptForError(error: unknown): string | undefined {
      if (!requested || !instruction || instructionDelivered || !retryableBrowserFailure(error)) return undefined;
      instructionDelivered = true;
      return instruction;
    },
  };
}

export function activeCompactionRuntimeHooks(
  prompts: ReturnType<typeof createActiveCompactionHandoffPrompts>,
  preemptHandoff: (instruction: string) => boolean,
) {
  return { preemptHandoff, requestHandoff: prompts.request };
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

async function rejectOnBrowserFailure(
  session: ChatGptTurnSession,
  broker: TurnBroker,
  transactionToken: string,
): Promise<never> {
  const outcome: ChatGptBrowserOutcome = await session.browserOutcome;
  if (outcome.type === "error") {
    broker.abortCompactionTransaction(transactionToken);
    throw outcome.error;
  }
  // A clean browser completion cannot make a structured checkpoint appear later, but the broker
  // submission may still be crossing the local socket. Keep waiting on the transaction itself;
  // its bounded TTL remains the authoritative deadline.
  return new Promise<never>(() => {});
}

export async function requestActiveCompactionHandoff(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<string | undefined> {
  const cached = session.compactionHandoff();
  if (cached) return cached;
  if (!session.isActive()) return undefined;
  if (session.runtime.mode === "read-only" && !session.runtime.requestHandoff) return undefined;
  if (signal?.aborted) {
    throw new DOMException("ChatGPT web compaction aborted", "AbortError");
  }
  const transaction = await broker.beginCompactionTransaction(
    session.runtime.conversationKey ?? "active-compaction",
    timeoutMs,
  );
  const instruction = structuredCompactionHandoffInstruction(transaction);
  const structuredHandoff = broker.waitForCompactionHandoff(transaction.token, signal);
  try {
    if (session.runtime.mode === "tools") {
      const token = await session.runtime.token;
      const results = codexToolResultsById(parsed, session);
      let instructionDelivered = false;
      const outstanding = session.outstanding();
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId);
        const boundaryInstruction = index === outstanding.length - 1 ? instruction : undefined;
        const brokerResult = result
          ? codexToolResultToBrokerResult(result)
          : missingToolResult();
        broker.completeTool(token, request.callId, boundaryInstruction
          ? withHandoffInstruction(brokerResult, boundaryInstruction)
          : brokerResult);
        session.markResultDelivered(request.callId, result);
        instructionDelivered ||= boundaryInstruction !== undefined;
      }
      const handoffDelivery = instructionDelivered ? undefined : broker.requestHandoff(token, instruction);
      const boundaryDelivered = instructionDelivered || handoffDelivery === "delivered";
      const preempted = !boundaryDelivered && session.runtime.preemptHandoff?.(instruction) === true;
      session.runtime.requestHandoff?.(instruction, boundaryDelivered || preempted);
    } else {
      const preempted = session.runtime.preemptHandoff?.(instruction) === true;
      session.runtime.requestHandoff!(instruction, preempted);
    }
    // The one-shot control submission contains the complete checkpoint and is validated by the
    // broker before it resolves. Once present it is stronger evidence than a fragile ChatGPT DOM
    // completion control; runEnhancedCompaction retires the remaining browser work before exposing
    // the checkpoint to Codex.
    const summary = await Promise.race([
      structuredHandoff,
      rejectOnBrowserFailure(session, broker, transaction.token),
    ]);
    session.setCompactionHandoff(summary);
    return summary;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    console.warn(`[chatgpt-web] active compact handoff unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    broker.abortCompactionTransaction(transaction.token);
  }
}
