function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read Codex's structured request kind without interpreting user-visible prompt text. */
export function codexResponsesRequestKind(body: unknown): string | undefined {
  const metadata = record(record(body)?.client_metadata);
  const encoded = metadata?.["x-codex-turn-metadata"];
  let turnMetadata: Record<string, unknown> | undefined;
  if (typeof encoded === "string") {
    try { turnMetadata = record(JSON.parse(encoded)); }
    catch { return undefined; }
  } else {
    turnMetadata = record(encoded);
  }
  return typeof turnMetadata?.request_kind === "string"
    ? turnMetadata.request_kind
    : undefined;
}
