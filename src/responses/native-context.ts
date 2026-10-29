/** Native instruction refreshes are context, not a new human task revision. */
export function isNativeAgentsMdContext(item: Record<string, unknown>): boolean {
  if (item.type !== "message" || item.role !== "user" || typeof item.id !== "string" || !item.id) return false;
  const metadata = item.internal_chat_message_metadata_passthrough as {
    turn_id?: unknown; content_item_kinds?: unknown;
  } | undefined;
  const kinds = metadata?.content_item_kinds;
  return typeof metadata?.turn_id === "string" && metadata.turn_id.trim().length > 0
    && Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => kind === "agents_md.instructions");
}

/** Only native provenance makes a Page item contextual. */
export function isNativeOpenPageContext(item: Record<string, unknown> | undefined): boolean {
  if (item?.type !== "message" || item.role !== "user" || typeof item.id !== "string" || !item.id) return false;
  const kindsClaim = (item.internal_chat_message_metadata_passthrough as { content_item_kinds?: unknown } | undefined)?.content_item_kinds;
  if (Array.isArray(kindsClaim) && kindsClaim.includes("additional_content.codex_apps_open_page")
    && Array.isArray(item.content) && item.content.length !== 1) {
    throw new Error("Native Page context must contain exactly one content part");
  }
  const content = item.content;
  const part = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
  const text = typeof content === "string" ? content : part?.type === "input_text" || part?.type === "text" ? part.text : undefined;
  if (typeof text !== "string" || !/^<external_codex_apps_open_page>[\s\S]*<\/external_codex_apps_open_page>$/.test(text.trim())) return false;
  const metadata = item.internal_chat_message_metadata_passthrough as { turn_id?: unknown; content_item_kinds?: unknown } | undefined;
  const kinds = metadata?.content_item_kinds;
  return typeof metadata?.turn_id === "string" && metadata.turn_id.trim().length > 0
    && Array.isArray(kinds) && kinds.length === 1 && kinds[0] === "additional_content.codex_apps_open_page";
}

/** The desktop injects cross-chat input without a matching model tool call. */
export function readNativeThreadDelegation(item: Record<string, unknown>): {
  sourceThreadId: string; output: string;
} | undefined {
  const metadata = item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined;
  if (item.type !== "function_call_output" || item.name !== "send_message_to_thread"
    || item.namespace !== "codex_app" || item.call_id !== undefined
    || typeof item.id !== "string" || !item.id
    || typeof metadata?.turn_id !== "string" || !metadata.turn_id.trim()
    || typeof item.output !== "string") return undefined;
  const fields = /^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([^<>]+)<\/input>\s*<\/codex_delegation>$/.exec(item.output.trim());
  if (!fields || !fields.slice(1).every(text => text.trim() && !/&(?!amp;|lt;|gt;)/.test(text))) return undefined;
  // Decode the producer's XML escapes once, preserving literal escaped strings.
  const decode = (text: string) => text.replace(/&(amp|lt|gt);/g, (_, name: string) =>
    ({ amp: "&", lt: "<", gt: ">" })[name]!);
  return { sourceThreadId: decode(fields[1]!), output: item.output };
}
