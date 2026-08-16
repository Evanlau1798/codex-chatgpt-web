export interface ContextArchiveChunk {
  context: string;
  index: number;
  total: number;
  sha256: string;
  nextIndex: number | null;
}

const ARCHIVE_READY_RECEIPT = [
  "CODEX_CONTEXT_ARCHIVE_READY complete=true",
  "Resume the task with the bound turn_token from codex_native_turn_binding.",
  "When local instructions or capabilities are required, discover and invoke the exact advertised tool before reporting it unavailable.",
  "Without a returned Native tool error, do not infer or name a blocking, rejection, or safety cause.",
].join("\n");

export function formatContextArchiveChunk(chunk: ContextArchiveChunk): string {
  const nextQuery = chunk.nextIndex === null ? "null" : `__codex_context__:${chunk.nextIndex}`;
  return [
    `CODEX_CONTEXT_ARCHIVE v=1 index=${chunk.index} total=${chunk.total} chars=${chunk.context.length} sha256=${chunk.sha256}`,
    chunk.context,
    `CODEX_CONTEXT_ARCHIVE_END index=${chunk.index} sha256=${chunk.sha256} next_query=${nextQuery}`,
    ...(chunk.nextIndex === null ? [ARCHIVE_READY_RECEIPT] : []),
  ].join("\n");
}
