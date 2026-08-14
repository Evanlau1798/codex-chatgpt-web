import { createHash } from "node:crypto";
import { chatGptHtmlToMarkdown, type ChatGptMarkdownSegment } from "./markdown";
import type { ChatGptVisibleTraceBlock } from "./visible-trace-tracker";

export interface ChatGptMarkdownRootSnapshot {
  nodeId: string;
  ownership: "commentary" | "provisional" | "final";
  toolEpoch: number;
  text: string;
  html: string;
  segments: ChatGptMarkdownSegment[];
}

interface OwnedMarkdownRoot extends ChatGptMarkdownRootSnapshot {
  id: string;
  order: number;
  visible: boolean;
  lastSeenObservation: number;
}

export interface ChatGptOwnedMarkdownSnapshot {
  markdownSegments: ChatGptMarkdownSegment[];
  finalText: string;
  finalHtml: string;
  commentaryBlocks: ChatGptVisibleTraceBlock[];
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ownershipText(text: string): string {
  return text.replace(/\\([\\`*_\[\]~])/g, "$1").replace(/[`*_~]+/g, "");
}

/** Preserve the first semantic phase assigned to a ChatGPT Markdown root across DOM rewrites. */
export class ChatGptMarkdownOwnershipTracker {
  private readonly nodeOwners = new Map<string, string>();
  private readonly fallbackOwners = new Map<string, string>();
  private readonly roots = new Map<string, OwnedMarkdownRoot>();
  private nextId = 0;
  private nextObservation = 0;

  observe(roots: ChatGptMarkdownRootSnapshot[]): ChatGptOwnedMarkdownSnapshot {
    const observation = this.nextObservation++;
    for (const root of this.roots.values()) root.visible = false;
    const occurrences = new Map<string, number>();
    const visibleFinal: OwnedMarkdownRoot[] = [];

    for (const snapshot of roots) {
      const signature = `${snapshot.toolEpoch}:${textHash(snapshot.text)}`;
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      const fallbackKey = `${signature}:${occurrence}`;
      let id = this.nodeOwners.get(snapshot.nodeId) ?? this.fallbackOwners.get(fallbackKey);
      if (!id) {
        const comparable = ownershipText(snapshot.text);
        id = [...this.roots.values()]
          .filter(root => root.ownership === "commentary"
            && root.toolEpoch === snapshot.toolEpoch
            && (snapshot.ownership === "commentary" || !root.visible)
            && root.lastSeenObservation >= observation - 2
            && root.text.length > 0
            && snapshot.text.length !== root.text.length
            && (comparable.startsWith(ownershipText(root.text))
              || (!root.visible
                && root.lastSeenObservation < observation
                && ownershipText(root.text).startsWith(comparable))))
          .sort((left, right) => right.text.length - left.text.length || right.order - left.order)
          .at(0)?.id;
      }
      if (!id) {
        id = `markdown-${this.nextId++}`;
        this.roots.set(id, { ...snapshot, id, order: this.nextId, visible: true, lastSeenObservation: observation });
      }
      this.nodeOwners.set(snapshot.nodeId, id);
      this.fallbackOwners.set(fallbackKey, id);
      const owned = this.roots.get(id)!;
      if (owned.ownership === "provisional" && snapshot.ownership === "final") {
        owned.ownership = "final";
      }
      owned.nodeId = snapshot.nodeId;
      owned.toolEpoch = snapshot.toolEpoch;
      owned.text = snapshot.text;
      owned.html = snapshot.html;
      owned.segments = snapshot.segments;
      owned.visible = true;
      owned.lastSeenObservation = observation;
      if (owned.ownership === "final") visibleFinal.push(owned);
    }

    visibleFinal.sort((left, right) => left.order - right.order);
    const commentary = [...this.roots.values()]
      .filter(root => root.ownership === "commentary")
      .sort((left, right) => left.order - right.order);
    return {
      markdownSegments: visibleFinal.flatMap(root => root.segments.map(segment => ({
        ...segment,
        key: `${root.id}:${segment.key}`,
      }))),
      finalText: visibleFinal.map(root => root.text).filter(Boolean).join("\n\n"),
      finalHtml: visibleFinal.map(root => root.html).join(""),
      commentaryBlocks: commentary.map((root, index) => ({
        kind: "commentary",
        key: root.id,
        text: chatGptHtmlToMarkdown(root.html) || root.text,
        ...(index < commentary.length - 1 || !root.visible ? { complete: true } : {}),
      })),
    };
  }
}
