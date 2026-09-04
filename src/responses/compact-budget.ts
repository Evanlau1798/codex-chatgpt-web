import type { AppConfig } from "../config";
import { resolveChatGptWebContextLimits, type ChatGptWebModelRoute } from "../chatgpt-web-models";
import { estimateChatGptWebInputTokens } from "../adapters/chatgpt-web/usage";
import { parseRequest } from "./parser";
import { buildCompactV1Output, extractCompactUserMessages, latestCompactUserMessage } from "./compaction";

export class CompactionBudgetExceeded extends Error {
  constructor(readonly inputTokens: number, readonly tokenLimit: number) {
    super("Compaction cannot fit the latest instruction and summary within the model budget. "
      + "No replacement history was returned. Shorten the input before trying again.");
  }
}

/** At most two full prompt compilations: normal retention, then mandatory content only. */
export function boundedCompactV1Output(
  raw: Record<string, unknown>, summary: string, config: AppConfig, route: ChatGptWebModelRoute,
): Record<string, unknown>[] {
  const users = extractCompactUserMessages(raw.input);
  const limit = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
    config.useEnhancedWebSessionMode).autoCompactTokenLimit;
  const measure = (output: Record<string, unknown>[]) => {
    const parsed = parseRequest({ ...raw, previous_response_id: undefined, input: output });
    parsed.modelId = route.backendModel;
    parsed.options.reasoning = route.interactionMode === "automatic" ? route.adapterEffort : route.codexEffort;
    return estimateChatGptWebInputTokens(parsed, {
      localToolsEnabled: config.mode === "full",
      solAvailable: config.solAvailable, proAvailable: config.proAvailable,
    });
  };
  const output = buildCompactV1Output(users, summary);
  if (measure(output) < limit) return output;
  const latest = latestCompactUserMessage(users);
  const minimal = buildCompactV1Output(latest ? [latest] : [], summary);
  const inputTokens = measure(minimal);
  if (inputTokens < limit) return minimal;
  throw new CompactionBudgetExceeded(inputTokens, limit);
}
