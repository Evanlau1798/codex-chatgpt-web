/** Public plain paste avoids file conversion. Still bound every renderer transaction. */
export const CHATGPT_LITERAL_PASTE_CHUNK_CHARS = 128_000;

// Shape-only diagnostics; delimiters never change the insertion route.
export const CHATGPT_PROMPT_MARKDOWN_DELIMITERS = ["`", "*", "_", "~", "=", "[", ")"] as const;
const MARKDOWN_DELIMITERS: ReadonlySet<string> = new Set(CHATGPT_PROMPT_MARKDOWN_DELIMITERS);
const BOUNDARY_LOOKBACK_CHARS = 4_096;
const WHITESPACE = /\s/u;

export interface ChatGptPromptInsertionOptions {
  largeStructuredDirect?: boolean;
  forceStructuredDirect?: boolean;
  /** Retired selection flags accepted for internal compatibility; one writer handles all input. */
  candidatePlainText?: boolean;
}

export type ChatGptPromptInsertionStrategy = "literal-paste";

/** Shape only: never retain prompt text, DOM, credentials, or a content fingerprint. */
export interface ChatGptPromptInsertionPlan {
  readonly strategy: ChatGptPromptInsertionStrategy;
  readonly utf16Units: number;
  /** CRLF is one boundary; CR, LF, U+2028 and U+2029 also separate text runs. */
  readonly lineCount: number;
  readonly maxLineUnits: number;
  /** Literal Markdown workload, not executed edits. */
  readonly markdownDelimiterCount: number;
  readonly hasCR: boolean;
  readonly hasNul: boolean;
}

export function chatGptPromptPreservesLeading(_plan: ChatGptPromptInsertionPlan): boolean {
  return true;
}

export function planChatGptPromptInsertion(
  text: string,
  options?: ChatGptPromptInsertionOptions,
): ChatGptPromptInsertionPlan {
  let lineCount = 1;
  let lineUnits = 0;
  let maxLineUnits = 0;
  let markdownDelimiterCount = 0;
  let hasCR = false;
  let hasNul = false;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (MARKDOWN_DELIMITERS.has(text[index]!)) markdownDelimiterCount += 1;
    if (unit === 0) hasNul = true;
    if (unit === 13) hasCR = true;
    if (unit === 13 || unit === 10 || unit === 0x2028 || unit === 0x2029) {
      maxLineUnits = Math.max(maxLineUnits, lineUnits);
      lineUnits = 0;
      lineCount += 1;
      if (unit === 13 && text.charCodeAt(index + 1) === 10) index += 1;
    } else {
      lineUnits += 1;
    }
  }
  maxLineUnits = Math.max(maxLineUnits, lineUnits);
  // Old flags remain accepted at internal call sites while the writer has one route.
  // Clipboard text never passes through HTML parsing or Markdown restoration.
  const strategy: ChatGptPromptInsertionStrategy = "literal-paste";
  return Object.freeze({
    strategy, utf16Units: text.length, lineCount, maxLineUnits,
    markdownDelimiterCount, hasCR, hasNul,
  });
}

/** The existing splitter; callers advance by the returned end, never by an estimated chunk count. */
export function chatGptPromptInsertChunkEnd(text: string, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) {
    throw new RangeError("Prompt chunk offset must identify an existing UTF-16 code unit");
  }
  const hardEnd = Math.min(offset + CHATGPT_LITERAL_PASTE_CHUNK_CHARS, text.length);
  if (hardEnd >= text.length) return hardEnd;
  for (let candidate = hardEnd; candidate >= Math.max(offset + 1, hardEnd - BOUNDARY_LOOKBACK_CHARS); candidate -= 1) {
    if (!WHITESPACE.test(text[candidate] ?? "")) continue;
    let start = candidate;
    while (start > offset && WHITESPACE.test(text[start - 1] ?? "")) start -= 1;
    if (start > offset) return start;
  }
  const previous = text.charCodeAt(hardEnd - 1);
  const next = text.charCodeAt(hardEnd);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? hardEnd - 1
    : hardEnd;
}
