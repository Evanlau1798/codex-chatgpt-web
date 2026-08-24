import { existsSync, readFileSync } from "node:fs";
import { stripUtf8Bom } from "./config";
import { getCodexConfigPath } from "./codex-integration-shared";
import type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  ManagedAssignmentKey,
  PreviousAssignment,
} from "./codex-integration-shared";

export function firstTableIndex(lines: string[]): number {
  const index = lines.findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

export function assignmentRegex(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`);
}

export function stripTomlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) return value.slice(0, index);
  }
  return value;
}

function decodeTomlString(raw: string, key: string): string {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {}
  } else if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  throw new Error(`${key} in Codex config must be a TOML string`);
}

export function findTopLevelAssignment(lines: string[], key: string): PreviousAssignment {
  const limit = firstTableIndex(lines);
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    matches.push({ present: true, rawLine: line, value: decodeTomlString(match[1]!, key), index });
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate ${key} assignments`);
  return matches[0] ?? { present: false };
}

function findTopLevelPositiveInteger(lines: string[], key: string): number | undefined {
  const limit = firstTableIndex(lines);
  const regex = assignmentRegex(key);
  const matches: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    const value = stripTomlComment(match[1]!).trim().replaceAll("_", "");
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error(`${key} in Codex config must be a positive integer`);
    }
    matches.push(Number(value));
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate ${key} assignments`);
  return matches[0];
}

export function readCodexModelContextOverride(): CodexModelContextOverride | undefined {
  const path = getCodexConfigPath();
  if (!existsSync(path)) return undefined;
  const lines = splitLines(readFileSync(path, "utf8"));
  const contextWindow = findTopLevelPositiveInteger(lines, "model_context_window");
  return contextWindow === undefined ? undefined : { contextWindow };
}

export function assignments(lines: string[]): Record<ManagedAssignmentKey, PreviousAssignment> {
  return {
    model_provider: findTopLevelAssignment(lines, "model_provider"),
    model_catalog_json: findTopLevelAssignment(lines, "model_catalog_json"),
    openai_base_url: findTopLevelAssignment(lines, "openai_base_url"),
  };
}

export function textFormat(text: string): NonNullable<CodexIntegrationJournal["format"]> {
  return {
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: /\r?\n$/.test(text),
  };
}

export function splitLines(text: string): string[] {
  const normalized = stripUtf8Bom(text);
  return normalized.length > 0 ? normalized.replace(/\r?\n$/, "").split(/\r?\n/) : [];
}

export interface CodexConfigDocument {
  lines: string[];
  endings: string[];
  utf8Bom: boolean;
}

export function parseDocument(text: string): CodexConfigDocument {
  const utf8Bom = text.startsWith("\uFEFF");
  text = stripUtf8Bom(text);
  const lines: string[] = [];
  const endings: string[] = [];
  const lineBreak = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = lineBreak.exec(text)) !== null) {
    lines.push(text.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    endings.push("");
  }
  return { lines, endings, utf8Bom };
}

export function renderDocument(document: CodexConfigDocument): string {
  const text = document.lines.map((line, index) => `${line}${document.endings[index] ?? ""}`).join("");
  return document.utf8Bom ? `\uFEFF${text}` : text;
}

function dominantLineEnding(document: CodexConfigDocument): string {
  return document.endings.find(ending => ending.length > 0) ?? "\n";
}

export function insertDocumentLine(document: CodexConfigDocument, index: number, line: string): void {
  const position = Math.max(0, Math.min(index, document.lines.length));
  const ending = dominantLineEnding(document);
  if (position === document.lines.length) {
    const lastIndex = document.lines.length - 1;
    const trailing = lastIndex >= 0 ? document.endings[lastIndex]! : ending;
    if (lastIndex >= 0) document.endings[lastIndex] = ending;
    document.lines.push(line);
    document.endings.push(trailing);
    return;
  }
  document.lines.splice(position, 0, line);
  document.endings.splice(position, 0, document.endings[position] ?? ending);
}

export function removeDocumentLine(document: CodexConfigDocument, index: number): void {
  if (index < 0 || index >= document.lines.length) return;
  const wasLast = index === document.lines.length - 1;
  const trailing = document.endings[index] ?? "";
  document.lines.splice(index, 1);
  document.endings.splice(index, 1);
  if (wasLast && document.endings.length > 0) document.endings[document.endings.length - 1] = trailing;
}
