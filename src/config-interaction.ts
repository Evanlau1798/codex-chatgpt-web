import type { ChatGptWebModelCapabilities } from "./chatgpt-web-models";
export type RuntimeMode = "browser-only" | "full";
export type BrowserHostMode = "managed-chrome" | "launcher";
export type BrowserInteractionMode = "automatic" | "manual";
export type SubagentProtocol = "compatibility-v1" | "native";

/**
 * Keep the connector generation aligned with upstream. Within one generation the public MCP ABI is
 * frozen so ordinary Enhanced upgrades keep using the existing connector without recreation.
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

export function validateConnectorNameSuffix(value: unknown): string {
  if (typeof value !== "string" || value.length > 74
    || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(value)
    || value !== value.trim()) {
    throw new Error("The part after Codex must contain 1–74 letters, numbers, spaces, hyphens or underscores");
  }
  if (value === "Native") throw new Error("Codex Native is retired; choose another plugin name");
  return value;
}

export function validateCurrentConnectorName(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("Codex ")) {
    throw new Error("Plugin names must start with Codex followed by a space");
  }
  validateConnectorNameSuffix(value.slice(6));
  return value;
}

export interface InteractionConnectorIdentities {
  appName: string;
  automaticAppName: string;
  manualAppName: string;
}

export function resolveInteractionConnectorIdentities(
  interactionMode: BrowserInteractionMode,
  profile: "production" | "development" = "production",
  existing: Partial<InteractionConnectorIdentities> = {},
  suffix?: string,
): InteractionConnectorIdentities {
  const defaultAutomatic = profile === "development" ? DEV_CHATGPT_CONNECTOR_NAME : CHATGPT_CONNECTOR_NAME;
  let automaticAppName = existing.automaticAppName ?? defaultAutomatic;
  let manualAppName = existing.manualAppName ?? ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  if (isLegacyChatGptConnectorName(automaticAppName)) {
    automaticAppName = defaultAutomatic;
  } else if (suffix === undefined) {
    try { validateCurrentConnectorName(automaticAppName); } catch { automaticAppName = defaultAutomatic; }
  }
  if (suffix !== undefined) {
    const name = `Codex ${validateConnectorNameSuffix(suffix)}`;
    if (interactionMode === "manual") manualAppName = name;
    else automaticAppName = name;
  }
  validateCurrentConnectorName(automaticAppName);
  validateCurrentConnectorName(manualAppName);
  if (automaticAppName === manualAppName) {
    throw new Error("Automatic and Zero Risk connector names must differ");
  }
  return {
    appName: interactionMode === "manual" ? manualAppName : automaticAppName,
    automaticAppName,
    manualAppName,
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
  useEnhancedOutputTunnel: boolean;
  appName: string;
  automaticAppName: string;
  manualAppName: string;
  browserHost: BrowserHostMode;
  browserInteractionMode: BrowserInteractionMode;
  browserHostDescriptorPath?: string;
  chromeExecutablePath: string;
  storageStatePath: string;
  brokerSocketPath: string;
  headed: boolean;
  solAvailable: boolean;
  /** Observed Extra High slider capability. Missing legacy values fail closed. */
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  modelCapabilities?: ChatGptWebModelCapabilities;
  experimentalBiggerContext: boolean;
  experimentalSkillAttachments: boolean;
  experimentalParallelSubagents?: boolean;
  /** Rebuild Original-mode turns; Enhanced always disables this preference. */
  experimentalFreshConversationPerTurn: boolean;
  /** Save Codex/Claude chats to history. API Access always remains Temporary Chat. */
  useSavedChats: boolean;
  /** Hide routed context limits from Codex and reject routed compact requests. */
  experimentalNoAutoCompact: boolean;
  /** Candidate only: replace large guarded insertions; preserve existing direct inline routes. */
  experimentalComposerPlainText?: boolean;
  /** Explicitly install the additional Pro-sized model row while Zero Risk is active. */
  zeroRiskProEnabled: boolean;
  /** Optional adapter-silence budget for the Responses watchdog. */
  stallTimeoutSec?: number;
  /** Optional launcher-owned ceiling for concurrent Automatic Web browser turns. */
  maxBrowserTabs?: number;
  /** Optional local ceiling for logical Automatic Web sessions in one usage window. */
  automaticWebSessionLimitCount?: number;
  /** Optional duration for one local Automatic Web usage window. */
  automaticWebSessionLimitMinutes?: number;
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
