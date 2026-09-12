import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  MissingTrustedCodexEnvironmentError,
} from "./environment";
import type { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { chatGptTurnSessions, type ChatGptTurnSessions } from "./turn-session-registry";

export async function resolveTrustedCodexEnvironment(
  store: ChatGptThreadEnvironmentStore,
  parsed: CodexParsedRequest,
  executionKey: string,
  sessions: ChatGptTurnSessions = chatGptTurnSessions,
): Promise<ReturnType<typeof extractChatGptTurnEnvironment>> {
  try {
    return store.resolve(parsed);
  } catch (error) {
    const identity = extractChatGptTurnIdentity(parsed);
    const session = sessions.find(executionKey);
    // A failed claim cannot cancel another owner. Only a result for this exact native
    // turn's pending broker call proves that its suspended Web session must be retired.
    if (identity.threadId && identity.turnId
      && session?.runtime.nativeIdentity?.threadId === identity.threadId
      && session.runtime.nativeIdentity.turnId === identity.turnId
      && parsed.context.messages.some(message => message.role === "toolResult" && session.hasOutstanding(message.toolCallId))) {
      sessions.retire(executionKey, session);
      await sessions.waitForRetirement(executionKey);
    }
    console.warn(
      `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
    );
    if (error instanceof MissingTrustedCodexEnvironmentError) {
      throw new ChatGptWebAdapterError(error.message, {
        status: 409,
        errorType: "invalid_request_error",
        code: "missing_trusted_environment",
        retryable: false,
      });
    }
    throw error;
  }
}

export function inheritSpawnedCodexEnvironment(
  store: ChatGptThreadEnvironmentStore,
  parsed: CodexParsedRequest,
  childThreadId: string,
): void {
  const parentThreadId = extractChatGptTurnIdentity(parsed).threadId;
  if (!parentThreadId || !store.inherit(parentThreadId, childThreadId)) {
    throw new Error("Codex spawned a subagent without an inheritable trusted parent environment");
  }
  console.info("[chatgpt-web] inherited trusted environment for spawned Codex subagent");
}
