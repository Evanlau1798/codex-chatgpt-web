const { reconcileClaudeSetupState } = require("./claude-integration-status.cjs");

function runtimePreferenceState(config) {
  if (!config) return {};
  return {
    ...(["automatic", "manual"].includes(config.browserInteractionMode)
      ? { browserInteractionMode: config.browserInteractionMode } : {}),
    zeroRiskProEnabled: config.zeroRiskProEnabled === true,
    useEnhancedWebSessionMode: config.useEnhancedWebSessionMode === true,
    experimentalBiggerContext: config.browserInteractionMode !== "manual"
      && config.experimentalBiggerContext === true,
  };
}

async function manualMcpSetupState(runtimeHost, development) {
  const preferences = runtimePreferenceState(runtimeHost.runtimeConfigSnapshot().config);
  if (development) return { ...preferences, coreSetupComplete: true, bridgeEnabled: false };
  const route = await runtimeHost.bridgeStatus().catch(() => {
    // Setup already committed: publish its mode, but do not claim an unverified client installation.
    runtimeHost.logger?.warn("runtime.setup_status_unverified", { client: "codex" });
    return undefined;
  });
  return {
    ...preferences, coreSetupComplete: true,
    codexSetupComplete: route?.installed === true,
    ...(route ? { bridgeEnabled: route.installed === true && route.active === true } : {}),
    codexCatalogVerified: false,
    codexRestartRequired: route?.installed !== false,
    ...reconcileClaudeSetupState(runtimeHost.claudeIntegrationStatus()),
  };
}

module.exports = { runtimePreferenceState, manualMcpSetupState };
