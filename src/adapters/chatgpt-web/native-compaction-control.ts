import { COMPACT_PROMPT } from "../../responses/compaction";
import type { CompactionTransactionHandle } from "./compaction-transaction";

export const CODEX_COMPACTION_CONTROL_WIRE_NAME = "codex.control.compaction_handoff";
export const CODEX_RECOVERY_CHECKPOINT_WIRE_NAME = "codex.control.recovery_checkpoint";
export const CODEX_ACTIVE_COMPACTION_REQUEST_MARKER = "CODEX_ACTIVE_COMPACTION_REQUEST";

/** Checkpoint the canonical task without ending its retained Web response. */
export function passiveRecoveryCheckpointInstruction(transaction: CompactionTransactionHandle): string {
  return [
    "<codex_recovery_checkpoint>",
    "This is a private recovery checkpoint, not Codex context compaction or a new user request.",
    "Consume the canonical tool result above. Summarize the current objective, user instructions, verified work, decisions, and pending steps so a fresh page could continue if this page fails.",
    "Before another work tool, call codex_tool_call exactly once with the one-shot control binding below:",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_RECOVERY_CHECKPOINT_WIRE_NAME}`,
    `arguments ${JSON.stringify({ handoff_id: transaction.handoffId, summary: "<complete recovery checkpoint>" })}`,
    "After submitted=true, continue the same Web response and task with the original work turn_token. Do not expose the checkpoint to the user.",
    "</codex_recovery_checkpoint>",
  ].join("\n");
}

function compactionControlBinding(transaction: CompactionTransactionHandle): string[] {
  return [
    "Submit the complete checkpoint through the attached Codex Native control plane by calling codex_tool_call exactly once with the binding below.",
    "This one-shot control token is valid only for the reserved compaction operation; do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool.",
    "<codex_compaction_control>",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_COMPACTION_CONTROL_WIRE_NAME}`,
    `handoff_id ${transaction.handoffId}`,
    "</codex_compaction_control>",
    `Call codex_tool_call exactly once with ${JSON.stringify({
      turn_token: transaction.token,
      wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
      arguments: { handoff_id: transaction.handoffId, summary: "<complete checkpoint summary>" },
    })}.`,
  ];
}

/**
 * The active path supplies a one-shot checkpoint binding through the next unexecuted tool call.
 * Previously delivered tool results remain canonical. The unbound source-settlement instruction
 * is retained only for explicit preemption recovery, never the normal active checkpoint path.
 */
export function activeCompactionToolResultInstruction(transaction?: CompactionTransactionHandle): string {
  if (transaction) return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could execute. The tool was not executed. Preserve all earlier canonical tool results.",
    "Produce the checkpoint in this same Web response; do not stop first or wait for another message.",
    structuredCompactionHandoffInstruction(transaction),
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could be sent for execution. The tool was not executed.",
    "Stop ordinary task work now, call no more tools, and end this Web response normally.",
    "For this compaction source-settlement response only, the normal Native2 output-routing rule does not apply.",
    "Do not call codex.control.output or discover any tools.",
    "Do not create or submit a checkpoint in this response. After it settles, the retained conversation will receive exactly one separate structured compaction handoff request.",
    "Return exactly CODEX_COMPACTION_SOURCE_SETTLED as ordinary assistant final text, not a tool call, then end the response immediately.",
    "This sentinel only settles the source response; it does not complete the user's task or submit the checkpoint.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/**
 * Zero Risk cannot submit a second browser message automatically. When Codex compacts at an
 * already-visible native tool boundary, the same manually submitted response returns the
 * checkpoint through the same Zero Risk request instead.
 */
export function zeroRiskActiveCompactionToolResultInstruction(toolExecuted: boolean): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    toolExecuted
      ? "Codex reached its context limit while this Web response was waiting for the tool result above."
      : "Codex reached its context limit before the requested tool could be sent for execution. The tool was not executed.",
    toolExecuted
      ? "Consume that canonical result, stop ordinary task work now, and do not call any more work tools."
      : "Stop ordinary task work now and do not call any more work tools.",
    COMPACT_PROMPT,
    "Call no more work tools. Return only the complete checkpoint summary to Codex with codex_turn_complete.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

export function structuredCompactionHandoffInstruction(
  transaction: CompactionTransactionHandle,
): string {
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work and do not call any more work tools.",
    COMPACT_PROMPT,
    ...compactionControlBinding(transaction),
    "After the control call returns submitted=true, call no more tools. Output exactly turn complete as ordinary assistant final text in the Web frontend, then end this response normally.",
    "For this checkpoint confirmation only, the ordinary Native2 output-routing rule does not apply: do not call codex.control.output or discover tools. The frontend confirmation is not the checkpoint and does not complete the user's task.",
    "The outer bridge accepts compaction only after the structured checkpoint is valid and its owned browser turn has physically settled.",
  ].join("\n");
}
