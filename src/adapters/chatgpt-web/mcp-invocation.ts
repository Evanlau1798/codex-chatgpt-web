import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "./turn-broker";

export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
): number {
  const remaining = environment.expiresAt === undefined
    ? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS
    : Math.max(1, environment.expiresAt - now);
  return Math.min(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, remaining);
}

export async function invokeChatGptMcpTool(
  socketPath: string,
  bindingId: string,
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  request: {
    wireName: string;
    freeform: boolean;
    arguments?: Record<string, unknown>;
    input?: string;
  },
  signal?: AbortSignal,
): Promise<BrokerToolResult> {
  const timeoutMs = chatGptMcpInvocationTimeout(environment);
  try {
    return await callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId,
      ...request,
    }, timeoutMs, signal);
  } catch (error) {
    await callTurnBroker(socketPath, { method: "release", bindingId }).catch(releaseError => {
      console.error(
        `[chatgpt-web-mcp] failed to retire abandoned binding:`
        + ` ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    });
    if (error instanceof TurnBrokerTimeoutError) {
      const detail = {
        code: "codex_tool_timeout",
        tool: request.wireName,
        timeout_ms: timeoutMs,
        retryable: false,
        message: `Codex tool ${request.wireName} did not complete before the MCP transport deadline. The current turn binding was retired; do not retry it in this ChatGPT response.`,
      };
      console.error(
        `[chatgpt-web-mcp] ${request.wireName} did not complete within ${timeoutMs}ms; retired its turn binding`,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(detail) }],
        structuredContent: detail,
        isError: true,
      };
    }
    throw error;
  }
}
