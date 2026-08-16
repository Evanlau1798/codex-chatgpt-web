import { namespacedToolName, type CodexParsedRequest } from "../../types";
import { historicalClaudeGuidance } from "../../messages/claude-steering-history";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision, extractChatGptTurnUserText } from "./environment";
import type { BrokerToolRequest, TurnBroker } from "./turn-broker";
import { claudeBrowserSessionGroup, claudeRootSessionThreadId, normalizeClaudeToolRequests } from "./claude-subagent";
import { claudeAdditiveSteeringInstruction } from "./tool-result-delivery";
import { chatGptConversationKey, chatGptTurnSteeringId, type ChatGptSteeringFeed, type ChatGptTurnRuntime, type ChatGptTurnSession, type ChatGptTurnSessions } from "./turn-execution";
import type { CompletedClaudeSteering } from "./steering-feed";

export interface ChatGptRetryPrompt { text: string; onSubmitted?: () => void }
type AnswerRetryValue = string | ChatGptRetryPrompt | undefined;
type AnswerRetry = (answer: string, attempt: number) => AnswerRetryValue | Promise<AnswerRetryValue>;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => part && typeof part === "object" && !Array.isArray(part)
    && (part as { type?: unknown; text?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string"
    ? [(part as { text: string }).text] : []).join("\n");
}

function preserveCompletedClaudeSteering(
  parsed: CodexParsedRequest,
  completed: CompletedClaudeSteering[],
): void {
  const historical = completed.map(item => historicalClaudeGuidance(item.text)).filter(record => (
    !parsed.context.messages.some(message => contentText(message.content).includes(record))
  ));
  if (historical.length === 0) return;
  const text = historical.join("\n\n");
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  const toolResult = parsed.context.messages.findLastIndex((message, index) => (
    index < lastAssistant && message.role === "toolResult"
  ));
  if (toolResult >= 0) {
    const message = parsed.context.messages[toolResult]!;
    if (message.role !== "toolResult") return;
    message.content = typeof message.content === "string"
      ? `${message.content}\n\n${text}`
      : [...message.content, { type: "text", text }];
    return;
  }
  const insertion = lastAssistant < 0 ? 0 : lastAssistant;
  const timestamp = lastAssistant < 0 ? 0 : parsed.context.messages[lastAssistant]!.timestamp - 1;
  parsed.context.messages.splice(insertion, 0, { role: "user", content: text, timestamp });
}

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
    return pending && additive ? { text, onSubmitted: () => steering.acknowledgeClaude(pending.count) } : text;
  };
}

export async function sessionForChatGptRequest(
  sessions: ChatGptTurnSessions,
  key: string,
  parsed: CodexParsedRequest,
  start: () => ChatGptTurnRuntime,
  groupNamespace?: string,
  allowSteering = true,
): Promise<ChatGptTurnSession> {
  const revision = JSON.stringify(extractChatGptTurnUserRevision(parsed));
  const text = extractChatGptTurnUserText(parsed) ?? "The user added a new instruction.";
  const identity = extractChatGptTurnIdentity(parsed);
  const rawGroup = claudeBrowserSessionGroup(parsed) ?? identity.threadId;
  const group = rawGroup && groupNamespace ? `${groupNamespace}:${rawGroup}` : rawGroup;
  if (identity.threadId && identity.parentThreadId && identity.threadId !== identity.parentThreadId) {
    const parentGroup = groupNamespace ? `${groupNamespace}:${identity.parentThreadId}` : identity.parentThreadId;
    const childGroup = groupNamespace ? `${groupNamespace}:${identity.threadId}` : identity.threadId;
    sessions.linkGroups(parentGroup, childGroup);
  }
  const claudeRootThreadId = claudeRootSessionThreadId(parsed);
  const replacementConversationKey = groupNamespace
    ? chatGptConversationKey(parsed, groupNamespace)
    : undefined;
  const steeringId = identity.threadId && identity.turnId
    ? chatGptTurnSteeringId(identity.threadId, identity.turnId)
    : undefined;
  let session = sessions.getOrCreate(key, start, group, steeringId, claudeRootThreadId);
  const settled = session.settledOutcome();
  const activeClaudeRoot = Boolean(claudeRootThreadId && !settled);
  const steering = session.updateUserRevision(revision, text, !activeClaudeRoot);
  if (!allowSteering && steering) {
    await sessions.retireAndWait(key, replacementConversationKey);
    session = sessions.getOrCreate(key, start, group, steeringId, claudeRootThreadId);
    session.updateUserRevision(revision, text);
    return session;
  }
  if (activeClaudeRoot) return session;
  if (!steering || (!settled && (session.runtime.mode === "tools" || session.runtime.steering))) return session;

  const completedClaudeSteering = session.completedClaudeSteering();
  if (claudeRootThreadId) preserveCompletedClaudeSteering(parsed, completedClaudeSteering);
  await sessions.retireAndWait(key, replacementConversationKey);
  session = sessions.getOrCreate(key, start, group, steeringId, claudeRootThreadId);
  if (claudeRootThreadId) session.inheritCompletedClaudeSteering(completedClaudeSteering);
  session.updateUserRevision(revision, text);
  return session;
}

export function deliverPendingChatGptSteering(
  session: ChatGptTurnSession,
  broker: TurnBroker,
  token: string,
  traceId: string,
): "queued" | "delivered" | undefined {
  if (session.claudeRootThreadId || session.peekPendingClaudeSteering()) return undefined;
  const steering = session.takePendingSteering();
  if (!steering) return undefined;
  const delivery = broker.requestSteering(token, `The user added this instruction while you were working:\n\n${steering}`);
  session.supersedeOutstanding();
  console.info(`[chatgpt-web] browser turn ${traceId} ${delivery} native steering without opening a replacement tab`);
  return delivery;
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
