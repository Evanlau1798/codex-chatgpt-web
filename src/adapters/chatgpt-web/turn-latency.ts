import type { ChatGptVisibleTraceBlock } from "./visible-trace-tracker";

type LatencyStage = "response_visible" | "web_first_status" | "web_first_commentary" | "adapter_first_commentary";

/** Content-free timing checkpoints for diagnosing Web-to-client streaming latency. */
export class ChatGptTurnLatencyDiagnostics {
  private readonly seen = new Set<LatencyStage>();
  private firstCommentaryAt?: number;

  constructor(private readonly traceId: string, private readonly sentAt = Date.now()) {}

  private mark(stage: LatencyStage, now: number, detail = ""): boolean {
    if (this.seen.has(stage)) return false;
    this.seen.add(stage);
    console.info(`[chatgpt-web] browser turn ${this.traceId} latency stage=${stage} elapsedMs=${Math.max(0, now - this.sentAt)}${detail}`);
    return true;
  }

  responseVisible(now = Date.now()): void {
    this.mark("response_visible", now);
  }

  observe(blocks: ChatGptVisibleTraceBlock[], now = Date.now()): void {
    if (blocks.some(block => block.kind === "status")) this.mark("web_first_status", now);
    if (blocks.some(block => block.kind === "commentary") && this.mark("web_first_commentary", now)) {
      this.firstCommentaryAt = now;
    }
  }

  commentaryEmitted(now = Date.now()): void {
    const stableMs = Math.max(0, now - (this.firstCommentaryAt ?? now));
    this.mark("adapter_first_commentary", now, ` stableMs=${stableMs}`);
  }
}
