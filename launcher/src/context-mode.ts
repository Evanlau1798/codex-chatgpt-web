interface BiggerContextSwitchInput {
  busy: boolean;
  coreSetupComplete: boolean;
  useEnhancedWebSessionMode: boolean;
  experimentalBiggerContext: boolean;
}

export function biggerContextSwitchState(input: BiggerContextSwitchInput): {
  checked: boolean;
  disabled: boolean;
} {
  return {
    checked: !input.useEnhancedWebSessionMode && input.experimentalBiggerContext,
    disabled: input.busy || !input.coreSetupComplete || input.useEnhancedWebSessionMode,
  };
}
