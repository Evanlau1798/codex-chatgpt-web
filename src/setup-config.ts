import { existsSync } from "node:fs";
import type { AppConfig, BrowserInteractionMode, RuntimeMode, SubagentProtocol } from "./config";
import {
  currentRuntimeCommand,
  defaultBrokerEndpoint,
  defaultConfig,
  resolveInteractionConnectorIdentities,
  tunnelConfigForInteractionMode,
} from "./config";
import { DEV_CONFIG_PURPOSE, DEV_TUNNEL_BASE_NAME } from "./dev-chat/constants";
import {
  createTunnelConfig,
  installRuntimeKey,
  installRuntimeKeyBytes,
  installTunnelClient,
  managedRuntimeKeyPath,
} from "./tunnel";
import { VERSION } from "./version";

export interface SetupOptions {
  mode: RuntimeMode;
  integration?: "all" | "codex" | "claude";
  browserInteractionMode?: BrowserInteractionMode;
  subagentProtocol?: SubagentProtocol;
  port?: number;
  chromeExecutablePath?: string;
  browserHostDescriptorPath?: string;
  refreshAccountCapabilities?: boolean;
  appName?: string;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  useEnhancedWebSessionMode?: boolean;
  experimentalBiggerContext?: boolean;
  zeroRiskProEnabled?: boolean;
  replaceCodexRoute?: boolean;
  restartService?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export function launcherCapabilityProbeRequired(
  existing: AppConfig | undefined,
  refreshAccountCapabilities = false,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): boolean {
  if (interactionMode === "manual") return false;
  return refreshAccountCapabilities
    || existing?.browserInteractionMode === "manual"
    || existing?.browserHost !== "launcher"
    || typeof existing.solAvailable !== "boolean"
    || typeof existing.proAvailable !== "boolean";
}

export function existingFullSetupCredentials(
  existing: AppConfig | undefined,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): { tunnelId: boolean; runtimeKey: boolean } {
  const tunnel = existing?.mode === "full" ? tunnelConfigForInteractionMode(existing, interactionMode) : undefined;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

export function buildSetupConfig(existing: AppConfig | undefined, options: SetupOptions): AppConfig {
  const config = existing ? structuredClone(existing) : defaultConfig(options.mode);
  config.mode = options.mode;
  if (options.browserInteractionMode) config.browserInteractionMode = options.browserInteractionMode;
  const automaticAppName = config.browserInteractionMode === "automatic" ? options.appName : undefined;
  Object.assign(config, resolveInteractionConnectorIdentities(existing, config.browserInteractionMode, automaticAppName));
  if (options.subagentProtocol) config.subagentProtocol = options.subagentProtocol;
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("--port must be an integer from 1 to 65535");
    }
    config.port = options.port;
  }
  if (options.chromeExecutablePath) config.chromeExecutablePath = options.chromeExecutablePath;
  if (options.browserHostDescriptorPath) {
    config.browserHost = "launcher";
    config.browserHostDescriptorPath = options.browserHostDescriptorPath;
    config.brokerSocketPath = defaultBrokerEndpoint();
  } else if (options.chromeExecutablePath) {
    config.browserHost = "managed-chrome";
    delete config.browserHostDescriptorPath;
  }
  if (options.autoApproveToolCalls !== undefined) config.autoApproveToolCalls = options.autoApproveToolCalls;
  if (options.useEnhancedWebSessionMode !== undefined) {
    config.useEnhancedWebSessionMode = options.useEnhancedWebSessionMode;
    if (options.useEnhancedWebSessionMode) config.experimentalBiggerContext = false;
  }
  if (options.experimentalBiggerContext !== undefined) {
    if (options.experimentalBiggerContext && config.useEnhancedWebSessionMode && config.browserInteractionMode !== "manual") {
      throw new Error("Bigger Context is unavailable while Enhanced Web session mode is enabled");
    }
    config.experimentalBiggerContext = options.experimentalBiggerContext;
  }
  if (options.zeroRiskProEnabled !== undefined) {
    if (config.browserInteractionMode !== "manual") {
      throw new Error("Zero Risk Pro can be configured only with --zero-risk-browser-interaction");
    }
    config.zeroRiskProEnabled = options.zeroRiskProEnabled;
  }
  if (config.browserInteractionMode === "manual") {
    if (options.refreshAccountCapabilities) throw new Error("Zero Risk cannot refresh account capabilities");
    if (options.forceLogin) throw new Error("Zero Risk uses the launcher's existing ChatGPT session; --login is unavailable");
    if (options.experimentalBiggerContext === true) throw new Error("Zero Risk does not support Bigger Context");
    if (config.mode !== "full") throw new Error("Zero Risk requires --full so Codex Zero Risk can signal start, tools, and completion");
    if (config.browserHost !== "launcher") {
      throw new Error("Zero Risk requires the Launcher; pass --browser-host-descriptor from the running Launcher");
    }
    config.experimentalBiggerContext = false;
  }
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is unofficial browser automation. Pass --acknowledge-unofficial.");
  }
  return config;
}

export async function configureSetupTunnel(
  config: AppConfig,
  existing: AppConfig | undefined,
  options: SetupOptions,
): Promise<void> {
  if (config.mode === "browser-only") {
    delete config.tunnel;
    delete config.automaticTunnel;
    delete config.manualTunnel;
    return;
  }
  const interactionMode = config.browserInteractionMode;
  const legacyTunnel = existing?.mode === "full" && !existing.automaticTunnel && !existing.manualTunnel
    ? existing.tunnel : undefined;
  let automaticTunnel = existing?.automaticTunnel ?? legacyTunnel;
  let manualTunnel = existing?.manualTunnel;
  const existingTunnel = interactionMode === "manual" ? manualTunnel : automaticTunnel;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) throw new Error(`${interactionMode === "manual" ? "Zero Risk" : "Automatic"} mode requires its own Tunnel ID`);
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  const managedKeyFile = managedRuntimeKeyPath(interactionMode);
  if ((!runtimeKeyFile || !existsSync(runtimeKeyFile)) && existsSync(managedKeyFile)) runtimeKeyFile = managedKeyFile;
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile, interactionMode);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue, interactionMode);
  if (runtimeKeyFile && runtimeKeyFile !== managedKeyFile && existsSync(runtimeKeyFile)) {
    runtimeKeyFile = installRuntimeKey(runtimeKeyFile, interactionMode);
  }
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error(`${interactionMode === "manual" ? "Zero Risk" : "Automatic"} mode requires its own runtime key`);
  }
  const profileName = config.purpose === DEV_CONFIG_PURPOSE
    ? interactionMode === "manual" ? `${DEV_TUNNEL_BASE_NAME}-zero-risk` : DEV_TUNNEL_BASE_NAME
    : interactionMode === "manual" ? "codex-chatgpt-web-zero-risk" : "codex-chatgpt-web";
  const configuredTunnel = createTunnelConfig({
    binaryPath: await installTunnelClient(), tunnelId, runtimeKeyFile, profileName, alias: profileName,
  });
  const otherTunnel = interactionMode === "manual" ? automaticTunnel : manualTunnel;
  if (otherTunnel?.tunnelId === configuredTunnel.tunnelId) {
    throw new Error("Automatic and Zero Risk require different Tunnel IDs and separate ChatGPT connectors");
  }
  if (interactionMode === "manual") manualTunnel = configuredTunnel;
  else automaticTunnel = configuredTunnel;
  config.tunnel = configuredTunnel;
  if (automaticTunnel) config.automaticTunnel = automaticTunnel;
  else delete config.automaticTunnel;
  if (manualTunnel) config.manualTunnel = manualTunnel;
  else delete config.manualTunnel;
}
