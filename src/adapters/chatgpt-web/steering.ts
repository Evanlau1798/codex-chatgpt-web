import { namespacedToolName, type CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision, extractChatGptTurnUserText } from "./environment";
import type { BrokerToolRequest, TurnBroker } from "./turn-broker";
import { claudeBrowserSessionGroup, claudeRootSessionThreadId, normalizeClaudeToolRequests } from "./claude-subagent";
import { claudeAdditiveSteeringInstruction } from "./tool-result-delivery";
import { chatGptTurnSteeringId, type ChatGptSteeringFeed, type ChatGptTurnRuntime, type ChatGptTurnSession, type ChatGptTurnSessions } from "./turn-execution";

export interface ChatGptRetryPrompt { text: string; onSubmitted?: () => void }
type AnswerRetryValue = string | ChatGptRetryPrompt | undefined;
type AnswerRetry = (answer: string, attempt: number) => AnswerRetryValue | Promise<AnswerRetryValue>;

export function browserSteeringRetry(
  steering: ChatGptSteeringFeed,
  traceId: string,
  upstream?: AnswerRetry,
  takeUndelivered?: () => string | undefined,
  additive = false,
): AnswerRetry {
  let steeringAttempts = 0;
  return (answer, attempt) => {
    const pending = steering.peek();
    const prompt = pending
      ? additive ? claudeAdditiveSteeringInstruction(pending.text) : `The user added this instruction while you were working:\n\n${pending.text}`
      : takeUndelivered?.();
    if (!prompt) return upstream?.(answer, Math.max(1, attempt - steeringAttempts));
    steeringAttempts += 1;
    console.info(`[chatgpt-web] browser turn ${traceId} continued ${additive ? "additive Claude" : "native"} steering in the existing Web conversation`);
    const text = `${prompt}\n\nContinue the task in this same conversation. Treat this as the latest user instruction.`;
    if (pending && !additive) steering.take(pending.count);
    return pending && additive ? { text, onSubmitted: () => steering.take(pending.count) } : text;
  };
}

export async function sessionForChatGptRequest(
  sessions: ChatGptTurnSessions,
  key: string,
  parsed: CodexParsedRequest,
  start: () => ChatGptTurnRuntime,
): Promise<ChatGptTurnSession> {
  const revision = JSON.stringify(extractChatGptTurnUserRevision(parsed));
  const text = extractChatGptTurnUserText(parsed) ?? "The user added a new instruction.";
  const group = claudeBrowserSessionGroup(parsed);
  const claudeRootThreadId = claudeRootSessionThreadId(parsed);
  const identity = extractChatGptTurnIdentity(parsed);
  const steeringId = identity.threadId && identity.turnId
    ? chatGptTurnSteeringId(identity.threadId, identity.turnId)
    : undefined;
  let session = sessions.getOrCreate(key, start, group, steeringId, claudeRootThreadId);
  const steering = session.updateUserRevision(revision, text);
  if (!steering || (!session.settledOutcome() && (session.runtime.mode === "tools" || session.runtime.steering))) return session;

  await sessions.retireAndWait(key);
  session = sessions.getOrCreate(key, start, group, steeringId, claudeRootThreadId);
  session.updateUserRevision(revision, text);
  return session;
}

export function deliverPendingChatGptSteering(
  session: ChatGptTurnSession,
  broker: TurnBroker,
  token: string,
  traceId: string,
): void {
  if (session.claudeRootThreadId) return;
  const steering = session.takePendingSteering();
  if (!steering) return;
  const delivery = broker.requestSteering(token, `The user added this instruction while you were working:\n\n${steering}`);
  session.clearOutstanding();
  console.info(`[chatgpt-web] browser turn ${traceId} ${delivery} native steering without opening a replacement tab`);
}

export function claudeConversationResumeRequest(parsed: CodexParsedRequest): CodexParsedRequest | undefined {
  const raw = parsed._rawBody as { client_metadata?: { claude_retain_conversation?: unknown } } | undefined;
  if (raw?.client_metadata?.claude_retain_conversation !== true) return undefined;
  return retainedConversationResumeRequest(parsed);
}

export function retainedConversationResumeRequest(parsed: CodexParsedRequest): CodexParsedRequest | undefined {
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  if (lastAssistant < 0) return undefined;
  return {
    ...parsed,
    context: { ...parsed.context, messages: parsed.context.messages.slice(lastAssistant + 1) },
  };
}

export function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  normalizeClaudeToolRequests(parsed, requests);
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}
