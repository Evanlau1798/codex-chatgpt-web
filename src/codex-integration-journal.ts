import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFile, stripUtf8Bom } from "./config";
import type { AppConfig } from "./config";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  serializeJournal,
  writeFilesWithCompensation,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  LegacyCodexIntegrationJournal,
  LegacyCodexIntegrationJournalV3,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
} from "./codex-integration-shared";
import { verifyManagedJournalState } from "./codex-integration-route";

function isPreviousAssignment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const assignment = value as Record<string, unknown>;
  if (typeof assignment.present !== "boolean") return false;
  return !assignment.present
    || (typeof assignment.rawLine === "string" && typeof assignment.value === "string");
}

function parseJournal(path: string): AnyCodexIntegrationJournal {
  const value = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))) as Record<string, unknown>;
  const installed = value.installed as Record<string, unknown> | undefined;
  if (value.version === 9
    && typeof value.active === "boolean"
    && installed
    && typeof installed.openai_base_url === "string"
    && installed.experimental_realtime_webrtc_call_base_url === CODEX_REALTIME_WEBRTC_CALL_BASE_URL
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && isPreviousAssignment(value.previousRealtimeWebrtcCallBaseUrl)
    && typeof value.configPath === "string") {
    return value as unknown as CodexIntegrationJournal;
  }
  if (value.version === 8
    && typeof value.active === "boolean"
    && installed
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV8;
  }
  if (value.version === 7
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV7;
  }
  if (value.version === 6
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && value.previousRemoteCompactionV2
    && value.previousMultiAgent
    && value.previousMultiAgentV2
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV6;
  }
  if (value.version === 5
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && value.previousRemoteCompactionV2
    && value.previousMultiAgent
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV5;
  }
  if (value.version === 4
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV4;
  }
  if (value.version === 3 && value.installed && value.previous && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV3;
  }
  if (value.version === 2 && value.installed && value.previous && typeof value.providerBlock === "string") {
    return value as unknown as LegacyCodexIntegrationJournal;
  }
  throw new Error(`Invalid Codex integration journal: ${path}`);
}
function journalMatchesConfig(journal: AnyCodexIntegrationJournal): boolean {
  try {
    assertJournalTargetsConfig(journal, getCodexConfigPath());
    if (!existsSync(journal.configPath)) return false;
    const text = readFileSync(journal.configPath, "utf8");
    if (journal.version === 2) return text.includes(journal.providerBlock);
    verifyManagedJournalState(text, journal);
    return true;
  } catch {
    return false;
  }
}

export function readJournal({ repair = true } = {}): AnyCodexIntegrationJournal | undefined {
  const primaryPath = getCodexJournalPath();
  const recoveryPath = getCodexJournalRecoveryPath();
  let primary: AnyCodexIntegrationJournal | undefined;
  let recovery: AnyCodexIntegrationJournal | undefined;
  let primaryError: unknown;
  let recoveryError: unknown;
  if (existsSync(primaryPath)) {
    try { primary = parseJournal(primaryPath); } catch (error) { primaryError = error; }
  }
  if (existsSync(recoveryPath)) {
    try { recovery = parseJournal(recoveryPath); } catch (error) { recoveryError = error; }
  }
  if (!primary && !recovery) {
    if (primaryError) throw primaryError;
    if (recoveryError) throw recoveryError;
    return undefined;
  }
  if (primary && recovery && serializeJournal(primary) === serializeJournal(recovery)) return primary;
  if (primary && !recovery && !recoveryError) {
    if (repair) atomicWriteFile(recoveryPath, serializeJournal(primary));
    return primary;
  }
  if (recovery && !primary && !primaryError) {
    if (!journalMatchesConfig(recovery)) {
      throw new Error("Codex integration recovery journal does not match the active config");
    }
    if (repair) atomicWriteFile(primaryPath, serializeJournal(recovery));
    return recovery;
  }

  const primaryMatches = primary ? journalMatchesConfig(primary) : false;
  const recoveryMatches = recovery ? journalMatchesConfig(recovery) : false;
  if (primaryMatches === recoveryMatches) {
    throw new Error(
      primaryMatches
        ? "Codex integration journal copies contain different baselines for the same config"
        : "Codex integration journal copies do not match the active config",
    );
  }
  const selected = primaryMatches ? primary! : recovery!;
  const data = serializeJournal(selected);
  if (repair) {
    writeFilesWithCompensation([
      { path: recoveryPath, data },
      { path: primaryPath, data },
    ]);
  }
  return selected;
}

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
  options: { repair?: boolean } = {},
): AppConfig["subagentProtocol"] {
  const journal = readJournal(options);
  return journal?.version === 8 || journal?.version === 9 ? journal.installed.subagent_protocol : fallback;
}

export function assertJournalTargetsConfig(
  journal: AnyCodexIntegrationJournal,
  configPath: string,
): void {
  const pathIdentity = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (pathIdentity(journal.configPath) !== pathIdentity(configPath)) {
    throw new Error(
      `Codex integration journal belongs to ${journal.configPath}, not the active config ${configPath}`,
    );
  }
}
