import type { AppConfig } from "./config-interaction";

export function validateExperimentalFeatures(parsed: Partial<AppConfig>, path: string): void {
  for (const feature of ["experimentalBiggerContext", "experimentalSkillAttachments",
    "experimentalComposerPlainText", "experimentalNoAutoCompact", "experimentalParallelSubagents"] as const) {
    if (parsed[feature] !== undefined && typeof parsed[feature] !== "boolean") {
      throw new Error(`Invalid ${feature} in ${path}`);
    }
  }
  if (parsed.experimentalParallelSubagents === true && parsed.maxBrowserTabs !== undefined && parsed.maxBrowserTabs < 4) {
    throw new Error("Parallel subagents require at least four browser slots, including compaction reserve");
  }
}
