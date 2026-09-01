import type { BrowserTurn } from "./browser-worker";
import type { LauncherHelperMessage } from "./launcher-helper-protocol";

type FenceEvent = Extract<LauncherHelperMessage, {
  type: "event";
  event: "tool_batch_observed" | "completion_fence_begin" | "completion_fence_commit";
}>;

export function assertLauncherHelperFenceFeatures(turn: BrowserTurn, features: Set<string>): void {
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
    : fence.commit(message.revision).then(committed => ({
      type: "completion_fence_commit_ack", id: message.id, requestId: message.requestId, committed,
    }));
  void request.then(response => active() ? send(response) : undefined).catch(error => fail(errorOf(error)));
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
