import type { CompiledChatGptWebPrompt } from "./prompt";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";
import type { BrokerTurnOutputEvent } from "./turn-broker-protocol";
import type { ChatGptWebCapabilities } from "./model";

export interface BrowserHelperRunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs: number;
    autoApproveToolCalls: boolean;
    experimentalNoAutoCompact?: boolean;
    /** Candidate only: replace large guarded insertions; preserve existing direct inline routes. */
    experimentalComposerPlainText?: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    capabilities: ChatGptWebCapabilities;
    nativeConnector?: boolean;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    conversationKey?: string;
    compaction?: boolean;
    outputFormat?: "visible-text";
    captureLunaCheckpoint?: boolean;
    externalProgress?: boolean;
    tunneledOutput?: boolean;
  };
}

type MaintenanceMessage =
  | { type: "verify"; id: string; config: { appName: string; browserHostDescriptorPath: string; brokerSocketPath: string } }
  | { type: "inspect"; id: string; config: { appName: string; browserHostDescriptorPath: string }; detectCapabilities: boolean }
  | { type: "smoke"; id: string; config: { appName: string; browserHostDescriptorPath: string } };

export type BrowserHelperInputMessage = BrowserHelperRunMessage | MaintenanceMessage
  | { type: "answer_retry"; id: string; prompt?: string; acknowledge?: boolean; replaceCandidate?: boolean; allowLunaCheckpointRetry?: boolean }
  | { type: "prepared_selected_ack"; id: string; prepared: CompiledChatGptWebPrompt }
  | { type: "send_activated_ack"; id: string }
  | { type: "completion_fence_begin_ack"; id: string; requestId: number; revision: number | null }
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "tunneled_output"; id: string; output: BrokerTurnOutputEvent }
  | { type: "tunneled_output_reset_ack"; id: string; requestId: number; reset: boolean }
  | { type: "tunneled_output_seal_ack"; id: string; requestId: number; sealed: boolean }
  | { type: "preempt_retry"; id: string; prompt: string }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "abort"; id: string; reason?: "compaction_handoff_accepted" }
  | { type: "shutdown" };

export type BrowserHelperMaintenanceMessage = Extract<BrowserHelperInputMessage, {
  type: "verify" | "inspect" | "smoke";
}>;
