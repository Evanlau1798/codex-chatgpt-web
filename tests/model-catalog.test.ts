import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  resolveChatGptWebContextLimits,
} from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";

function source(): Record<string, unknown> {
  return {
    models: [
      { slug: "gpt-5.5", display_name: "5.5", priority: 1, multi_agent_version: "disabled" },
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        base_instructions: "native harness",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium native" },
          { effort: "high", description: "High native" },
          { effort: "xhigh", description: "Extra high native" },
        ],
        tool_mode: "code_mode_only",
        use_responses_lite: true,
        prefer_websockets: true,
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-compaction-contract",
        additional_speed_tiers: [{ id: "fast" }],
        service_tiers: [{ id: "fast", name: "Fast" }],
        default_service_tier: "fast",
      },
      { slug: "gpt-5.6-terra", display_name: "5.6 Terra", priority: 3, multi_agent_version: "v2" },
    ],
  };
}

describe("native /models augmentation", () => {
  test("preserves every native model in order and appends one fixed model per ChatGPT Web mode", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    config.proAvailable = true;
    const result = augmentNativeModelCatalog(native, config);
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual(originalModels);
    const web = models.slice(3);
    expect(web.map(model => model.slug)).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug));
    expect(web.map(model => model.display_name)).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.displayName));
    for (const [index, model] of web.entries()) {
      const route = CHATGPT_WEB_MODEL_ROUTES[index]!;
      const limits = resolveChatGptWebContextLimits(
        route.backendModel,
        route.adapterEffort,
        config,
        config.useEnhancedWebSessionMode,
      );
      expect(model).toMatchObject({
        slug: route.slug,
        display_name: route.displayName,
        tool_mode: null,
        use_responses_lite: false,
        supports_search_tool: true,
        prefer_websockets: false,
        default_reasoning_level: route.codexEffort,
        supported_reasoning_levels: [{ effort: route.codexEffort, description: route.displayName }],
        multi_agent_version: "v2",
        supported_in_api: true,
        priority: 2,
        context_window: limits.contextWindow,
        max_context_window: limits.contextWindow,
        effective_context_window_percent: limits.effectiveContextWindowPercent,
        auto_compact_token_limit: limits.autoCompactTokenLimit,
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
      });
      expect(model).not.toHaveProperty("comp_hash");
    }
  });

  test("keeps the original compact threshold available when enhanced mode is disabled", () => {
    const originalConfig = defaultConfig("full");
    originalConfig.useEnhancedWebSessionMode = false;
    originalConfig.proAvailable = true;
    const original = augmentNativeModelCatalog(source(), originalConfig).models as Array<Record<string, unknown>>;
    const betaConfig = { ...originalConfig, useEnhancedWebSessionMode: true };
    const beta = augmentNativeModelCatalog(source(), betaConfig).models as Array<Record<string, unknown>>;
    const originalPro = original.find(model => model.slug === "chatgpt-web/pro");
    const betaPro = beta.find(model => model.slug === "chatgpt-web/pro");

    expect(originalPro?.auto_compact_token_limit).toBe(95_000);
    expect(betaPro?.auto_compact_token_limit).toBe(244_800);
    expect(betaPro?.effective_context_window_percent).toBe(90);
  });

  test("keeps native Sol selectable in the bounded Compatibility V1 registry", () => {
    const config = defaultConfig("full");
    config.subagentProtocol = "compatibility-v1";
    config.proAvailable = true;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const parent = models.find(model => model.slug === "gpt-5.6-sol")!;
    expect(parent.multi_agent_version).toBe("v1");
    const spawnOverrides = models
      .filter(model => model.supported_in_api === true && model.visibility === "list")
      .filter(model => model.multi_agent_version === "v1")
      .toSorted((left, right) => Number(left.priority) - Number(right.priority))
      .slice(0, 5)
      .map(model => model.slug);
    expect(spawnOverrides).toEqual([
      "gpt-5.6-sol",
      ...CHATGPT_WEB_MODEL_ROUTES.slice(1).map(route => route.slug),
    ]);
    expect(models.find(model => model.slug === "chatgpt-web/light")?.priority).toBe(3);
  });

  test("Compatibility V1 preserves an explicit native delegation disable while pinning supported rows", () => {
    const config = defaultConfig("full");
    config.subagentProtocol = "compatibility-v1";
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    expect(models.find(model => model.slug === "gpt-5.5")?.multi_agent_version).toBe("disabled");
    expect(models.find(model => model.slug === "gpt-5.6-sol")?.multi_agent_version).toBe("v1");
    expect(models.find(model => model.slug === "gpt-5.6-terra")?.multi_agent_version).toBe("v1");
  });

  test("advertises deferred tool discovery only for enhanced Web sessions", () => {
    const config = defaultConfig("full");
    config.useEnhancedWebSessionMode = false;
    config.proAvailable = true;
    const native = source();
    const nativeCount = (native.models as unknown[]).length;
    const original = augmentNativeModelCatalog(native, config).models as Array<Record<string, unknown>>;
    const enhanced = augmentNativeModelCatalog(native, {
      ...config,
      useEnhancedWebSessionMode: true,
    }).models as Array<Record<string, unknown>>;

    expect(original.slice(nativeCount).every(model => model.supports_search_tool === false)).toBeTrue();
    expect(enhanced.slice(nativeCount).every(model => model.supports_search_tool === true)).toBeTrue();
  });

  test("keeps native model capabilities identical in both Web session modes", () => {
    const native = source();
    const expected = structuredClone(native.models as Array<Record<string, unknown>>);
    for (const useEnhancedWebSessionMode of [false, true]) {
      const config = { ...defaultConfig("full"), subagentProtocol: "native" as const, useEnhancedWebSessionMode };
      const models = augmentNativeModelCatalog(native, config).models as Array<Record<string, unknown>>;
      expect(models.slice(0, expected.length)).toEqual(expected);
    }
  });

  test("native protocol mode preserves official native rows and gives Web rows the template surface", () => {
    const native = source();
    const snapshot = structuredClone(native);
    const nativeModels = snapshot.models as Array<Record<string, unknown>>;
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    config.proAvailable = true;

    const models = augmentNativeModelCatalog(native, config).models as Array<Record<string, unknown>>;
    expect(models.slice(0, nativeModels.length)).toEqual(nativeModels);
    expect(models.slice(nativeModels.length).every(model => model.multi_agent_version === "v2")).toBe(true);
    const spawnOverrides = models
      .filter(model => model.supported_in_api === true && model.visibility === "list")
      .filter(model => model.multi_agent_version === "v2")
      .toSorted((left, right) => Number(left.priority) - Number(right.priority))
      .slice(0, 5)
      .map(model => model.slug);
    expect(spawnOverrides).toContain("gpt-5.6-sol");
  });

  test("owns only its namespace, is idempotent, and omits Pro-only modes when unavailable", () => {
    const config = defaultConfig("browser-only");
    config.subagentProtocol = "native";
    config.proAvailable = false;
    const polluted = source();
    (polluted.models as unknown[]).push(
      { slug: "chatgpt-web/gpt-5.6-sol", display_name: "legacy generic route" },
      { slug: "chatgpt-web/pro", display_name: "stale Pro route" },
    );
    const first = augmentNativeModelCatalog(polluted, config);
    const second = augmentNativeModelCatalog(first, config);
    const models = second.models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.map(model => model.slug)).toEqual(
      CHATGPT_WEB_MODEL_ROUTES.filter(route => !route.requiresPro).map(route => route.slug),
    );
    expect(web.every(model => model.tool_mode === null)).toBe(true);
    expect(web.every(model => model.multi_agent_version === "v2")).toBe(true);
    expect(web.every(model => (model.supported_reasoning_levels as unknown[]).length === 1)).toBe(true);
    expect(web.map(model => ({
      contextWindow: model.context_window,
      effectiveContextWindowPercent: model.effective_context_window_percent,
      autoCompactTokenLimit: model.auto_compact_token_limit,
    }))).toEqual([
      { contextWindow: 41_000, effectiveContextWindowPercent: 78, autoCompactTokenLimit: 32_000 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 80_000 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 80_000 },
    ]);
  });

  test("publishes Luna and Think routes when the account exposes no Sol selector", () => {
    const config = defaultConfig("full");
    config.solAvailable = false;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web).toHaveLength(2);
    expect(web.map(model => model.slug)).toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES.map(route => route.slug));
    expect(web[0]).toMatchObject({
      slug: CHATGPT_WEB_LUNA_MODEL_ROUTE.slug,
      display_name: CHATGPT_WEB_LUNA_MODEL_ROUTE.displayName,
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: CHATGPT_WEB_LUNA_MODEL_ROUTE.displayName }],
      context_window: 1_050_000,
      effective_context_window_percent: 100,
      auto_compact_token_limit: 1_050_000,
    });
  });

  test("Zero Risk publishes exactly one generic model without capability inference", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    config.solAvailable = false;
    config.proAvailable = false;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));

    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({
      slug: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug,
      display_name: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName,
      description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.description,
      input_modalities: ["text"],
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName }],
      context_window: CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      max_context_window: CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      effective_context_window_percent: 78,
      auto_compact_token_limit: 96_000,
    });

    config.zeroRiskProEnabled = true;
    const proModels = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const proWeb = proModels.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(proWeb).toHaveLength(2);
    expect(proWeb[1]).toMatchObject({
      slug: CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE.slug,
      display_name: CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE.displayName,
      input_modalities: ["text"],
      context_window: 336_579,
      auto_compact_token_limit: 285_000,
    });
  });

  test("raises only native maximum windows for an explicit Codex context override", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    const result = augmentNativeModelCatalog(native, config, {
      contextWindow: 371_851,
    });
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual([
      { ...originalModels[0], max_context_window: 371_851 },
      { ...originalModels[1], max_context_window: 371_851 },
      { ...originalModels[2], max_context_window: 371_851 },
    ]);
    expect(models[1]!.context_window).toBe(300_000);
    expect(models[1]!.auto_compact_token_limit).toBe(270_000);
    for (const [index, model] of models.slice(3).entries()) {
      const route = CHATGPT_WEB_MODEL_ROUTES[index]!;
      const limits = resolveChatGptWebContextLimits(
        route.backendModel,
        route.adapterEffort,
        config,
      );
      expect(model.context_window).toBe(limits.contextWindow);
      expect(model.max_context_window).toBe(limits.contextWindow);
      expect(model.effective_context_window_percent).toBe(limits.effectiveContextWindowPercent);
      expect(model.auto_compact_token_limit).toBe(limits.autoCompactTokenLimit);
    }
  });

  test("never lowers a native window that already exceeds the Codex context override", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models[1]!.max_context_window = 1_000_000;
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      contextWindow: 371_851,
    });

    const overridden = (result.models as Array<Record<string, unknown>>)[1]!;
    expect(overridden.context_window).toBe(300_000);
    expect(overridden.max_context_window).toBe(1_000_000);
    expect(overridden.auto_compact_token_limit).toBe(270_000);
  });

  test("uses an available compatible official model when an account exposes a smaller catalog", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models.splice(1, 1);
    Object.assign(models[1]!, {
      visibility: "list",
      supported_in_api: true,
      tool_mode: "code_mode_only",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      shell_type: "shell_command",
    });

    const config = defaultConfig("full");
    config.useEnhancedWebSessionMode = false;
    const result = augmentNativeModelCatalog(native, config);
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.length).toBe(3);
    expect(web.every(model => model.shell_type === "shell_command")).toBe(true);
    expect(web.every(model => model.tool_mode === null)).toBe(true);
    expect(web.every(model => model.use_responses_lite === false)).toBe(true);
    expect(web.every(model => model.supports_search_tool === false)).toBe(true);
    expect(web.every(model => model.prefer_websockets === false)).toBe(true);
  });

  test("uses a ChatGPT-visible template even when it is not available to API-key auth", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    for (const model of models) model.supported_in_api = false;

    const config = defaultConfig("browser-only");
    config.subagentProtocol = "native";
    const result = augmentNativeModelCatalog(native, config);
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));

    expect(web).toHaveLength(3);
    expect(web.every(model => model.supported_in_api === true)).toBe(true);
    expect((result.models as Array<Record<string, unknown>>).slice(0, models.length))
      .toEqual(models);
  });

  test("follows official catalog order instead of preferring a named paid-tier model", () => {
    const native = source();
    const sourceModels = native.models as Array<Record<string, unknown>>;
    const sol = sourceModels[1]!;
    const terra = {
      ...structuredClone(sol),
      slug: "gpt-5.6-terra",
      display_name: "5.6 Terra",
      shell_type: "terra-shell",
    };
    native.models = [sourceModels[0], terra, sol];

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.every(model => model.shell_type === "terra-shell")).toBe(true);
  });

  test("fails closed when no official model satisfies the harness contract", () => {
    expect(() => augmentNativeModelCatalog({
      models: [{
        slug: "other",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: null,
      }],
    }, defaultConfig("full"))).toThrow("no list-visible, tool-capable model");
  });
});
