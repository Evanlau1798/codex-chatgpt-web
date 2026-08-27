import { readFileSync } from "node:fs";
import type { LauncherEvent } from "./launcher-event-reader";
import { findClaudeTranscript } from "./paths";

export function claudeCompactions(configDir: string, sessionId: string, trigger: "auto" | "manual") {
  let path: string;
  try { path = findClaudeTranscript(configDir, sessionId); } catch { return 0; }
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return 0; }
  return new Set(text.split(/\r?\n/).flatMap(line => {
    try {
      const record = JSON.parse(line) as Record<string, any>;
      return record.type === "system" && record.subtype === "compact_boundary"
        && record.compactMetadata?.trigger === trigger ? [String(record.uuid ?? record.timestamp)] : [];
    } catch { return []; }
  })).size;
}

export function claudeLaneSurfaceCountIsExact(
  launcher: LauncherEvent[],
  safeRecoveries: number,
  childTab: string,
): boolean {
  const creates = launcher.filter(value => value.event === "browser.tab_created" && value.detail?.tabId);
  const createdTabs = new Set(creates.map(value => String(value.detail!.tabId)));
  const childResumes = launcher.filter(value => value.event === "browser.tab_reused"
    && value.detail?.tabId === childTab);
  return creates.length === 5 + safeRecoveries
    && createdTabs.size === creates.length
    && childResumes.length === 1;
}
