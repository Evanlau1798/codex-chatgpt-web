import type { AppConfig } from "./config";
import { refreshClaudeIntegrationRuntimeCredentials } from "./claude-integration";

export interface RuntimeIntegrationCredentialReconciliation {
  claudeCredentialsRefreshed: boolean;
}

export function reconcileRuntimeIntegrationCredentials(
  config: AppConfig,
): RuntimeIntegrationCredentialReconciliation {
  return {
    claudeCredentialsRefreshed: refreshClaudeIntegrationRuntimeCredentials(config),
  };
}
