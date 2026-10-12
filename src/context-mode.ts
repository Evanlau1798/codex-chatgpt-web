export function effectiveExperimentalBiggerContext(
  useEnhancedWebSessionMode: boolean,
  experimentalBiggerContext: boolean,
): boolean {
  return !useEnhancedWebSessionMode && experimentalBiggerContext;
}

export function effectiveExperimentalPlusNativeContext(config: {
  useEnhancedWebSessionMode?: boolean;
  browserInteractionMode?: "automatic" | "manual";
  solAvailable?: boolean;
  proAvailable?: boolean;
  experimentalPlusNativeContext?: boolean;
}): boolean {
  return config.experimentalPlusNativeContext === true && config.useEnhancedWebSessionMode === true
    && config.browserInteractionMode !== "manual" && config.solAvailable === true && config.proAvailable === false;
}
