import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expandUserPath } from "../../config";
import { releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import type { CodexProviderConfig } from "../../types";
import { effectiveExperimentalBiggerContext } from "../../context-mode";
import type { ChatGptWebCapabilities } from "./model";
import type { CompileChatGptWebPromptOptions } from "./prompt";

export function chatGptAdapterRuntimeConfig(provider: CodexProviderConfig): {
  timeoutMs: number | undefined;
  useEnhancedWebSessionMode: boolean;
  useEnhancedOutputTunnel: boolean;
  experimentalBiggerContext: boolean;
  configuredCapabilities: ChatGptWebCapabilities;
  executionNamespace: string;
} {
  const useEnhancedWebSessionMode = provider.chatgptWeb?.useEnhancedWebSessionMode === true;
  return {
    timeoutMs: provider.chatgptWeb?.turnTimeoutMs,
    useEnhancedWebSessionMode,
    useEnhancedOutputTunnel: provider.chatgptWeb?.useEnhancedOutputTunnel !== false,
    experimentalBiggerContext: effectiveExperimentalBiggerContext(
      useEnhancedWebSessionMode,
      provider.chatgptWeb?.experimentalBiggerContext === true,
    ),
    configuredCapabilities: {
      localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
      solAvailable: provider.chatgptWeb?.solAvailable !== false,
      proAvailable: provider.chatgptWeb?.proAvailable === true,
    },
    executionNamespace: createHash("sha256").update(JSON.stringify({
      baseUrl: provider.baseUrl,
      chatgptWeb: provider.chatgptWeb ?? {},
    })).digest("hex"),
  };
}

export function chatGptAutomaticUsagePromptOptions(
  config: Pick<ReturnType<typeof chatGptAdapterRuntimeConfig>,
    "useEnhancedWebSessionMode" | "useEnhancedOutputTunnel" | "configuredCapabilities">,
  manualInteraction: boolean,
): Pick<CompileChatGptWebPromptOptions, "nativeControlConnector" | "useEnhancedOutputTunnel"> {
  return !manualInteraction && config.useEnhancedWebSessionMode
    && config.configuredCapabilities.localToolsEnabled
    ? {
        nativeControlConnector: true,
        ...(config.useEnhancedOutputTunnel ? { useEnhancedOutputTunnel: true } : {}),
      }
    : {};
}

export function retainedConversationRelease(
  provider: CodexProviderConfig,
  conversationKey: string | undefined,
): (() => Promise<void>) | undefined {
  const configuredPath = provider.chatgptWeb?.browserHost === "launcher"
    ? provider.chatgptWeb.browserHostDescriptorPath
    : undefined;
  if (!conversationKey || !configuredPath) return undefined;
  const descriptorPath = resolve(expandUserPath(configuredPath));
  return async () => {
    try {
      const released = await releaseLauncherRetainedConversation(descriptorPath, conversationKey);
      console.info(`[chatgpt-web] released superseded retained conversation surfaces=${released}`);
    } catch (error) {
      console.warn(`[chatgpt-web] retained conversation release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
