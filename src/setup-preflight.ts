import { existsSync } from "node:fs";
import { getConfigPath, loadConfigForSetup, tunnelConfigForInteractionMode } from "./config";
import { preflightCodexIntegration, readCodexSubagentProtocol } from "./codex-integration";
import { preflightClaudeIntegration } from "./claude-integration";
import { DEV_CONFIG_PURPOSE } from "./dev-chat/constants";
import { buildSetupConfig, type SetupOptions } from "./setup-config";
import { managedRuntimeKeyPath } from "./tunnel";

export function loadExistingConfig() {
  return existsSync(getConfigPath()) ? loadConfigForSetup() : undefined;
}

export function setupIntegrationSelection(integration: SetupOptions["integration"] = "all") {
  return { codex: integration !== "claude", claude: integration !== "codex" };
}

export function prepareSetup(options: SetupOptions, { repairJournal = true } = {}) {
  const existing = loadExistingConfig();
  if (existing?.purpose === DEV_CONFIG_PURPOSE) {
    throw new Error("A DEV harness configuration cannot be installed into Codex");
  }
  const config = buildSetupConfig(existing, {
    ...options,
    subagentProtocol: options.subagentProtocol
      ?? readCodexSubagentProtocol(existing?.subagentProtocol ?? "compatibility-v1", { repair: repairJournal }),
  });
  delete config.purpose;
  const launcherOwned = config.browserHost === "launcher";
  if (!launcherOwned && process.platform !== "darwin") {
    throw new Error(
      "Terminal-only managed Chrome setup currently requires macOS. "
      + "Use the Codex Web GPT launcher on Windows or Linux.",
    );
  }
  const integrations = setupIntegrationSelection(options.integration);
  if (integrations.codex) preflightCodexIntegration(config, { replaceExistingRoute: options.replaceCodexRoute });
  if (integrations.claude) preflightClaudeIntegration(config, { replaceExistingRoute: options.replaceCodexRoute });
  return { existing, config, launcherOwned, integrations };
}

export function preflightSetup(options: SetupOptions): void {
  const { existing, config } = prepareSetup(options, { repairJournal: false });
  if (config.mode !== "full") return;
  const mode = config.browserInteractionMode;
  const label = mode === "manual" ? "Zero Risk" : "Automatic";
  const saved = existing?.mode === "full" ? tunnelConfigForInteractionMode(existing, mode) : undefined;
  const tunnelId = options.tunnelId ?? saved?.tunnelId;
  if (!tunnelId) throw new Error(`${label} mode needs its own MCP Tunnel ID`);
  const hasRuntimeKey = Boolean(options.runtimeKeyValue
    || (options.runtimeKeyFile && existsSync(options.runtimeKeyFile))
    || (saved?.runtimeKeyFile && existsSync(saved.runtimeKeyFile))
    || existsSync(managedRuntimeKeyPath(mode)));
  if (!hasRuntimeKey) throw new Error(`${label} mode needs its own MCP runtime key`);
  const other = existing?.mode === "full"
    ? tunnelConfigForInteractionMode(existing, mode === "manual" ? "automatic" : "manual") : undefined;
  if (other?.tunnelId === tunnelId) {
    throw new Error("Automatic and Zero Risk require different Tunnel IDs and separate ChatGPT connectors");
  }
}
