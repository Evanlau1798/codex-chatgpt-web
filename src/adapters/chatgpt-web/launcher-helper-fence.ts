import type { BrowserTurn } from "./browser-worker";
import type { LauncherHelperMessage } from "./launcher-helper-protocol";
import type { ChatGptRetryPrompt } from "./steering";

type FenceEvent = Extract<LauncherHelperMessage, {
  type: "event";
  event: "tool_batch_observed" | "completion_fence_begin" | "completion_fence_commit";
}>;

export function assertLauncherHelperFenceFeatures(turn: BrowserTurn, features: Set<string>): void {
  if ((turn.retryPromptForAnswer || turn.finalAnswerAdmission) && !features.has("answer-before-completion")) {
    throw new Error("Launcher browser helper does not select answer retries before committing completion; update or restart the launcher");
  }
  if (turn.onMultipartStageAcknowledged && !features.has("multipart-stage-ack")) {
    throw new Error("Launcher browser helper does not support multipart acknowledgement forwarding; update or restart the launcher");
  }
  if (!turn.externalProgress) return;
  if (!features.has("tool-boundary-ack")) {
    throw new Error("Launcher browser helper does not support causal Codex tool-boundary acknowledgement");
  }
  if (!features.has("completion-fence")) {
    throw new Error("Launcher browser helper does not support the MCP completion fence");
  }
}

export function handleLauncherHelperFenceEvent(
  message: FenceEvent,
  turn: BrowserTurn,
  active: () => boolean,
  send: (message: unknown) => Promise<void>,
  fail: (error: Error) => void,
  onCommit?: (committed: boolean) => void,
): void {
  if (message.event === "tool_batch_observed") {
    if (!turn.externalProgress) return fail(new Error("Browser helper reported a tool boundary without progress"));
    void turn.externalProgress.acknowledgeToolBatch(message.revision).catch(error => fail(errorOf(error)));
    return;
  }
  const fence = turn.completionFence;
  if (!fence) return fail(new Error("Browser helper requested a completion fence for an unfenced turn"));
  const request = message.event === "completion_fence_begin"
    ? fence.begin().then(revision => ({
      type: "completion_fence_begin_ack", id: message.id, requestId: message.requestId, revision: revision ?? null,
    }))
    : fence.commit(message.revision).then(committed => {
      if (active()) onCommit?.(committed);
      return { type: "completion_fence_commit_ack", id: message.id, requestId: message.requestId, committed };
    });
  void request.then(response => active() ? send(response) : undefined).catch(error => fail(errorOf(error)));
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function handleLauncherHelperAnswer(
  message: Extract<LauncherHelperMessage, { type: "event"; event: "answer" }>,
  pending: {
    turn: BrowserTurn;
    answerCompletionSealed?: boolean;
    acknowledgeRetry?: () => void;
  },
  active: () => boolean,
  send: (message: unknown) => Promise<void>,
  fail: (error: Error) => void,
): void {
  if (pending.turn.finalAnswerAdmission && !pending.turn.finalAnswerAdmission.seal()) {
    fail(new Error("Launcher browser answer arrived after completion admission closed"));
    return;
  }
  pending.answerCompletionSealed = pending.turn.finalAnswerAdmission !== undefined;
  void Promise.resolve().then(() => pending.turn.retryPromptForAnswer?.(message.text, message.attempt))
    .then(prompt => {
      if (!active()) return;
      if (prompt && pending.answerCompletionSealed) {
        pending.answerCompletionSealed = false;
        pending.turn.finalAnswerAdmission?.reopen();
      }
      if (!prompt) return send({ type: "answer_retry", id: message.id });
      const retry: ChatGptRetryPrompt = typeof prompt === "string" ? { text: prompt } : prompt;
      pending.acknowledgeRetry = retry.onSubmitted;
      return send({
        type: "answer_retry", id: message.id, prompt: retry.text,
        ...(retry.onSubmitted ? { acknowledge: true } : {}),
        ...(retry.replaceCandidate ? { replaceCandidate: true } : {}),
      });
    })
    .catch(error => { if (active()) fail(errorOf(error)); });
}

export function acknowledgeLauncherMultipartStage(pending: {
  turn: BrowserTurn;
  prepared?: { multipart?: { parts: readonly string[] } };
  acknowledgedMultipartStage?: number;
}, stageIndex: number): void | Promise<void> {
  const multipart = pending.prepared?.multipart;
  if (!multipart || stageIndex >= multipart.parts.length
    || stageIndex !== (pending.acknowledgedMultipartStage ?? 0) + 1) {
    throw new Error("Launcher browser helper acknowledged an unexpected multipart stage");
  }
  pending.acknowledgedMultipartStage = stageIndex;
  return pending.turn.onMultipartStageAcknowledged?.(stageIndex);
}
