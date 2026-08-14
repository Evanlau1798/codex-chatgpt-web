import type { AppConfig } from "../config";
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "../chatgpt-web-models";

const CLAUDE_GATEWAY_MODEL_PREFIX = "claude-chatgpt-web-";

export interface ClaudeGatewayModel {
  id: string;
  display_name: string;
  max_input_tokens: number;
}

export function claudeGatewayModelId(routeSlug: string): string {
  return `${CLAUDE_GATEWAY_MODEL_PREFIX}${routeSlug.slice("chatgpt-web/".length)}`;
}

export function resolveClaudeGatewayModelId(modelId: string): string | undefined {
  return modelId.startsWith(CLAUDE_GATEWAY_MODEL_PREFIX)
    ? `chatgpt-web/${modelId.slice(CLAUDE_GATEWAY_MODEL_PREFIX.length)}`
    : undefined;
}

export function claudeGatewayModels(config: AppConfig): ClaudeGatewayModel[] {
  return availableChatGptWebModelRoutes(config).map(route => ({
    id: claudeGatewayModelId(route.slug),
    display_name: route.displayName,
    max_input_tokens: resolveChatGptWebContextLimits(
      route.backendModel,
      route.adapterEffort,
      config,
      config.useEnhancedWebSessionMode,
    ).contextWindow,
  }));
}

export function preferredClaudeGatewayModelIds(config: AppConfig): string[] {
  const models = claudeGatewayModels(config);
  const preferred = models.find(model => model.id.endsWith(config.solAvailable ? "-high" : "-luna"));
  return preferred ? [preferred.id, ...models.filter(model => model !== preferred).map(model => model.id)] : models.map(model => model.id);
}

export function isClaudeGatewayModelsRequest(request: Request): boolean {
  return new URL(request.url).searchParams.get("limit") === "1000";
}

export function claudeGatewayModelsResponse(config: AppConfig): Response {
  return Response.json({ data: claudeGatewayModels(config) });
}
