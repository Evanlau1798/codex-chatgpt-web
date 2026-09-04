import { expect, test } from "bun:test";
import { chatGptAdapterRuntimeConfig } from "../src/adapters/chatgpt-web/adapter-runtime-config";
import { effectiveExperimentalBiggerContext } from "../src/context-mode";
import { biggerContextSwitchState } from "../launcher/src/context-mode";

test("Enhanced Web mode always disables Bigger Context at the adapter boundary", () => {
  expect(effectiveExperimentalBiggerContext(true, true)).toBeFalse();
  expect(effectiveExperimentalBiggerContext(false, true)).toBeTrue();
  expect(chatGptAdapterRuntimeConfig({
    adapter: "chatgpt-web",
    baseUrl: "browser://context-mode-test",
    chatgptWeb: {
      useEnhancedWebSessionMode: true,
      experimentalBiggerContext: true,
    },
  }).experimentalBiggerContext).toBeFalse();
});

test("Bigger Context switch is off and locked only while Enhanced Web mode is active", () => {
  expect(biggerContextSwitchState({
    busy: false,
    coreSetupComplete: true,
    useEnhancedWebSessionMode: true,
    experimentalBiggerContext: true,
  })).toEqual({ checked: false, disabled: true });
  expect(biggerContextSwitchState({
    busy: false,
    coreSetupComplete: true,
    useEnhancedWebSessionMode: false,
    experimentalBiggerContext: true,
  })).toEqual({ checked: true, disabled: false });
});

test("manual mode keeps Bigger Context off regardless of Enhanced or stale preferences", () => {
  for (const useEnhancedWebSessionMode of [false, true]) {
    expect(biggerContextSwitchState({
      busy: false, coreSetupComplete: true, useEnhancedWebSessionMode,
      experimentalBiggerContext: true, browserInteractionMode: "manual",
    })).toEqual({ checked: false, disabled: true });
  }
});
