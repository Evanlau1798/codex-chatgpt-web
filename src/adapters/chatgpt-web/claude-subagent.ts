import { namespacedToolName, type CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import type { BrokerToolRequest } from "./turn-broker";
import type { ChatGptTurnSessions } from "./turn-execution";

type AnswerRetry = (answer: string, attempt: number) => string | undefined;

interface ClaudeClientMetadata {
  claude_retain_conversation?: unknown;
  claude_subagent?: unknown;
}

const ENGLISH_PROGRESS = /^(?:(?:i(?:'m| am)|we(?:'re| are))\s+)?(?:gathering|reviewing|inspecting|checking|analyzing|analysing|reading|searching|running|verifying|investigating|examining|collecting|comparing|preparing|loading|exploring|scanning|evaluating)\b/i;
const CHINESE_PROGRESS = /^(?:(?:我(?:會先|正在|正)?|正在|先)\s*)?(?:蒐集|收集|檢查|審查|分析|閱讀|搜尋|執行|驗證|調查|比較|準備|載入|掃描|評估)/;
const MISSING_TOOL = /(?:沒有提供可用|沒有可用|未提供).{0,24}(?:原生命令|命令執行|command\/exec|native (?:shell|command|exec))|(?:did not advertise.{0,24})?native (?:shell|command|exec)(?: tool| gateway)?.{0,40}(?:unavailable|not available|timed out|native exec gateway)|(?:Codex Native2|codex_tool_(?:inventory|call)|Native2 invocation tool).{0,80}(?:not exposed|not available|unavailable|missing)|Codex Native(?:2)? (?:connection )?timed out|(?:unable|not able|could not|cannot).{0,120}(?:from|because|due to).{0,40}(?:available )?execution environment|(?:action|inspection).{0,40}did not execute.{0,80}(?:no|do not have).{0,24}native tool result/i;
const TOOL_UNAVAILABLE_CLAIM = /(?:沒有|缺少|無法|不能).{0,40}(?:可用|執行|呼叫|結果)|(?:unavailable|not available|cannot|unable|missing)/i;

function progressOnly(answer: string): boolean {
  const normalized = answer.trim();
  return normalized.length > 0
    && normalized.length <= 240
    && !normalized.includes("\n")
    && (ENGLISH_PROGRESS.test(normalized) || CHINESE_PROGRESS.test(normalized));
}

function clientMetadata(parsed: CodexParsedRequest): ClaudeClientMetadata | undefined {
  return (parsed._rawBody as { client_metadata?: ClaudeClientMetadata } | undefined)?.client_metadata;
}

export function normalizeClaudeToolRequests(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  if (typeof clientMetadata(parsed)?.claude_subagent !== "boolean") return;
  for (const request of requests) {
    if (request.wireName === "Agent") {
      request.arguments = { ...request.arguments, run_in_background: true };
    }
  }
}

export function claudeBrowserSessionGroup(parsed: CodexParsedRequest): string | undefined {
  if (typeof clientMetadata(parsed)?.claude_subagent !== "boolean") return undefined;
  return extractChatGptTurnIdentity(parsed).threadId;
}

export function claudeRootSessionThreadId(parsed: CodexParsedRequest): string | undefined {
  if (clientMetadata(parsed)?.claude_subagent !== false) return undefined;
  return extractChatGptTurnIdentity(parsed).threadId;
}

export function bindClaudeSessionAbort(
  parsed: CodexParsedRequest,
  signal: AbortSignal,
  sessions: ChatGptTurnSessions,
): () => void {
  const group = claudeBrowserSessionGroup(parsed);
  if (!group) return () => {};
  const retire = () => { sessions.retireGroup(group); };
  if (signal.aborted) retire();
  else signal.addEventListener("abort", retire, { once: true });
  return () => signal.removeEventListener("abort", retire);
}

export function claudeBrowserTurnOptions(
  parsed: CodexParsedRequest,
  upstreamRetry?: AnswerRetry,
  runtimeState: { toolResultDelivered?: () => boolean; turnToken?: () => string | undefined } = {},
) {
  const metadata = clientMetadata(parsed);
  const subagent = metadata?.claude_subagent === true;
  const claudeClient = typeof metadata?.claude_subagent === "boolean";
  const retryPromptForAnswer: AnswerRetry | undefined = upstreamRetry || claudeClient
      ? (answer, attempt) => {
        const upstream = upstreamRetry?.(answer, attempt);
        if (upstream) return upstream;
        const advertisedNames = (parsed.context.tools ?? [])
          .map(tool => namespacedToolName(tool.namespace, tool.name))
          .slice(0, 12);
        const namedToolRefusal = TOOL_UNAVAILABLE_CLAIM.test(answer)
          && advertisedNames.some(name => answer.toLowerCase().includes(name.toLowerCase()));
        const refusedTools = claudeClient && Boolean(parsed.context.tools?.length)
          && runtimeState.toolResultDelivered?.() !== true
          && (MISSING_TOOL.test(answer) || namedToolRefusal);
        const incompleteProgress = subagent && progressOnly(answer);
        if (!refusedTools && !incompleteProgress) return undefined;
        if (attempt > 1) {
          if (refusedTools) return undefined;
          throw new Error("ChatGPT Web subagent completed with only a progress update after retry");
        }
        const advertised = advertisedNames.join(", ");
        const turnToken = runtimeState.turnToken?.();
        return refusedTools
          ? `Advertised client tools are available in this turn: ${advertised}. Use Codex Native2 codex_tool_inventory with one exact advertised name at a time, for example query ${JSON.stringify(advertisedNames[0])}; never combine several names into one query. ${turnToken ? `For this retry, use exactly turn_token ${turnToken}; all earlier turn tokens in this conversation are retired.` : "Use the current turn_token from codex_native_turn_binding."} Then invoke the returned wire_name with codex_tool_call, and return the actual result. Do not answer before the tool call returns, and do not claim a client tool is missing unless codex_tool_inventory or codex_tool_call returns that concrete error.`
          : "Your previous response was only a progress update, not the requested subagent result. Continue the task now, use tools as needed, and return the requested result or an explicit no-findings result. Do not finish with another plan or progress update.";
      }
    : undefined;
  return {
    retainConversation: !parsed._compactionRequest && (claudeClient
      ? metadata?.claude_retain_conversation === true
      : Boolean(extractChatGptTurnIdentity(parsed).threadId)),
    retryPromptForAnswer,
  };
}
