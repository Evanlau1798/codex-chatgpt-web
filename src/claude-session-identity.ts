import { createHash } from "node:crypto";

function safeClaudeIdentityPart(value: string, fallback: string): string {
  if (!value) return fallback;
  if (/^[A-Za-z0-9_-]{1,80}$/.test(value) && !value.startsWith("encoded_")) return value;
  // Sanitizing or truncating alone aliases distinct session/agent owners.
  // Preserve ordinary native IDs; escape unusual IDs with a full digest.
  return `encoded_${createHash("sha256").update(value).digest("hex")}`;
}

export function claudeSessionThreadId(sessionId: string): string {
  return `claude_${safeClaudeIdentityPart(sessionId, "ephemeral")}`;
}

export function claudeAgentTurnId(agentId: string): string {
  return `claude_${safeClaudeIdentityPart(agentId, "root")}`;
}
