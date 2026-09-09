import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";

export function launcherHelperRunFrame(config: ResolvedBrowserConfig, turn: BrowserTurn): unknown {
  return {
    type: "run",
    id: turn.traceId,
    config: {
      appName: config.appName,
      browserHostDescriptorPath: config.browserHostDescriptorPath!,
      browserDiagnosticsPath: config.browserDiagnosticsPath,
      turnTimeoutMs: config.turnTimeoutMs,
      autoApproveToolCalls: config.autoApproveToolCalls,
      experimentalNoAutoCompact: config.experimentalNoAutoCompact,
    },
    turn: {
      traceId: turn.traceId,
      modelId: turn.modelId,
      reasoning: turn.reasoning,
      capabilities: turn.capabilities,
      ...(turn.nativeConnector ? { nativeConnector: true } : {}),
      ...(turn.prepareResume ? { resumeAvailable: true } : {}),
      ...(turn.prepareRefresh ? { refreshAvailable: true } : {}),
      ...(turn.retainConversation ? { retainConversation: true } : {}),
      ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
      ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
      ...(turn.systemRevision ? { systemRevision: turn.systemRevision } : {}),
      ...(turn.compaction ? { compaction: true } : {}),
      ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
      ...(turn.externalProgress ? { externalProgress: true } : {}),
    },
  };
}
