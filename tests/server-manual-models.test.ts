import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { providerConfig } from "../src/provider-config";
import { modelsRequest } from "../src/server";
import { CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE } from "../src/chatgpt-web-models";

test.each([false, true])("manual model catalog requires explicit Pro enablement (%s)", async zeroRiskProEnabled => {
  const config = { ...defaultConfig("full"), browserInteractionMode: "manual" as const,
    zeroRiskProEnabled, proAvailable: true, solAvailable: true, experimentalBiggerContext: false,
    autoApproveToolCalls: true };
  const provider = providerConfig({ ...config, experimentalBiggerContext: true });
  const backendModels = ["chatgpt-web-zero-risk", ...(zeroRiskProEnabled ? ["chatgpt-web-zero-risk-pro"] : [])];
  expect(provider.models).toEqual(backendModels);
  expect(provider.defaultModel).toBe("chatgpt-web-zero-risk");
  expect(provider.chatgptWeb).toMatchObject({ browserInteractionMode: "manual", appName: config.manualAppName,
    solAvailable: false, proAvailable: false, experimentalBiggerContext: false, autoApproveToolCalls: false });
  for (const model of backendModels) {
    expect(provider.modelInputModalities?.[model]).toEqual(["text"]);
    expect(provider.modelReasoningEfforts?.[model]).toEqual(["low"]);
    expect(provider.modelDefaultReasoningEfforts?.[model]).toBe("low");
  }
  // The compatibility effort is not evidence of the user's model/effort selection on ChatGPT.
  const response = await modelsRequest(new Request("http://127.0.0.1:17841/v1/models", {
    headers: { authorization: "Bearer test-native-token" },
  }), config, async () => Response.json({ models: [{
    slug: "gpt-5.6-sol", display_name: "Sol", visibility: "list", supported_in_api: true,
    supported_reasoning_levels: [{ effort: "low", description: "Low" }], tool_mode: "code_mode_only",
  }] }));
  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<Record<string, unknown> & { slug: string }> };
  expect(body.models.map(model => model.slug)).toEqual([
    "gpt-5.6-sol", "chatgpt-web/zero-risk", ...(zeroRiskProEnabled ? ["chatgpt-web/zero-risk-pro"] : []),
  ]);
  expect(body.models[1]).toEqual({
    slug: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug,
    display_name: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName,
    description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.description,
    visibility: "list", supported_in_api: true,
    supported_reasoning_levels: [{ effort: "low", description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName }],
    tool_mode: null, upgrade: null, default_reasoning_level: "low", input_modalities: ["text"],
    context_window: 123_000, max_context_window: 123_000, effective_context_window_percent: 78,
    auto_compact_token_limit: 96_000, additional_speed_tiers: [], service_tiers: [],
    default_service_tier: null, multi_agent_version: "v1",
    prefer_websockets: false, use_responses_lite: false, supports_search_tool: true,
  });
});
