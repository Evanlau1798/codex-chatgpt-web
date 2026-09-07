import {
  DEFAULT_STALL_TIMEOUT_SEC,
  MAX_STALL_TIMEOUT_SEC,
  resolveStallTimeoutSec,
} from "../../stall-timeout";

export const CHATGPT_PROMPT_INSERT_CHUNK_CHARS = 16_000;
export const CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS = 60_000;
const CHATGPT_EXPERIMENTAL_PROMPT_ATTACHMENT_TIMEOUT_PER_CHUNK_MS = 30_000;

export function chatGptPromptAttachmentTimeoutMs(
  promptChars: number,
  experimentalNoAutoCompact?: boolean,
): number {
  if (!experimentalNoAutoCompact) return CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS;
  const chunks = Math.ceil(promptChars / CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  return Math.max(
    CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS,
    chunks * CHATGPT_EXPERIMENTAL_PROMPT_ATTACHMENT_TIMEOUT_PER_CHUNK_MS,
  );
}

export function chatGptNoContextStallTimeoutMs(
  promptChars: number,
  configuredStallSec?: number,
  turnTimeoutMs?: number,
): number {
  const configuredMs = resolveStallTimeoutSec(configuredStallSec) * 1000;
  const promptAndOperationMs = chatGptPromptAttachmentTimeoutMs(promptChars, true)
    + DEFAULT_STALL_TIMEOUT_SEC * 1000;
  const boundedMs = Math.min(
    MAX_STALL_TIMEOUT_SEC * 1000,
    Math.max(configuredMs, promptAndOperationMs),
  );
  return typeof turnTimeoutMs === "number" && Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
    ? Math.min(boundedMs, turnTimeoutMs)
    : boundedMs;
}
