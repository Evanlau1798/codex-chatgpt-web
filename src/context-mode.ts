export function effectiveExperimentalBiggerContext(
  useEnhancedWebSessionMode: boolean,
  experimentalBiggerContext: boolean,
): boolean {
  return !useEnhancedWebSessionMode && experimentalBiggerContext;
}
