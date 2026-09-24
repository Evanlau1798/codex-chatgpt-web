import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";

function marked(text: string, start: string, end: string): boolean {
  const trimmed = text.trim();
  return trimmed.slice(0, start.length).toLowerCase() === start
    && trimmed.slice(-end.length).toLowerCase() === end;
}

function singleEnvelope(text: string, whole: RegExp, tags: RegExp): boolean {
  const trimmed = text.trim();
  return whole.test(trimmed) && (trimmed.match(tags)?.length ?? 0) === 2;
}

/** Native context is delivered as its own text part; prose may mention the tag literally. */
export function hasEnvironmentContextAttempt(content: unknown): boolean {
  const texts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.flatMap(part => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
        ? [value.text] : [];
    }) : [];
  return texts.some(text => /^<\/?environment_context\b/i.test(text.trim()));
}

export function hasEnvironmentContextFragment(item: Record<string, unknown> | undefined): item is Record<string, unknown> {
  if (item?.type !== "message" || (item.role !== "user" && item.role !== "developer")) return false;
  const metadata = item.internal_chat_message_metadata_passthrough;
  const kinds = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).content_item_kinds : undefined;
  return (Array.isArray(kinds) && kinds.includes("environments.environment_context"))
    || hasEnvironmentContextAttempt(item.content);
}

export function isContextualCodexUserText(text: string): boolean {
  const trimmed = text.trim();
  return marked(trimmed, "# agents.md instructions", "</instructions>")
    || marked(trimmed, "<environment_context>", "</environment_context>")
    || /^<external_([^>]+)>[\s\S]*<\/external_\1>$/.test(trimmed)
    || marked(trimmed, "<skill>", "</skill>")
    || marked(trimmed, "<user_shell_command>", "</user_shell_command>")
    || marked(trimmed, "<turn_aborted>", "</turn_aborted>")
    || marked(trimmed, "<subagent_notification>", "</subagent_notification>")
    || /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/.test(trimmed)
    || marked(trimmed, "<goal_context>", "</goal_context>")
    || marked(trimmed, "<recommended_plugins>", "</recommended_plugins>")
    || /^<hook_prompt hook_run_id="[^"]+">[\s\S]*<\/hook_prompt>$/.test(trimmed)
    || trimmed.startsWith("Warning: The maximum number of unified exec processes you can keep open is")
    || (trimmed.startsWith("Warning: apply_patch was requested via ")
      && trimmed.endsWith("Use the apply_patch tool instead of exec_command."))
    || trimmed.startsWith("Warning: Your account was flagged for potentially high-risk cyber activity")
    || isReadableCompactionSummaryText(trimmed)
    || trimmed === OPAQUE_COMPACTION_NOTE;
}

/** Trust-boundary variant: one complete native context shape, with no appended user steering. */
export function isPureContextualCodexUserText(text: string): boolean {
  const trimmed = text.trim();
  if (/^# agents\.md instructions(?: for [^\r\n]+)?\r?\n\s*<instructions>[\s\S]*<\/instructions>$/i.test(trimmed)) {
    return (trimmed.match(/<\/?instructions>/gi)?.length ?? 0) === 2;
  }
  if (singleEnvelope(trimmed, /^<environment_context>[\s\S]*<\/environment_context>$/i, /<\/?environment_context>/gi)
    || singleEnvelope(trimmed, /^<skill>[\s\S]*<\/skill>$/i, /<\/?skill>/gi)
    || singleEnvelope(trimmed, /^<user_shell_command>[\s\S]*<\/user_shell_command>$/i, /<\/?user_shell_command>/gi)
    || singleEnvelope(trimmed, /^<turn_aborted>[\s\S]*<\/turn_aborted>$/i, /<\/?turn_aborted>/gi)
    || singleEnvelope(trimmed, /^<subagent_notification>[\s\S]*<\/subagent_notification>$/i, /<\/?subagent_notification>/gi)
    || singleEnvelope(trimmed, /^<goal_context>[\s\S]*<\/goal_context>$/i, /<\/?goal_context>/gi)
    || singleEnvelope(trimmed, /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/i, /<\/?recommended_plugins>/gi)
    || singleEnvelope(
      trimmed,
      /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/,
      /<\/?codex_internal_context(?:\s+source="[a-z][a-z0-9_]*")?>/g,
    )
    || singleEnvelope(trimmed, /^<hook_prompt hook_run_id="[^"]+">[\s\S]*<\/hook_prompt>$/, /<\/?hook_prompt(?:\s+hook_run_id="[^"]+")?>/g)) {
    return true;
  }
  const external = /^<external_([^>]+)>[\s\S]*<\/external_\1>$/.exec(trimmed);
  if (external) {
    const root = external[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if ((trimmed.match(new RegExp(`<\\/?external_${root}>`, "g"))?.length ?? 0) === 2) return true;
  }
  return isReadableCompactionSummaryText(trimmed) || trimmed === OPAQUE_COMPACTION_NOTE;
}

export function isContextualCodexUserMessage(content: unknown): boolean {
  if (typeof content === "string") return isContextualCodexUserText(content);
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some(part => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
    const value = part as Record<string, unknown>;
    return (value.type === "input_text" || value.type === "text")
      && typeof value.text === "string"
      && isContextualCodexUserText(value.text);
  });
}
