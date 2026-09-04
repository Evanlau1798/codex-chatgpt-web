function normalizeContextModes(config) {
  if (config?.useEnhancedWebSessionMode !== true || config.experimentalBiggerContext !== true) {
    return config;
  }
  return { ...config, experimentalBiggerContext: false };
}

function assertBiggerContextChangeAllowed(config, enabled) {
  if (enabled === true && config?.browserInteractionMode === "manual") {
    throw new Error("Bigger Context is unavailable in Zero Risk mode");
  }
  if (enabled === true && config?.useEnhancedWebSessionMode === true) {
    throw new Error("Bigger Context is unavailable while Enhanced Web session mode is enabled");
  }
}

module.exports = { assertBiggerContextChangeAllowed, normalizeContextModes };
