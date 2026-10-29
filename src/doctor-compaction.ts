import { existsSync, readFileSync } from "node:fs";
import type { AppConfig } from "./config";
import type { DoctorCheck } from "./doctor";
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "./chatgpt-web-models";

/** Inspect saved settings only: CLI and project-level overrides belong to the running Codex task. */
export function inspectCodexCompaction(config: AppConfig, configPath: string): DoctorCheck[] {
  if (!existsSync(configPath)) return [];
  try {
    const document = Bun.TOML.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, any>;
    const profileName = document.profile;
    let settings = document;
    if (profileName !== undefined) {
      const profile = typeof profileName === "string" ? document.profiles?.[profileName] : undefined;
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new Error("The configured default profile could not be read");
      }
      settings = { ...document, ...profile };
    }
    const limit = settings.model_auto_compact_token_limit;
    if (limit === undefined) return [];
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("model_auto_compact_token_limit must be a positive integer");
    }
    const context = settings.model_context_window;
    if (context !== undefined && (!Number.isSafeInteger(context) || context <= 0)) {
      throw new Error("model_context_window must be a positive integer");
    }
    const available = availableChatGptWebModelRoutes(config, true);
    const selected = available.find(route => route.slug === settings.model);
    const affected = (selected ? [selected] : available).flatMap(route => {
      const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
        config.useEnhancedWebSessionMode === true,
        route.interactionMode === "automatic" ? route.modelFamily : undefined);
      const threshold = Math.min(limits.autoCompactTokenLimit, context ?? limits.contextWindow);
      return limit > threshold ? [`${route.slug}: ${threshold} tokens`] : [];
    });
    if (affected.length === 0) return [];
    return [{
      id: "codex-compaction", status: "warning",
      message: "Custom Codex compaction limit exceeds Web model limits",
      detail: `model_auto_compact_token_limit=${limit} overrides the model's advertised compaction threshold. `
        + `Affected limits: ${affected.slice(0, 3).join("; ")}${affected.length > 3 ? `; and ${affected.length - 3} more models` : ""}. `
        + `Remove that override from ${configPath}${profileName ? ` (default profile ${JSON.stringify(profileName)})` : ""} `
        + "to use per-model defaults, then restart Codex. Also check model_context_window if you set it. "
        + "Command-line and project configuration overrides are not inspected here.",
    }];
  } catch {
    return [{ id: "codex-compaction", status: "warning", message: "Codex compaction settings could not be checked",
      detail: "Check config.toml syntax, the default profile, and positive integer model_auto_compact_token_limit/model_context_window values. No settings were changed." }];
  }
}
