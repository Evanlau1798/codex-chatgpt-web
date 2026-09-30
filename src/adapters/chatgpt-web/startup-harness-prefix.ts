/** An unsent warm page may contain stable harness instructions, never old turn/history data. */
export function chatGptStartupHarnessPrefix(text: string): string | undefined {
  const marker = "<codex_context_json>\n";
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const end = text.indexOf("\n</codex_context_json>", start + marker.length);
  if (end < 0) return undefined;
  try {
    const context = JSON.parse(text.slice(start + marker.length, end));
    if (context?.version !== 3 || !Array.isArray(context.system) || !Array.isArray(context.messages)) return undefined;
    const archive = text.indexOf("<codex_context_archive>\n");
    const prefix = archive >= 0 && archive < start ? text.slice(0, archive)
      : text.slice(0, start + marker.length)
        + JSON.stringify({ version: 3, system: context.system }).slice(0, -1) + ',"messages":';
    // Do not cache a per-turn capability hidden in a different contract or system instruction.
    if (!prefix || /\b(?:turn|control|context)_[A-Za-z0-9_-]{16,}\b/u.test(prefix)
      || !text.startsWith(prefix)) return undefined;
    return prefix;
  } catch { return undefined; }
}
