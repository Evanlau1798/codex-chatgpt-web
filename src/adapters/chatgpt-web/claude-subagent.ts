import type { CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";

type AnswerRetry = (answer: string, attempt: number) => string | undefined;

interface ClaudeClientMetadata {
  claude_retain_conversation?: unknown;
  claude_subagent?: unknown;
}

const ENGLISH_PROGRESS = /^(?:(?:i(?:'m| am)|we(?:'re| are))\s+)?(?:gathering|reviewing|inspecting|checking|analyzing|analysing|reading|searching|running|verifying|investigating|examining|collecting|comparing|preparing|loading|exploring|scanning|evaluating)\b/i;
const CHINESE_PROGRESS = /^(?:(?:我(?:會先|正在|正)?|正在|先)\s*)?(?:蒐集|收集|檢查|審查|分析|閱讀|搜尋|執行|驗證|調查|比較|準備|載入|掃描|評估)/;

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

export function claudeBrowserTurnOptions(parsed: CodexParsedRequest, upstreamRetry?: AnswerRetry) {
  const metadata = clientMetadata(parsed);
  const subagent = metadata?.claude_subagent === true;
  const retryPromptForAnswer: AnswerRetry | undefined = upstreamRetry || subagent
    ? (answer, attempt) => {
        const upstream = upstreamRetry?.(answer, attempt);
        if (upstream || !subagent || !progressOnly(answer)) return upstream;
        if (attempt > 1) throw new Error("ChatGPT Web subagent completed with only a progress update after retry");
        return "Your previous response was only a progress update, not the requested subagent result. Continue the task now, use tools as needed, and return the requested result or an explicit no-findings result. Do not finish with another plan or progress update.";
      }
    : undefined;
  return {
    retainConversation: metadata?.claude_retain_conversation === true && !subagent,
    retryPromptForAnswer,
  };
}
