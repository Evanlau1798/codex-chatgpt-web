import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

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
  try {
    return await callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId,
      ...request,
    }, chatGptMcpInvocationTimeout(environment), signal);
  } catch (error) {
    await callTurnBroker(socketPath, { method: "release", bindingId }).catch(releaseError => {
      console.error(
        `[chatgpt-web-mcp] failed to retire abandoned binding:`
        + ` ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    });
    throw error;
  }
}
