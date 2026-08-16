import type { BrowserTurn } from "./browser-worker";
import {
  CHATGPT_SAME_SURFACE_RECOVERY_PROMPT,
  chatGptSameSurfaceRecoveryDecision,
} from "./runtime-lifecycle";
import { chatGptTurnSessions } from "./turn-execution";

type ErrorRetry = NonNullable<BrowserTurn["retryPromptForError"]>;

export function createChatGptSameSurfaceRetry(options: {
  traceId: string;
  executionKey: string;
  enhancedMode: boolean;
  abortSignal: AbortSignal;
  upstream?: (error: unknown) => string | undefined;
}): ErrorRetry | undefined {
  if (!options.enhancedMode) return undefined;
  let diagnosticLogged = false;
  return async (error, attempt) => {
    const upstream = await options.upstream?.(error);
    if (upstream) return upstream;
    const session = chatGptTurnSessions.find(options.executionKey);
    if (!session) return undefined;
    const decision = chatGptSameSurfaceRecoveryDecision(
      error,
      session,
      attempt,
      options.enhancedMode,
      options.abortSignal,
    );
    if (!diagnosticLogged) {
      diagnosticLogged = true;
      console.warn(
        `[chatgpt-web] browser turn ${options.traceId} same-surface recovery eligible=${decision.eligible}`
        + ` reason=${decision.reason} attempt=${attempt}`
        + ` finalChars=${session.runtime.text.value().length}`
        + ` outstanding=${decision.outstandingCount}`
        + ` unresolvedSuperseded=${decision.unresolvedSupersededCount}`,
      );
    }
    return decision.eligible
      ? { text: CHATGPT_SAME_SURFACE_RECOVERY_PROMPT, replaceCandidate: true }
      : undefined;
  };
}
