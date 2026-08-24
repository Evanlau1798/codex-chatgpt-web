import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("nestedPreformattedBlock", {
  filter: node => node.nodeName === "PRE" && node.firstChild?.nodeName !== "CODE",
  replacement: (_content, node, options) => {
    const blockTags = new Set(["DIV", "P", "LI"]);
    const renderedText = (current: Node): string => {
      if (current.nodeType === 3) return current.nodeValue ?? "";
      if (current.nodeName === "BR") return "\n";
      if (["BUTTON", "SCRIPT", "STYLE", "SVG", "IMG", "PICTURE", "SOURCE"].includes(current.nodeName)) return "";
      const children = Array.from(current.childNodes);
      const text = children.map(renderedText).join("");
      const leafBlock = blockTags.has(current.nodeName)
        && !children.some(child => blockTags.has(child.nodeName));
      return leafBlock && text && !text.endsWith("\n") ? `${text}\n` : text;
    };
    const code = renderedText(node).replace(/\n+$/, "");
    const longestFence = Math.max(2, ...Array.from(code.matchAll(/`{3,}/g), match => match[0].length));
    const fence = (options.fence ?? "```").charAt(0).repeat(longestFence + 1);
    return `\n\n${fence}\n${code}\n${fence}\n\n`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

export function chatGptHtmlToMarkdown(html: string): string {
  return html.trim() ? turndown.turndown(html).trim() : "";
}

export interface ChatGptMarkdownSegment {
  key: string;
  html: string;
  text: string;
  group?: string;
  streamable: boolean;
}

function visibleSegmentText(segments: ChatGptMarkdownSegment[]): string {
  let text = "";
  let previousGroup: string | undefined;
  for (const segment of segments) {
    const separator = text
      ? segment.group !== undefined && segment.group === previousGroup ? "\n" : "\n\n"
      : "";
    text += `${separator}${segment.text}`;
    previousGroup = segment.group;
  }
  return text.replace(/\r\n/g, "\n");
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  text: string;
  group?: string;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

interface ChatGptMarkdownPrefixMismatch {
  error: ChatGptMarkdownConsistencyError;
  firstSeenAt: number;
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. The browser supplies semantic blocks and marks a block streamable
 * only after a following block exists. Each completed block must then remain byte-stable for the
 * configured window. Once committed, presentation-only HTML rewrites are harmless; changing its
 * visible text is an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<number, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private regrouped = false;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
    private readonly prefixRecoveryMs = 2_000,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
    if (!Number.isFinite(prefixRecoveryMs) || prefixRecoveryMs < 0) {
      throw new Error("ChatGPT Markdown prefix recovery window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    if (this.regrouped) {
      this.assertVisiblePrefix(segments);
      this.latest = segments.map(segment => ({ ...segment }));
      return "";
    }
    try {
      this.assertCommittedPrefix(segments);
    } catch (error) {
      this.assertVisiblePrefix(segments, error);
      this.regrouped = true;
      this.latest = segments.map(segment => ({ ...segment }));
      this.candidates.clear();
      return "";
    }
    this.latest = segments.map(segment => ({ ...segment }));

    for (let index = this.committed.length; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const previous = this.candidates.get(index);
      const unchanged = previous
        && previous.key === segment.key
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group;
      this.candidates.set(index, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const index of this.candidates.keys()) {
      if (index >= segments.length) this.candidates.delete(index);
    }
    let delta = "";
    while (this.committed.length < segments.length) {
      const index = this.committed.length;
      const candidate = this.candidates.get(index);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push({ key: candidate.key, text: candidate.text, group: candidate.group });
      this.candidates.delete(index);
    }
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.regrouped) {
      this.assertVisiblePrefix(this.latest);
      const complete = this.render(this.latest);
      if (!complete.startsWith(this.markdown)) {
        throw new Error("ChatGPT changed a completed text block that was already streamed to Codex");
      }
      const delta = complete.slice(this.markdown.length);
      this.markdown = complete;
      this.candidates.clear();
      return { markdown: this.markdown, delta };
    }
    this.assertCommittedPrefix(this.latest);
    let delta = "";
    for (let index = this.committed.length; index < this.latest.length; index += 1) {
      const segment = this.latest[index]!;
      delta += this.commit(segment);
      this.committed.push({ key: segment.key, text: segment.text, group: segment.group });
    }
    this.candidates.clear();
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.prefixMismatch === undefined;
  }

  private committedPrefixError(segments: ChatGptMarkdownSegment[]): ChatGptMarkdownConsistencyError | undefined {
    if (segments.length < this.committed.length) {
      return new ChatGptMarkdownConsistencyError(
        "ChatGPT removed a completed text block that was already streamed to Codex",
      );
    }
    for (let index = 0; index < this.committed.length; index += 1) {
      const previous = this.committed[index]!;
      const current = segments[index]!;
      if (current.key !== previous.key || current.text !== previous.text) {
        return new ChatGptMarkdownConsistencyError(
          "ChatGPT changed a completed text block that was already streamed to Codex",
        );
      }
    }
    return undefined;
  }

  private assertVisiblePrefix(segments: ChatGptMarkdownSegment[], cause?: unknown): void {
    const committed = visibleSegmentText(this.committed.map(segment => ({
      ...segment,
      html: "",
      streamable: true,
    })));
    const current = visibleSegmentText(segments);
    if (!committed || current === committed || current.startsWith(`${committed}\n`)) return;
    if (cause instanceof Error) throw cause;
    throw new Error("ChatGPT changed a completed text block that was already streamed to Codex");
  }

  private render(segments: ChatGptMarkdownSegment[]): string {
    let markdown = "";
    let previousGroup: string | undefined;
    for (const segment of segments) {
      const block = this.transform(chatGptHtmlToMarkdown(segment.html));
      if (!block) continue;
      const separator = markdown
        ? segment.group !== undefined && segment.group === previousGroup ? "\n" : "\n\n"
        : "";
      markdown += `${separator}${block}`;
      previousGroup = segment.group;
    }
    return markdown;
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
