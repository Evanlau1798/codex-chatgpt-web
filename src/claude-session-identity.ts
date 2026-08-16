function safeClaudeIdentityPart(value: string, fallback: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return safe || fallback;
}

export function claudeSessionThreadId(sessionId: string): string {
  return `claude_${safeClaudeIdentityPart(sessionId, "ephemeral")}`;
}

export function claudeAgentTurnId(agentId: string): string {
  return `claude_${safeClaudeIdentityPart(agentId, "root")}`;
}
