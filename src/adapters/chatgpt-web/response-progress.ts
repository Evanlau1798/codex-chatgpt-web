import {
  ChatGptNativeToolActivityTracker,
  classifyChatGptNativeToolActivity,
  type ChatGptNativeToolCandidate,
} from "./native-tool-activity";
import type { ChatGptVisibleTraceBlock } from "./visible-trace-tracker";

interface ResponseProgressSnapshot {
  responsePresent: boolean;
  markdownRoots: Array<{ text: string; toolEpoch: number }>;
  traceBlocks: ChatGptVisibleTraceBlock[];
  nativeToolCandidates: ChatGptNativeToolCandidate[];
}

/** The same bounded DOM evidence keeps both output transports alive; it never supplies an answer. */
export class ChatGptResponseProgressTracker {
  private chars = 0;
  private toolEpoch = -1;
  private readonly statuses = new Set<string>();
  private readonly nativeTools = new ChatGptNativeToolActivityTracker();

  observe(snapshot: ResponseProgressSnapshot, running: boolean, now = Date.now()) {
    const nativeEvents = this.nativeTools.update(
      classifyChatGptNativeToolActivity(snapshot.nativeToolCandidates), running, now,
    );
    let progressed = nativeEvents.some(event => event.state === "active");
    if (snapshot.responsePresent) {
      const chars = snapshot.markdownRoots.reduce((total, root) => total + root.text.length, 0)
        + snapshot.traceBlocks.filter(block => block.kind === "commentary")
          .reduce((total, block) => total + block.text.length, 0);
      const toolEpoch = snapshot.markdownRoots.reduce((latest, root) => Math.max(latest, root.toolEpoch), -1);
      const newStatus = snapshot.traceBlocks.filter(block => block.kind === "status")
        .map(block => `${block.key ?? ""}:${block.text}`).find(status => !this.statuses.has(status));
      if (chars > this.chars || toolEpoch > this.toolEpoch || newStatus) {
        this.chars = Math.max(this.chars, chars);
        this.toolEpoch = Math.max(this.toolEpoch, toolEpoch);
        if (newStatus) {
          this.statuses.add(newStatus);
          if (this.statuses.size > 512) this.statuses.delete(this.statuses.values().next().value!);
        }
        progressed = true;
      }
    }
    return { progressed, nativeEvents };
  }
}
