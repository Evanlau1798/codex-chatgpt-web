import { COMPACT_PROMPT } from "../../responses/compaction";
import type { CompactionTransactionHandle } from "./compaction-transaction";

export const CODEX_COMPACTION_CONTROL_WIRE_NAME = "codex.control.compaction_handoff";

export function structuredCompactionHandoffInstruction(
  transaction: CompactionTransactionHandle,
): string {
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work and do not call any more work tools.",
    COMPACT_PROMPT,
    "Submit the complete checkpoint through the attached Codex Native2 control plane by calling codex_tool_call exactly once with the binding below.",
    "This one-shot control token is valid only for the reserved compaction operation; do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool.",
    "<codex_compaction_control>",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_COMPACTION_CONTROL_WIRE_NAME}`,
    `handoff_id ${transaction.handoffId}`,
    "</codex_compaction_control>",
    `Call codex_tool_call with arguments {"handoff_id":${JSON.stringify(transaction.handoffId)},"summary":"<complete checkpoint summary>"}.`,
    "After the control call returns submitted=true, call no more tools and end this Web response normally.",
    "The outer bridge will accept compaction only after both the structured checkpoint is valid and this Web response has fully ended.",
  ].join("\n");
}
