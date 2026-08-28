import { ok as assert } from "node:assert";
import type { AppConfig } from "../../src/config";
import { preferredClaudeGatewayModelIds } from "../../src/messages/models";

type ClaudeSmokeSettings = Record<string, any>;

export function buildClaudeSmokeSettings(config: AppConfig): ClaudeSmokeSettings {
  const availableModels = preferredClaudeGatewayModelIds(config);
  const hook = {
    hooks: [{
      type: "http",
      url: `http://${config.host}:${config.port}/v1/messages/steering`,
      timeout: 5,
      headers: { Authorization: "Bearer $CODEX_CHATGPT_WEB_CONTROL_TOKEN" },
      allowedEnvVars: ["CODEX_CHATGPT_WEB_CONTROL_TOKEN"],
    }],
  };
  return {
    model: availableModels[0],
    availableModels,
    enforceAvailableModels: true,
    env: {
      ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
      ANTHROPIC_AUTH_TOKEN: "codex-chatgpt-web-local",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    },
    hooks: Object.fromEntries([
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
    ].map(event => [event, [hook]])),
  };
}

export function selfTestClaudeSmokeSettings(config: AppConfig): void {
  const settings = buildClaudeSmokeSettings(config);
  assert(
    settings.env?.ANTHROPIC_BASE_URL === `http://${config.host}:${config.port}`,
    "Claude smoke settings must target the live project route instead of the user global gateway",
  );
  assert(
    !JSON.stringify(settings).includes(config.controlToken)
      && settings.env?.ANTHROPIC_AUTH_TOKEN === "codex-chatgpt-web-local",
    "Claude smoke settings must not persist the live control credential",
  );
  assert(
    settings.availableModels?.every?.((model: unknown) => (
      typeof model === "string" && model.startsWith("claude-chatgpt-web-")
    )) === true && settings.availableModels.includes(settings.model),
    "Claude smoke settings must expose only the live Claude Web gateway models",
  );
  assert(
    ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"].every(event => (
      settings.hooks?.[event]?.[0]?.hooks?.[0]?.url
        === `http://${config.host}:${config.port}/v1/messages/steering`
    )),
    "Claude smoke settings must install every managed steering hook on the live route",
  );
}
