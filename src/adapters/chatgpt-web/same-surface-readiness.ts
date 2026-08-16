import {
  chatGptCompletionEvidenceError,
  chatGptWebSurfaceError,
  type ChatGptWebAdapterError,
} from "./adapter-error";

export interface ChatGptSameSurfaceEvidence {
  responsePresent: boolean;
  bindingPresent: boolean;
  completionActionVisible: boolean;
  globalCompletionActionVisible: boolean;
  composerVisibleCount: number;
  composerTextChars: number[];
  running: boolean;
  aborted: boolean;
}

export type ChatGptSameSurfaceReadinessReason =
  | "eligible"
  | "aborted"
  | "generation_running"
  | "response_missing"
  | "binding_missing"
  | "completion_action_conflict"
  | "composer_ambiguous"
  | "composer_not_empty";

export interface ChatGptSameSurfaceReadiness {
  eligible: boolean;
  reason: ChatGptSameSurfaceReadinessReason;
}

/**
 * Decide whether a completed-looking ChatGPT document is safe for an in-place continuation.
 * This deliberately uses only public DOM state. A completion action outside the bound assistant
 * turn proves that the page and the current response locator no longer describe the same surface.
 */
export function chatGptSameSurfaceReadiness(
  evidence: ChatGptSameSurfaceEvidence,
): ChatGptSameSurfaceReadiness {
  const reject = (reason: Exclude<ChatGptSameSurfaceReadinessReason, "eligible">): ChatGptSameSurfaceReadiness => ({
    eligible: false,
    reason,
  });
  if (evidence.aborted) return reject("aborted");
  if (evidence.running) return reject("generation_running");
  if (!evidence.responsePresent) return reject("response_missing");
  if (!evidence.bindingPresent) return reject("binding_missing");
  if (!evidence.completionActionVisible && evidence.globalCompletionActionVisible) {
    return reject("completion_action_conflict");
  }
  if (evidence.composerVisibleCount !== 1 || evidence.composerTextChars.length !== 1) {
    return reject("composer_ambiguous");
  }
  if (evidence.composerTextChars[0] !== 0) return reject("composer_not_empty");
  return { eligible: true, reason: "eligible" };
}

export function chatGptCompletionEvidenceFailure(
  message: string,
  streamed: boolean,
  evidence: ChatGptSameSurfaceEvidence,
): { readiness: ChatGptSameSurfaceReadiness; error: ChatGptWebAdapterError } {
  const readiness = chatGptSameSurfaceReadiness(evidence);
  return {
    readiness,
    error: readiness.eligible
      ? chatGptCompletionEvidenceError(message, streamed)
      : chatGptWebSurfaceError(message, streamed),
  };
}
