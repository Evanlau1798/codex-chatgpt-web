export const CHATGPT_PROMPT_INSERT_CHUNK_CHARS = 16_000;
export const CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS = 60_000;
export const CHATGPT_COMPACTION_PROMPT_ATTACHMENT_TIMEOUT_MS = 15 * 60_000;
const CHATGPT_EXPERIMENTAL_PROMPT_ATTACHMENT_TIMEOUT_PER_CHUNK_MS = 30_000;

export function chatGptPromptAttachmentTimeoutMs(
  promptChars: number,
  experimentalNoAutoCompact?: boolean,
  compaction?: boolean,
): number {
  const minimum = compaction
    ? CHATGPT_COMPACTION_PROMPT_ATTACHMENT_TIMEOUT_MS
    : CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS;
  if (!experimentalNoAutoCompact) return minimum;
  const chunks = Math.ceil(promptChars / CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  return Math.max(
    minimum,
    chunks * CHATGPT_EXPERIMENTAL_PROMPT_ATTACHMENT_TIMEOUT_PER_CHUNK_MS,
  );
}
