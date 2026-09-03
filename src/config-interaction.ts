export type RuntimeMode = "browser-only" | "full";
export type BrowserHostMode = "managed-chrome" | "launcher";
export type BrowserInteractionMode = "automatic" | "manual";
export type SubagentProtocol = "compatibility-v1" | "native";

/**
 * ChatGPT caches a connector's public MCP contract by connector identity. The direct turn-token
 * contract therefore has a new identity instead of mutating the retired connector in place.
 */
export const CHATGPT_CONNECTOR_NAME = "Codex Native2";
export const DEV_CHATGPT_CONNECTOR_NAME = `${CHATGPT_CONNECTOR_NAME} DEV`;
export const ZERO_RISK_CHATGPT_CONNECTOR_NAME = "Codex Zero Risk";
export const LEGACY_CHATGPT_CONNECTOR_NAMES = ["Codex Native"] as const;

export function isLegacyChatGptConnectorName(value: string): boolean {
  return (LEGACY_CHATGPT_CONNECTOR_NAMES as readonly string[]).includes(value);
}

export function legacyChatGptConnectorMigrationMessage(legacyName: string): string {
  return `Legacy ChatGPT connector ${JSON.stringify(legacyName)} was found, but this release requires`
    + ` a newly created connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}. Create`
    + ` ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the same tunnel with Authentication set to None;`
    + ` do not rename or refresh ${JSON.stringify(legacyName)}.`;
}

export function resolveSetupConnectorName(existingName?: string, requestedName?: string): string {
  if (requestedName !== undefined) {
    const requested = requestedName.trim();
    if (!requested || requested.length > 80) throw new Error("Connector name is invalid");
    if (isLegacyChatGptConnectorName(requested)) {
      throw new Error(legacyChatGptConnectorMigrationMessage(requested));
    }
    return requested;
  }
  const existing = existingName?.trim();
  if (!existing || isLegacyChatGptConnectorName(existing)) return CHATGPT_CONNECTOR_NAME;
  return existing;
}

export function resolveDevSetupConnectorName(existingName?: string, requestedName?: string): string {
  if (requestedName !== undefined) return resolveSetupConnectorName(existingName, requestedName);
  const existing = existingName?.trim();
  if (!existing || existing === CHATGPT_CONNECTOR_NAME || isLegacyChatGptConnectorName(existing)) {
    return DEV_CHATGPT_CONNECTOR_NAME;
  }
  return resolveSetupConnectorName(existing);
}

export interface InteractionConnectorIdentities {
  appName: string;
  automaticAppName: string;
  manualAppName: typeof ZERO_RISK_CHATGPT_CONNECTOR_NAME;
}

export function resolveInteractionConnectorIdentities(
  existing: Pick<AppConfig, "appName" | "automaticAppName" | "browserInteractionMode"> | undefined,
  interactionMode: BrowserInteractionMode,
  requestedAutomaticName?: string,
): InteractionConnectorIdentities {
  const previousAutomaticName = existing?.automaticAppName
    || (existing?.browserInteractionMode !== "manual" ? existing?.appName : undefined);
  const automaticAppName = resolveSetupConnectorName(previousAutomaticName, requestedAutomaticName);
  return {
    appName: interactionMode === "manual" ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : automaticAppName,
    automaticAppName,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
  };
}

export interface TunnelConfig {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileDir: string;
  profileName: string;
  alias: string;
}

export interface AppConfig {
  version: 3;
  purpose?: "dev-harness";
  releaseVersion: string;
  mode: RuntimeMode;
  subagentProtocol: SubagentProtocol;
  host: "127.0.0.1";
  port: number;
  contextWindow: number;
  useEnhancedWebSessionMode: boolean;
  appName: string;
  automaticAppName: string;
  manualAppName: typeof ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  browserHost: BrowserHostMode;
  browserInteractionMode: BrowserInteractionMode;
  browserHostDescriptorPath?: string;
  chromeExecutablePath: string;
  storageStatePath: string;
  brokerSocketPath: string;
  headed: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  experimentalBiggerContext: boolean;
  /** Explicitly install the additional Pro-sized model row while Zero Risk is active. */
  zeroRiskProEnabled: boolean;
  /** Optional adapter-silence budget for the Responses watchdog. */
  stallTimeoutSec?: number;
  autoApproveToolCalls: boolean;
  controlToken: string;
  runtimeCommand: string[];
  acknowledgedUnofficialAt?: string;
  tunnel?: TunnelConfig;
  automaticTunnel?: TunnelConfig;
  manualTunnel?: TunnelConfig;
}

export function tunnelConfigForInteractionMode(
  config: Pick<AppConfig, "browserInteractionMode" | "tunnel" | "automaticTunnel" | "manualTunnel">,
  mode: BrowserInteractionMode = config.browserInteractionMode,
): TunnelConfig | undefined {
  const configured = mode === "manual" ? config.manualTunnel : config.automaticTunnel;
  if (configured) return configured;
  if (config.automaticTunnel || config.manualTunnel) return undefined;
  // The single tunnel field predates Zero Risk. Released 4.x configurations therefore always
  // belong to Automatic mode; Zero Risk is populated only by an explicit setup or migration.
  return mode === "automatic" ? config.tunnel : undefined;
}
