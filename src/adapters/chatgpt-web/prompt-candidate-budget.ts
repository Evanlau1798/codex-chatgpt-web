import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptPromptInsertionPlan } from "./prompt-insertion-plan";
import type { ChatGptPromptInsertionSnapshot } from "./prompt-insertion-metrics";

/** Candidate-only policy. No Context Window never removes the finite attachment limit. */
export class ChatGptCandidateAttachmentBudget {
  readonly timeoutMs: number;
  private readonly started: number;
  private lastProgress?: number;
  private prefix = 0;
  private markers: number;
  private readonly completed = new Set<string>();

  constructor(readonly plan: ChatGptPromptInsertionPlan,
    private readonly now: () => number = () => performance.now(), readonly stallMs = 20_000) {
    // One native edit has its own existing 20s cap. Keep setup/verification headroom,
    // without extending the former 60/90s limit or budgeting thousands of marker edits.
    this.timeoutMs = plan.strategy === "guarded-chunked" ? 60_000 : 90_000;
    this.started = now();
    this.markers = plan.strategy === "guarded-chunked" ? plan.markdownDelimiterCount : 0;
  }

  observe(snapshot: ChatGptPromptInsertionSnapshot): void {
    if (snapshot.event === "summary" || snapshot.event === "failed") return;
    this.lastProgress ??= this.now();
    let progress = false;
    if (snapshot.verifiedUtf16Units > this.prefix) {
      this.prefix = snapshot.verifiedUtf16Units; progress = true;
    }
    if (snapshot.remainingMarkers < this.markers) {
      this.markers = snapshot.remainingMarkers; progress = true;
    }
    if (snapshot.event === "completed"
      && (snapshot.phase === "reanchor" || snapshot.phase === "final_verify")
      && !this.completed.has(snapshot.phase)) {
      this.completed.add(snapshot.phase); progress = true;
    }
    if (progress) this.lastProgress = this.now();
  }

  remainingMs(): number {
    const left = this.timeoutMs - Math.max(0, this.now() - this.started);
    if (left <= 0) return 0;
    if (this.lastProgress === undefined) return left; // Connector/setup is not editor progress.
    const idle = this.stallMs - Math.max(0, this.now() - this.lastProgress);
    if (idle <= 0) throw new ChatGptWebAdapterError("ChatGPT prompt attachment made no verified progress", {
      status: 502, errorType: "server_error", code: "chatgpt_prompt_attachment_stalled",
      retryable: false, retireSession: true,
    });
    return Math.min(left, idle);
  }
}
