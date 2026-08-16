import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";
import type { ChatGptThreadEnvironmentStore } from "./thread-environment";
import type { ChatGptToolResultDeliveryOptions } from "./tool-result-delivery";
import type { ChatGptTurnSessions } from "./turn-execution";
import { inheritSpawnedCodexEnvironment } from "./trusted-environment-lifecycle";
import { claudeAgentMessagingOptions } from "./claude-agent-messaging";

export function chatGptAgentLifecycleOptions(
  environmentStore: ChatGptThreadEnvironmentStore,
  parsed: CodexParsedRequest,
  sessions: ChatGptTurnSessions,
  executionNamespace: string,
): ChatGptToolResultDeliveryOptions {
  const parentThreadId = extractChatGptTurnIdentity(parsed).threadId;
  const parentGroup = parentThreadId ? `${executionNamespace}:${parentThreadId}` : undefined;
  return {
    ...claudeAgentMessagingOptions(parsed, sessions),
    onSpawnedCodexAgent(agent) {
      if (agent.threadId) inheritSpawnedCodexEnvironment(environmentStore, parsed, agent.threadId);
      if (!parentGroup) return;
      if (agent.threadId) sessions.linkGroups(parentGroup, `${executionNamespace}:${agent.threadId}`);
      else sessions.linkAgentReference(parentGroup, agent.reference);
    },
    onInterruptedCodexAgent(agent) {
      if (agent.threadId) sessions.retireGroup(`${executionNamespace}:${agent.threadId}`);
      else if (parentGroup) sessions.retireAgentReference(parentGroup, agent.reference, false);
    },
    onClosedCodexAgent(agent) {
      if (agent.threadId) sessions.retireGroupTree(`${executionNamespace}:${agent.threadId}`);
      else if (parentGroup) sessions.retireAgentReference(parentGroup, agent.reference, true);
    },
  };
}
