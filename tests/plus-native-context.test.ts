import { expect, test } from "bun:test";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfig } from "../src/provider-config";
import { chatGptAdapterRuntimeConfig } from "../src/adapters/chatgpt-web/adapter-runtime-config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { CHATGPT_WEB_BACKEND_MODEL, resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";

const plus = { solAvailable: true, proAvailable: false, extraHighAvailable: true };
const enabled = { ...plus, experimentalPlusNativeContext: true };

test("Plus native context is opt-in and missing old preferences keep the standard window", () => {
  expect((defaultConfig() as { experimentalPlusNativeContext?: boolean }).experimentalPlusNativeContext).toBeFalse();
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus, true, "6"))
    .toMatchObject({ contextWindow: 90_000, autoCompactTokenLimit: 80_000 });
});

test("Plus preference roundtrips, old config defaults off and invalid types fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "plus-native-context-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const { experimentalPlusNativeContext: _flag, ...old } = defaultConfig();
    writeFileSync(join(root, "config.json"), JSON.stringify(old));
    expect(loadConfig().experimentalPlusNativeContext).toBeFalse();
    saveConfig({ ...defaultConfig(), experimentalPlusNativeContext: true, useEnhancedWebSessionMode: false });
    expect(loadConfig().experimentalPlusNativeContext).toBeTrue();
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...old, experimentalPlusNativeContext: "true" }));
    expect(loadConfig).toThrow("experimentalPlusNativeContext");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider and adapter share the Plus eligibility matrix without changing saved preference", () => {
  for (const enhanced of [false, true]) for (const manual of [false, true])
    for (const sol of [false, true]) for (const pro of [false, true]) {
      const config = { ...defaultConfig(), experimentalPlusNativeContext: true,
        useEnhancedWebSessionMode: enhanced, browserInteractionMode: manual ? "manual" as const : "automatic" as const,
        solAvailable: sol, proAvailable: pro };
      const provider = providerConfig(config);
      const effective = enhanced && !manual && sol && !pro;
      expect(provider.chatgptWeb?.experimentalPlusNativeContext).toBe(effective);
      expect(chatGptAdapterRuntimeConfig(provider).configuredCapabilities.experimentalPlusNativeContext).toBe(effective);
      expect(config.experimentalPlusNativeContext).toBeTrue();
    }
  const invalid = { ...providerConfig(defaultConfig()), chatgptWeb: { experimentalPlusNativeContext: "true" } };
  expect(() => chatGptAdapterRuntimeConfig(invalid as any)).toThrow("experimentalPlusNativeContext");
});

test("native catalog keeps No Context Window null and reasoning native budget aligned", () => {
  const config = { ...defaultConfig(), ...enabled, useEnhancedWebSessionMode: true };
  const source = { models: [{ slug: "gpt-6-sol", display_name: "native", supported_in_api: true, visibility: "list", supports_search_tool: true,
    supported_reasoning_levels: [{ effort: "high", description: "High" }] }] };
  const catalog = augmentNativeModelCatalog(source, config) as { models: Array<Record<string, unknown>> };
  const model = catalog.models.find(row => row.slug === "chatgpt-web/gpt-6-sol")!;
  expect(model).toMatchObject({ context_window: 256_000, auto_compact_token_limit: 230_400 });
  const unlimited = augmentNativeModelCatalog(source, { ...config, experimentalNoAutoCompact: true }) as typeof catalog;
  expect(unlimited.models.find(row => row.slug === model.slug)).toMatchObject({ context_window: null, auto_compact_token_limit: null });
});

test("Enhanced Plus native context covers available Sol reasoning families and legacy aliases", () => {
  for (const family of [undefined, "5.6", "6"] as const) for (const effort of ["medium", "high", "xhigh"] as const) {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, enabled, true, family))
      .toEqual({ contextWindow: 256_000, autoCompactTokenLimit: 230_400, effectiveContextWindowPercent: 90 });
  }
});

test("native context never enlarges Instant, Original, Pro or a single browser message", () => {
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", enabled, true, "6"))
    .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus, true, "6"));
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", enabled, false, "6"))
    .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus, false, "6"));
  const pro = { ...plus, proAvailable: true };
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", { ...pro, experimentalPlusNativeContext: true }, true, "6"))
    .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", pro, true, "6"));
  expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "high", enabled))
    .toEqual(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus));
  expect(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, "high", enabled))
    .toBe(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, "high", plus));
  expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", {
    ...enabled, extraHighAvailable: false,
  }, true, "6")).toThrow("unavailable effort");
});


test("setup toggles Plus preference and preserves it through unavailable modes", async () => {
  const { buildSetupConfig } = await import("../src/setup-config");
  const original = { ...defaultConfig("full"), browserHost: "launcher" as const, acknowledgedUnofficialAt: new Date(0).toISOString() };
  const enabled = buildSetupConfig(original, { mode: "full", experimentalPlusNativeContext: true });
  expect(enabled.experimentalPlusNativeContext).toBeTrue();
  const manual = buildSetupConfig(enabled, { mode: "full", browserInteractionMode: "manual" });
  expect(manual.experimentalPlusNativeContext).toBeTrue();
  expect(providerConfig(manual).chatgptWeb?.experimentalPlusNativeContext).toBeFalse();
  expect(buildSetupConfig(manual, { mode: "full", experimentalPlusNativeContext: false }).experimentalPlusNativeContext).toBeFalse();
});
