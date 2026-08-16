export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceCandidate {
  text: string;
  changedAt: number;
}

const DEFAULT_TRACE_STABILITY_MS = 750;

function normalizeTrace(block: ChatGptVisibleTraceBlock): string {
  const stripped = block.text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
}

function hasUnclosedStrongMarkdown(text: string): boolean {
  const markerCount = (marker: string): number => text.split(marker).length - 1;
  return (markerCount("**") + markerCount("\\*\\*")) % 2 === 1
    || (markerCount("__") + markerCount("\\_\\_")) % 2 === 1;
}

function hasUnrenderedMarkdown(text: string): boolean {
  return /\\[*`~[\]]/.test(text) || hasUnclosedStrongMarkdown(text);
}

function coalescedCommentary(blocks: ChatGptVisibleTraceBlock[]): ChatGptVisibleTraceBlock | undefined {
  const commentary = blocks.filter(block => block.kind === "commentary");
  if (commentary.length === 0) return undefined;
  if (commentary.length > 1 && !commentary.slice(0, -1).every(block => block.complete === true)) {
    return undefined;
  }
  const text = commentary.reduce((combined, block) => (
    block.text.startsWith(combined) ? block.text : combined + block.text
  ), "");
  return {
    kind: "commentary",
    key: "stream",
    text,
    ...(commentary.at(-1)?.complete === true ? { complete: true } : {}),
  };
}

/** Convert public ChatGPT trace DOM into append-only reasoning and commentary. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, TraceCandidate>();

  constructor(private readonly traceStabilityMs = DEFAULT_TRACE_STABILITY_MS) {}

  observe(
    blocks: ChatGptVisibleTraceBlock[],
    completionActionVisible: boolean,
    now = Date.now(),
  ): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    const commentary = coalescedCommentary(blocks);
    const commentaryText = commentary ? normalizeTrace(commentary) : "";
    const commentaryCandidate = this.traceCandidates.get("commentary:stream");
    const commentarySettled = commentary?.complete === true
      && commentaryCandidate?.text === commentaryText;
    let sawFirstCommentary = false;
    const stableFirstCommentary = blocks.map(block => {
      if (block.kind !== "commentary" || sawFirstCommentary) return block;
      sawFirstCommentary = true;
      return { ...block, key: "stream" };
    });
    const commentaryEmissionBaseline = commentary
      ? blocks.filter(block => block.kind === "commentary").reduce((combined, block, index) => {
          const sourceKey = index === 0
            ? "commentary:stream"
            : `commentary:${block.key ?? index}`;
          const emitted = this.emittedTrace.get(sourceKey) ?? "";
          return emitted.startsWith(combined) ? emitted : combined + emitted;
        }, "")
      : "";
    const observable = commentary
      ? [
          ...(!this.emittedTrace.has("commentary:stream") || commentarySettled
            ? blocks.filter(block => block.kind === "status")
            : []),
          commentary,
        ]
      : stableFirstCommentary;
    for (const block of observable) {
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const text = normalizeTrace(block);
      if (!text) continue;

      const candidate = this.traceCandidates.get(slot);
      const immediate = completionActionVisible
        || this.traceStabilityMs === 0
        || (block.complete === true && candidate?.text === text);
      const stableRenderedPrefix = block.kind === "commentary"
        && candidate !== undefined
        && !hasUnrenderedMarkdown(candidate.text)
        && text.startsWith(candidate.text)
        && now - candidate.changedAt >= this.traceStabilityMs;
      const stableRawMarkdown = candidate !== undefined
        && hasUnrenderedMarkdown(candidate.text)
        && !hasUnclosedStrongMarkdown(candidate.text)
        && text.startsWith(candidate.text)
        && now - candidate.changedAt >= this.traceStabilityMs * 2;
      if (block.kind === "commentary"
        && !completionActionVisible
        && block.complete !== true
        && hasUnrenderedMarkdown(text)
        && !stableRenderedPrefix
        && !stableRawMarkdown) {
        if (!candidate || !text.startsWith(candidate.text)) this.traceCandidates.set(slot, { text, changedAt: now });
        continue;
      }
      let stableText: string | undefined;
      if (immediate) {
        stableText = text;
        this.traceCandidates.set(slot, { text, changedAt: now });
      } else if (!candidate) {
        this.traceCandidates.set(slot, { text, changedAt: now });
        continue;
      } else if (candidate.text === text) {
        if (now - candidate.changedAt < this.traceStabilityMs) continue;
        stableText = text;
      } else if (block.kind === "commentary"
        && text.startsWith(candidate.text)
        && now - candidate.changedAt >= this.traceStabilityMs) {
        stableText = candidate.text;
        this.traceCandidates.set(slot, { text, changedAt: now });
      } else {
        this.traceCandidates.set(slot, { text, changedAt: now });
        continue;
      }

      const previous = this.emittedTrace.get(slot);
      if (previous === stableText) continue;
      if (block.kind === "commentary" && previous && !stableText.startsWith(previous)) continue;
      this.emittedTrace.set(slot, stableText);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";
      const deliveredPrefix = block.kind === "commentary"
        && slot === "commentary:stream"
        && commentaryEmissionBaseline.length > (previous?.length ?? 0)
        && stableText.startsWith(commentaryEmissionBaseline)
        ? commentaryEmissionBaseline
        : previous;
      if (deliveredPrefix && stableText.startsWith(deliveredPrefix)) {
        const suffix = stableText.slice(deliveredPrefix.length);
        if (suffix) output.push({ kind, text: suffix, continuation: true });
      } else {
        output.push({ kind, text: stableText });
      }
    }
    return output;
  }
}
