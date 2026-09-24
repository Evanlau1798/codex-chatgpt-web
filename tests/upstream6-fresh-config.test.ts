import { expect, test } from "bun:test";
import { defaultConfig, providerConfig } from "../src/config";
import { chatGptAdapterRuntimeConfig } from "../src/adapters/chatgpt-web/adapter-runtime-config";

test("fresh-per-turn is opt-in and unavailable for Enhanced, including stale state", () => {
  const config = { ...defaultConfig(), experimentalFreshConversationPerTurn: true, useSavedChats: true };
  config.useEnhancedWebSessionMode = false;
  expect(providerConfig(config).chatgptWeb?.experimentalFreshConversationPerTurn).toBeTrue();
  expect(providerConfig(config).chatgptWeb?.useSavedChats).toBeTrue();
  config.useEnhancedWebSessionMode = true;
  expect(providerConfig(config).chatgptWeb?.experimentalFreshConversationPerTurn).toBeFalse();
  const stale = providerConfig(config);
  stale.chatgptWeb!.experimentalFreshConversationPerTurn = true;
  expect(chatGptAdapterRuntimeConfig(stale).experimentalFreshConversationPerTurn).toBeFalse();
  expect(stale.chatgptWeb!.useSavedChats).toBeTrue();
});

test("direct adapter rejects malformed fresh and saved settings", () => {
  for (const field of ["experimentalFreshConversationPerTurn", "useSavedChats"] as const) {
    const provider = providerConfig(defaultConfig());
    (provider.chatgptWeb as Record<string, unknown>)[field] = "true";
    expect(() => chatGptAdapterRuntimeConfig(provider)).toThrow("boolean");
  }
});
