export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_COMPLETION_PROJECTION_STALL_MS = 60_000;

export interface ChatGptProjectionAnimation {
  playState: string;
  currentTime: number | null;
  endTime: number | null;
  infinite: boolean;
}

export interface ChatGptFinalProjectionState {
  rootId?: string;
  boundaryProtocolPresent?: boolean;
  lastNodePresent: boolean;
  boundaryStart?: string;
  boundaryEnd?: string;
  lastMutationAt?: number;
  animations: readonly ChatGptProjectionAnimation[];
}

export interface ChatGptCompletionState {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
  projection: ChatGptFinalProjectionState;
}

export interface ChatGptProjectionStallDiagnostic {
  textChars: number;
  boundaryStart: string | null;
  boundaryEnd: string | null;
  blockingAnimations: number;
  stalledMs: number;
}

export type ChatGptCompletionDecision =
  | { status: "waiting" }
  | { status: "complete" }
  | { status: "stalled"; diagnostic: ChatGptProjectionStallDiagnostic };

export function chatGptTurnIsComplete(
  state: Pick<ChatGptCompletionState, "responsePresent" | "running" | "currentText" | "completionActionVisible">,
): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionVisible;
}

export function blockingChatGptProjectionAnimations<T extends ChatGptProjectionAnimation>(
  animations: readonly T[],
): T[] {
  return animations.filter(animation => (
    !animation.infinite
      && (animation.playState === "pending" || animation.playState === "running")
  ));
}

function projectionSignature(
  state: ChatGptCompletionState,
): string {
  const projection = state.projection;
  return [
    state.currentText,
    state.currentHtml ?? state.currentText,
    projection.rootId ?? "",
    projection.boundaryProtocolPresent === false ? "plain" : "bounded",
    projection.lastNodePresent ? "last" : "incomplete",
    projection.boundaryStart ?? "",
    projection.boundaryEnd ?? "",
  ].join("\0");
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private progress?: { signature: string; at: number };

  constructor(
    private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS,
    private readonly projectionStallMs = CHATGPT_COMPLETION_PROJECTION_STALL_MS,
  ) {
    if (!Number.isFinite(stableMs) || stableMs < 0) {
      throw new Error("ChatGPT completion stability window must be a non-negative finite number");
    }
    if (!Number.isFinite(projectionStallMs) || projectionStallMs <= 0) {
      throw new Error("ChatGPT projection stall window must be a positive finite number");
    }
  }

  update(state: ChatGptCompletionState, now = Date.now()): ChatGptCompletionDecision {
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      this.progress = undefined;
      return { status: "waiting" };
    }

    const blocking = blockingChatGptProjectionAnimations(state.projection.animations);
    // Web Animations affect how an already-materialized subtree is painted, but they do not prove
    // that more Markdown remains to be added. Some ChatGPT renderers keep a finite visual animation
    // running after the terminal action and public last-node boundary are present. Including its
    // currentTime in the semantic signature resets progress forever even when the extracted DOM is
    // byte-stable. Text, HTML, root identity, and public boundaries remain the completion proof;
    // active finite animations are retained as diagnostics only.
    const signature = projectionSignature(state);
    if (this.progress?.signature !== signature) {
      this.progress = { signature, at: now };
    }

    const boundaryReady = state.projection.boundaryProtocolPresent === false
      || (state.projection.lastNodePresent
        && state.projection.boundaryStart !== undefined
        && state.projection.boundaryEnd !== undefined);
    const projectionReady = Boolean(state.projection.rootId)
      && boundaryReady
      && state.projection.lastMutationAt !== undefined;
    if (!projectionReady) {
      this.candidate = undefined;
      return this.stalledDecision(state, blocking.length, now);
    }

    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return { status: "waiting" };
    }
    // The observer proves that this is a tracked projection root, but React may replace children
    // with byte-identical markup while the response is already terminal. Stability belongs to the
    // observable projection signature above, not to every implementation-level DOM mutation.
    if (now - this.candidate.since >= this.stableMs) return { status: "complete" };
    return this.stalledDecision(state, blocking.length, now);
  }

  private stalledDecision(
    state: ChatGptCompletionState,
    blockingAnimations: number,
    now: number,
  ): ChatGptCompletionDecision {
    const stalledMs = this.progress ? now - this.progress.at : 0;
    if (stalledMs < this.projectionStallMs) return { status: "waiting" };
    return {
      status: "stalled",
      diagnostic: {
        textChars: state.currentText.length,
        boundaryStart: state.projection.boundaryStart ?? null,
        boundaryEnd: state.projection.boundaryEnd ?? null,
        blockingAnimations,
        stalledMs,
      },
    };
  }
}
