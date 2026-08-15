import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expandUserPath } from "../../config";
import { releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import type { CodexProviderConfig } from "../../types";
import type { ChatGptWebCapabilities } from "./model";

export function chatGptAdapterRuntimeConfig(provider: CodexProviderConfig): {
  timeoutMs: number | undefined;
  useEnhancedWebSessionMode: boolean;
  configuredCapabilities: ChatGptWebCapabilities;
  executionNamespace: string;
} {
  return {
    timeoutMs: provider.chatgptWeb?.turnTimeoutMs,
    useEnhancedWebSessionMode: provider.chatgptWeb?.useEnhancedWebSessionMode === true,
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
