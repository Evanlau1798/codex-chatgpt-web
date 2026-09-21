import { CHATGPT_PROMPT_INSERT_CHUNK_CHARS } from "./prompt-attachment-budget";

// Shared with the Markdown guard so workload counts cannot drift from its alphabet.
export const CHATGPT_PROMPT_MARKDOWN_DELIMITERS = ["`", "*", "_", "~", "=", "[", ")"] as const;
const MARKDOWN_DELIMITERS: ReadonlySet<string> = new Set(CHATGPT_PROMPT_MARKDOWN_DELIMITERS);
const DIRECT_INSERT_MIN_CHARS = CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 2;
const BOUNDARY_LOOKBACK_CHARS = 4_096;
const WHITESPACE = /\s/u;

export interface ChatGptPromptInsertionOptions {
  largeStructuredDirect?: boolean;
  forceStructuredDirect?: boolean;
  /** Explicit pre-release opt-in, never inferred from payload or an API request. */
  candidatePlainText?: boolean;
}

export type ChatGptPromptInsertionStrategy = "guarded-chunked" | "direct-text" | "direct-html";

/** Shape only: never retain prompt text, DOM, credentials, or a content fingerprint. */
export interface ChatGptPromptInsertionPlan {
  readonly strategy: ChatGptPromptInsertionStrategy;
  readonly utf16Units: number;
  /** CRLF is one boundary; CR, LF, U+2028 and U+2029 also separate text runs. */
  readonly lineCount: number;
  readonly maxLineUnits: number;
  /** Potential guard replacements, not executed edits or existing private-use markers. */
  readonly markdownDelimiterCount: number;
  readonly hasCR: boolean;
  readonly hasNul: boolean;
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
  const legacyDirect = options?.forceStructuredDirect === true
    || (options?.largeStructuredDirect === true && text.length > DIRECT_INSERT_MIN_CHARS);
  // Preserve the fast, already-direct inline route. The candidate replaces only large guarded
  // work; a plain-text override of direct HTML measured substantially slower in dense fixtures.
  const candidate = options?.candidatePlainText === true && !legacyDirect && text.length > DIRECT_INSERT_MIN_CHARS;
  const direct = candidate || legacyDirect;
  const strategy: ChatGptPromptInsertionStrategy = !direct
    ? "guarded-chunked"
    : !candidate && text.length > DIRECT_INSERT_MIN_CHARS && !hasCR && !hasNul
      ? "direct-html"
      : "direct-text";
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
  const hardEnd = Math.min(offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS, text.length);
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
