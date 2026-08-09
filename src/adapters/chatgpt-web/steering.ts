import { namespacedToolName, type CodexParsedRequest } from "../../types";
import { extractChatGptTurnUserRevision, extractChatGptTurnUserText } from "./environment";
import type { BrokerToolRequest, TurnBroker } from "./turn-broker";
import type { ChatGptTurnRuntime, ChatGptTurnSession, ChatGptTurnSessions } from "./turn-execution";

export async function sessionForChatGptRequest(
  sessions: ChatGptTurnSessions,
  key: string,
  parsed: CodexParsedRequest,
  start: () => ChatGptTurnRuntime,
): Promise<ChatGptTurnSession> {
  const revision = JSON.stringify(extractChatGptTurnUserRevision(parsed));
  const text = extractChatGptTurnUserText(parsed) ?? "The user added a new instruction.";
  let session = sessions.getOrCreate(key, start);
  const steering = session.updateUserRevision(revision, text);
  if (!steering || (session.runtime.mode === "tools" && !session.settledOutcome())) return session;

  await sessions.retireAndWait(key);
  session = sessions.getOrCreate(key, start);
  session.updateUserRevision(revision, text);
  return session;
}

export function deliverPendingChatGptSteering(
  session: ChatGptTurnSession,
  broker: TurnBroker,
  token: string,
  traceId: string,
): void {
  const steering = session.takePendingSteering();
  if (!steering) return;
  broker.requestSteering(token, `The user added this instruction while you were working:\n\n${steering}`);
  session.clearOutstanding();
  console.info(`[chatgpt-web] browser turn ${traceId} accepted native steering without opening a replacement tab`);
}

export function claudeConversationResumeRequest(parsed: CodexParsedRequest): CodexParsedRequest | undefined {
  const raw = parsed._rawBody as { client_metadata?: { claude_retain_conversation?: unknown } } | undefined;
  if (raw?.client_metadata?.claude_retain_conversation !== true) return undefined;
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0) return undefined;
  return {
    ...parsed,
    context: { ...parsed.context, messages: parsed.context.messages.slice(lastAssistant + 1) },
  };
}

export function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}
