import type { CodexToolResultMessage } from "../../types";
import { codexToolResultToBrokerResult } from "./compaction-handoff";
import type { BrokerToolResult, TurnBroker } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";

export function claudeAdditiveSteeringInstruction(steering: string): string {
  return `Additional user guidance for the current task:\n\n${steering}\n\n`
    + "Apply it once to the ongoing work without separately acknowledging this notice. "
    + "Continue the existing task unless the guidance explicitly asks to stop or replace it.";
}

function withClaudeSteering(result: BrokerToolResult, steering: string): BrokerToolResult {
  return {
    ...result,
    content: [...result.content, { type: "text", text: claudeAdditiveSteeringInstruction(steering) }],
  };
}

export function completeChatGptToolResults(
  session: ChatGptTurnSession,
  broker: Pick<TurnBroker, "completeTool">,
  token: string,
  results: CodexToolResultMessage[],
): void {
  const outstanding = session.outstanding();
  if (results.length !== outstanding.length) {
    throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
  }
  const steering = session.claudeRootThreadId ? session.peekPendingSteering() : undefined;
  for (const [index, message] of results.entries()) {
    const isBoundary = steering && index === results.length - 1;
    const result = codexToolResultToBrokerResult(message);
    broker.completeTool(token, message.toolCallId, isBoundary ? withClaudeSteering(result, steering.text) : result);
    session.markResultDelivered(message.toolCallId);
    if (isBoundary) {
      session.takePendingSteering(steering.count);
      console.info(`[chatgpt-web] delivered additive Claude steering prompts=${steering.count} boundary=tool_result`);
    }
  }
}
