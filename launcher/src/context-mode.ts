interface BiggerContextSwitchInput {
  busy: boolean;
  coreSetupComplete: boolean;
  useEnhancedWebSessionMode: boolean;
  experimentalBiggerContext: boolean;
  browserInteractionMode?: "automatic" | "manual";
}

export function biggerContextSwitchState(input: BiggerContextSwitchInput): {
  checked: boolean;
  disabled: boolean;
} {
  return {
    checked: input.browserInteractionMode !== "manual" && !input.useEnhancedWebSessionMode && input.experimentalBiggerContext,
    disabled: input.browserInteractionMode === "manual" || input.busy || !input.coreSetupComplete || input.useEnhancedWebSessionMode,
  };
}
