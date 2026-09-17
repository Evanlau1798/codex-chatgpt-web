import { createHash } from "node:crypto";
import type { CodexUserMessage } from "../../types";
import { estimateTokens } from "../../lib/token-estimate";

export interface ChatGptSkillFile {
  name: string;
  text: string;
}

/** Only callers holding Codex's selected-skill metadata may use this transport. */
export function selectedSkillFile(message: CodexUserMessage): ChatGptSkillFile {
  if (message.origin !== "codex_skill") throw new Error("Missing Codex selected-skill provenance");
  const content = message.content;
  if (Array.isArray(content) && content.some(part => part.type !== "text")) {
    throw new Error("Selected skill instructions must contain only text");
  }
  const text = typeof content === "string" ? content : content.map(part => (part as { text: string }).text).join("\n");
  const name = /^<skill>\s*<name>([^<>\r\n]+)<\/name>/.exec(text)?.[1]?.trim();
  if (!name || !text.trimEnd().endsWith("</skill>")) {
    throw new Error("Selected skill instructions have an invalid Codex envelope; disable Skills as files to send them inline");
  }
  // The digest makes changed versions and equal names from different packages distinct.
  // Keep the original envelope, including its path/resource authority, inside the file.
  const stem = name.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 64).replace(/^-+|-+$/g, "") || "skill";
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return { name: `${stem}--${digest}.txt`, text };
}

export function skillFileTokens(files: readonly ChatGptSkillFile[] | undefined, modelId?: string): number {
  return (files ?? []).reduce((sum, file) => sum + estimateTokens(file.text, modelId), 0);
}

/** Validate before either touching the composer or acknowledging an IPC payload. */
export function validateSkillFiles(value: unknown): asserts value is ChatGptSkillFile[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 10) throw new Error("Invalid skill attachment list");
  const names = new Set<string>();
  for (const file of value) {
    if (!file || typeof file.name !== "string" || typeof file.text !== "string"
      || !/^[\p{L}\p{N}_-]{1,64}--[a-f0-9]{16}\.txt$/u.test(file.name)
      || file.text.length === 0 || Buffer.byteLength(file.text, "utf8") > 20_000_000
      || names.has(file.name)) throw new Error("Invalid or duplicate skill attachment");
    const digest = createHash("sha256").update(file.text).digest("hex").slice(0, 16);
    if (!file.name.endsWith(`--${digest}.txt`)) throw new Error("Skill attachment content does not match its name");
    names.add(file.name);
  }
}
