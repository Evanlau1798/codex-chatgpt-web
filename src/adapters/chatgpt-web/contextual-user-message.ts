import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";

function marked(text: string, start: string, end: string): boolean {
  const trimmed = text.trim();
  return trimmed.slice(0, start.length).toLowerCase() === start
    && trimmed.slice(-end.length).toLowerCase() === end;
}

function contextualText(text: string): boolean {
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

export function isContextualCodexUserMessage(content: unknown): boolean {
  if (typeof content === "string") return contextualText(content);
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some(part => {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
    const value = part as Record<string, unknown>;
    return (value.type === "input_text" || value.type === "text")
      && typeof value.text === "string"
      && contextualText(value.text);
  });
}
