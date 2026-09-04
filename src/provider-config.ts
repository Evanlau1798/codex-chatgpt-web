import { join } from "node:path";
import { getConfigDir, type AppConfig } from "./config";
import type { CodexProviderConfig } from "./types";
import { effectiveExperimentalBiggerContext } from "./context-mode";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL } from "./chatgpt-web-models";

export function providerConfig(config: AppConfig): CodexProviderConfig {
  const manual = config.browserInteractionMode === "manual";
  const model = manual
    ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
    : config.solAvailable ? "gpt-5.6-sol" : "gpt-5.6-luna";
  const models = manual
    ? [
      CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
      ...(config.zeroRiskProEnabled ? [CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL] : []),
    ]
    : [model];
  const efforts = manual
    ? ["low"]
    : config.solAvailable
    ? ["low", "medium", "high", "xhigh", ...(config.proAvailable ? ["max"] : [])]
    : ["low", "medium"];
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: model,
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(models.map(model => [model, manual ? ["text"] : ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(models.map(modelId => [modelId, efforts])),
    modelDefaultReasoningEfforts: Object.fromEntries(
      models.map(modelId => [modelId, manual ? "low" : config.solAvailable ? "high" : "low"]),
    ),
    noReasoningModels: [],
    chatgptWeb: {
      appName: manual ? config.manualAppName : config.automaticAppName,
      browserInteractionMode: config.browserInteractionMode,
      browserHost: config.browserHost,
      browserHostDescriptorPath: config.browserHostDescriptorPath,
      storageStatePath: config.storageStatePath,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      lunaCheckpointStatePath: join(getConfigDir(), "runtime", "luna-checkpoints.json"),
      headed: config.headed,
      localToolsEnabled: config.mode === "full",
      solAvailable: manual ? false : config.solAvailable,
      proAvailable: manual ? false : config.proAvailable,
      useEnhancedWebSessionMode: config.useEnhancedWebSessionMode,
      experimentalBiggerContext: manual ? false : effectiveExperimentalBiggerContext(
        config.useEnhancedWebSessionMode, config.experimentalBiggerContext,
      ),
      ...(config.stallTimeoutSec !== undefined ? { stallTimeoutSec: config.stallTimeoutSec } : {}),
      autoApproveToolCalls: manual ? false : config.autoApproveToolCalls,
    },
  };
}
