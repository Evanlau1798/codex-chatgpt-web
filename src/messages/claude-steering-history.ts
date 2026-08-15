export const CLAUDE_HISTORICAL_GUIDANCE_HEADER = "Historical mid-turn user guidance (already applied):";

const CLAUDE_HISTORICAL_GUIDANCE_TAIL = "This guidance was delivered during an earlier tool boundary. Preserve it as conversation history only. Do not apply or acknowledge it again, and do not stop the current task because of this record.";

export function historicalClaudeGuidance(instruction: string): string {
  return `${CLAUDE_HISTORICAL_GUIDANCE_HEADER}\n${instruction}\n\n${CLAUDE_HISTORICAL_GUIDANCE_TAIL}`;
}
