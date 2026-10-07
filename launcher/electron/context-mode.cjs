function normalizeContextModes(config) {
  if (!config) return config;
  const enhanced = config.useEnhancedWebSessionMode === true;
  const bigger = enhanced && config.experimentalBiggerContext === true;
  const fresh = (enhanced || config.browserInteractionMode === "manual")
    && config.experimentalFreshConversationPerTurn === true;
  if (!bigger && !fresh) return config;
  return {
    ...config,
    ...(bigger ? { experimentalBiggerContext: false } : {}),
    ...(fresh ? { experimentalFreshConversationPerTurn: false } : {}),
  };
}

function assertBiggerContextChangeAllowed(config, enabled) {
  if (enabled === true && config?.browserInteractionMode === "manual") {
    throw new Error("Bigger Context is unavailable in Zero Risk mode");
  }
  if (enabled === true && config?.useEnhancedWebSessionMode === true) {
    throw new Error("Bigger Context is unavailable while Enhanced Web session mode is enabled");
  }
  if (enabled === true && config?.solAvailable !== true) {
    throw new Error("Bigger Context is unavailable for Luna and Think. Turn it off in launcher Settings (or run setup with --standard-context), then restart Codex.");
  }
}

module.exports = { assertBiggerContextChangeAllowed, normalizeContextModes };
