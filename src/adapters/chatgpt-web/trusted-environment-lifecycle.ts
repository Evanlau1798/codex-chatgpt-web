import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  MissingTrustedCodexEnvironmentError,
} from "./environment";
import type { ChatGptThreadEnvironmentStore } from "./thread-environment";

export function resolveTrustedCodexEnvironment(
  store: ChatGptThreadEnvironmentStore,
  parsed: CodexParsedRequest,
): ReturnType<typeof extractChatGptTurnEnvironment> {
  try {
    return store.resolve(parsed);
  } catch (error) {
    const identity = extractChatGptTurnIdentity(parsed);
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
