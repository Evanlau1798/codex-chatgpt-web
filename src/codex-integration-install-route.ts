import type { AppConfig } from "./config";
import { installCodexInterruptHook, installCodexInterruptHookCommand } from "./codex-interrupt-hook";
import { CODEX_REALTIME_WEBRTC_CALL_BASE_URL, MANAGED_ROUTE_COMMENT, getCodexConfigPath, type CodexIntegrationJournal, type PreviousAssignment } from "./codex-integration-shared";
import { assignments, findTopLevelAssignment, firstTableIndex, insertDocumentLine, installCompatibilityV1Features, parseDocument, removeManagedComment, renderDocument } from "./codex-integration-document";

export function installRoute(
  text: string,
  installedUrl: string,
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: PreviousAssignment;
} {
  const document = parseDocument(text);
  const previous = assignments(document.lines);
  if (previous.openai_base_url.present && !replaceExistingRoute) {
    throw new Error(
      `Codex already configures model routing (openai_base_url=${JSON.stringify(previous.openai_base_url.value)}). `
      + "Rerun with --replace-codex-route to replace it reversibly. "
      + "Check whether another Codex extension or wrapper (for example, OpenCodex or Headroom) is replacing the bridge port.",
    );
  }
  const previousRealtimeWebrtcCallBaseUrl = findTopLevelAssignment(
    document.lines,
    "experimental_realtime_webrtc_call_base_url",
  );
  if (previousRealtimeWebrtcCallBaseUrl.present
    && previousRealtimeWebrtcCallBaseUrl.value !== CODEX_REALTIME_WEBRTC_CALL_BASE_URL
    && !replaceExistingRealtimeRoute) {
    throw new Error(
      "Codex already configures its realtime WebRTC call route "
      + `(experimental_realtime_webrtc_call_base_url=${JSON.stringify(previousRealtimeWebrtcCallBaseUrl.value)}). `
      + "Rerun with --replace-codex-route to replace it reversibly.",
    );
  }

  const currentBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  if (currentBaseUrl.index !== undefined) {
    document.lines[currentBaseUrl.index] = `openai_base_url = ${JSON.stringify(installedUrl)}`;
  } else {
    insertDocumentLine(document, firstTableIndex(document.lines), `openai_base_url = ${JSON.stringify(installedUrl)}`);
  }
  const currentRealtimeUrl = findTopLevelAssignment(document.lines, "experimental_realtime_webrtc_call_base_url");
  const realtimeLine = `experimental_realtime_webrtc_call_base_url = ${JSON.stringify(CODEX_REALTIME_WEBRTC_CALL_BASE_URL)}`;
  if (currentRealtimeUrl.index !== undefined) {
    document.lines[currentRealtimeUrl.index] = realtimeLine;
  } else {
    const installedBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
    insertDocumentLine(document, installedBaseUrl.index! + 1, realtimeLine);
  }
  removeManagedComment(document);
  const installedBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  insertDocumentLine(document, installedBaseUrl.index!, MANAGED_ROUTE_COMMENT);
  return { text: renderDocument(document), previous, previousRealtimeWebrtcCallBaseUrl };
}

export function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "subagentProtocol"> & (
    Pick<AppConfig, "runtimeCommand"> | { interruptHookCommand: string }
  ),
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  interruptHook: CodexIntegrationJournal["interruptHook"];
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
  );
  const configured = config.subagentProtocol === "compatibility-v1"
    ? (() => {
        const features = installCompatibilityV1Features(route.text);
        return {
          text: features.text,
          previous: route.previous,
          previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
          previousMultiAgent: features.previousMultiAgent,
          previousMultiAgentV2: features.previousMultiAgentV2,
          previousAgentMaxDepth: features.previousAgentMaxDepth,
          installedAgentMaxDepth: features.installedAgentMaxDepth,
        };
      })()
    : route;
  const hook = "interruptHookCommand" in config
    ? installCodexInterruptHookCommand(configured.text, getCodexConfigPath(), config.interruptHookCommand)
    : installCodexInterruptHook(configured.text, getCodexConfigPath(), config);
  return { ...configured, text: hook.text, interruptHook: hook.installed };
}
