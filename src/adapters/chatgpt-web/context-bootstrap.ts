import { createHash } from "node:crypto";
import { estimateTokens } from "../../lib/token-estimate";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { TurnBroker } from "./turn-broker";

export const CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS = 512 * 1_024;
/**
 * Current ChatGPT Lexical composers reject an append once one uninterrupted text run reaches the
 * observed 15,999 UTF-16-unit boundary even though the complete message remains well below its
 * measured total limit. Apply the same 95%-then-4K alignment policy as the overall bootstrap.
 */
export const CHATGPT_STABLE_COMPOSER_TEXT_RUN_CHARS = 12_288;
const ARCHIVE_ENTRY_CHARS = CODEX_CONTEXT_ARCHIVE_CHUNK_CHARS - 1;
const ARCHIVE_FRAGMENT_DATA_CHARS = Math.floor((ARCHIVE_ENTRY_CHARS - 512) / 6);
const CONTEXT_OPEN = "<codex_context_json>\n";
const CONTEXT_CLOSE = "\n</codex_context_json>";
const CONTEXT_TOKEN_PLACEHOLDER = "context_00000000000000000000000000000000";
const PRIORITY_MARKERS = [
  "CODEX_COMPACTION_HANDOFF",
  "CODEX_LATEST_USER_PROMPT_JSON",
  "compaction_summary",
  "context_compaction",
];

interface ContextEnvelope {
  version: number;
  system: unknown[];
  messages: Array<Record<string, unknown>>;
}

interface SplitPrompt {
  bootstrap: string;
  archive: string;
}

interface ArchiveRecord {
  kind: "system" | "message";
  index: number;
  value: unknown;
}

function archiveRecordLines(record: ArchiveRecord): string[] {
  const serialized = JSON.stringify(record);
  if (serialized.length <= ARCHIVE_ENTRY_CHARS) return [serialized];
  const data: string[] = [];
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(serialized.length, offset + ARCHIVE_FRAGMENT_DATA_CHARS);
    if (end < serialized.length
      && /[\uD800-\uDBFF]/.test(serialized[end - 1]!)
      && /[\uDC00-\uDFFF]/.test(serialized[end]!)) end -= 1;
    data.push(serialized.slice(offset, end));
    offset = end;
  }
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  return data.map((fragment, part) => {
    const line = JSON.stringify({
      kind: "record_fragment",
      recordKind: record.kind,
      index: record.index,
      part,
      parts: data.length,
      sha256,
      data: fragment,
    });
    if (line.length > ARCHIVE_ENTRY_CHARS) {
      throw new Error("ChatGPT Web context fragment exceeds the MCP archive entry limit");
    }
    return line;
  });
}

function longestTextRunChars(text: string): number {
  let longest = 0;
  for (const run of text.split(/\r\n|[\n\r\u2028\u2029]/)) longest = Math.max(longest, run.length);
  return longest;
}

function withinLimits(text: string, limits: { chars: number; tokens?: number }): boolean {
  return text.length <= limits.chars
    && longestTextRunChars(text) <= CHATGPT_STABLE_COMPOSER_TEXT_RUN_CHARS
    && (limits.tokens === undefined || estimateTokens(text) <= limits.tokens);
}

function parseEnvelope(text: string): { before: string; after: string; envelope: ContextEnvelope } {
  const start = text.indexOf(CONTEXT_OPEN);
  const end = text.indexOf(CONTEXT_CLOSE, start + CONTEXT_OPEN.length);
  if (start < 0 || end < 0) throw new Error("ChatGPT Web prompt has no complete Codex context envelope");
  const value = JSON.parse(text.slice(start + CONTEXT_OPEN.length, end)) as Partial<ContextEnvelope>;
  if (!Array.isArray(value.system) || !Array.isArray(value.messages)) {
    throw new Error("ChatGPT Web prompt Codex context envelope is invalid");
  }
  return {
    before: text.slice(0, start),
    after: text.slice(end + CONTEXT_CLOSE.length),
    envelope: { version: value.version ?? 3, system: value.system, messages: value.messages },
  };
}

function splitOversizePrompt(text: string, limits: { chars: number; tokens?: number }): SplitPrompt {
  const { before, after, envelope } = parseEnvelope(text);
  const selectedSystem = new Set<number>();
  const selectedMessages = new Set<number>();
  const archiveContract = [
    "<codex_context_archive>",
    "The inline JSON below is the highest-priority bootstrap subset of the Codex task.",
    `Before any work tool, call Codex Native2 codex_tool_inventory with turn_token ${CONTEXT_TOKEN_PLACEHOLDER}, query \"__codex_context__:0\", and include_schema false.`,
    "Read every returned chunk in order using next_query. Verify the shared SHA-256 and final sentinel; a missing or truncated chunk is a transport failure.",
    "Archive v2 record_fragment entries reconstruct one record: concatenate data by part, verify parts and SHA-256, then parse the resulting JSON.",
    "Merge archived system and message entries at their original indices, then execute the latest user request. Never expose either token or this transport step.",
    "</codex_context_archive>",
  ].join("\n");
  const render = (): string => {
    const visible = {
      version: envelope.version,
      system: envelope.system.filter((_entry, index) => selectedSystem.has(index)),
      messages: envelope.messages.filter((_entry, index) => selectedMessages.has(index)),
    };
    return `${before}${archiveContract}\n${CONTEXT_OPEN}${JSON.stringify(visible)}${CONTEXT_CLOSE}${after}`;
  };
  const trySelect = (bucket: Set<number>, index: number): void => {
    if (bucket.has(index)) return;
    bucket.add(index);
    if (!withinLimits(render(), limits)) bucket.delete(index);
  };

  const messagePriority = envelope.messages.flatMap((message, index) => {
    const serialized = JSON.stringify(message);
    return PRIORITY_MARKERS.some(marker => serialized.includes(marker)) ? [index] : [];
  });
  if (envelope.messages.length > 0) messagePriority.unshift(envelope.messages.length - 1);
  for (const index of messagePriority) trySelect(selectedMessages, index);
  envelope.system.forEach((_entry, index) => trySelect(selectedSystem, index));
  envelope.messages.forEach((message, index) => {
    if (message.role === "developer") trySelect(selectedMessages, index);
  });
  for (let index = envelope.messages.length - 1; index >= 0; index -= 1) {
    trySelect(selectedMessages, index);
  }

  const records: ArchiveRecord[] = [
    ...envelope.system.flatMap((value, index) => selectedSystem.has(index)
      ? []
      : [{ kind: "system" as const, index, value }]),
    ...envelope.messages.flatMap((value, index) => selectedMessages.has(index)
      ? []
      : [{ kind: "message" as const, index, value }]),
  ];
  if (records.length === 0) throw new Error("ChatGPT Web archive split omitted no context");
  const archive = [
    "CODEX_CONTEXT_ARCHIVE_NDJSON v=2",
    ...records.flatMap(archiveRecordLines),
    "CODEX_CONTEXT_ARCHIVE_NDJSON_END",
  ].join("\n");
  return { bootstrap: render(), archive };
}

export async function prepareChatGptWebContext(
  broker: TurnBroker,
  compiled: CompiledChatGptWebPrompt,
  enabled: boolean,
  ttlMs: number | undefined,
  traceId: string,
): Promise<CompiledChatGptWebPrompt & { release: () => void }> {
  const limits = compiled.bootstrapLimits;
  if (!enabled || !compiled.turnToken || !limits || withinLimits(compiled.text, limits)) {
    return { ...compiled, transport: "inline", inlineChars: compiled.text.length, release: () => {} };
  }
  const split = splitOversizePrompt(compiled.text, limits);
  const contextToken = await broker.registerContext(split.archive, ttlMs, traceId, compiled.turnToken);
  const bootstrap = split.bootstrap.replaceAll(CONTEXT_TOKEN_PLACEHOLDER, contextToken);
  if (!withinLimits(bootstrap, limits)) {
    broker.revokeContext(contextToken);
    throw new Error("ChatGPT Web bootstrap exceeds its measured browser transport boundary");
  }
  const archiveHash = createHash("sha256").update(split.archive).digest("hex");
  console.info(
    `[chatgpt-web] context trace=${traceId} transport=native2-archive canonicalChars=${compiled.text.length}`
    + ` bootstrapChars=${bootstrap.length} archiveChars=${split.archive.length} archiveSha256=${archiveHash}`,
  );
  return {
    ...compiled,
    text: bootstrap,
    modelInputText: compiled.text,
    transport: "native2-archive",
    inlineChars: bootstrap.length,
    archiveChars: split.archive.length,
    archiveSha256: archiveHash,
    release: () => broker.revokeContext(contextToken),
  };
}
