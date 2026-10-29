import { estimateTokens } from "../../lib/token-estimate";
import { serializeMultipartContext, withoutRetiredTurnHandles } from "./prompt-multipart";
import type { ChatGptContextTokenBreakdown } from "./prompt";

/** Submitted records only; planning probes and account metadata never enter this diagnostic. */
export function contextTokenBreakdown(
  system: string[], messages: Record<string, unknown>[], multipart: boolean,
): ChatGptContextTokenBreakdown {
  const counts: ChatGptContextTokenBreakdown = {};
  const add = (role: keyof ChatGptContextTokenBreakdown, value: unknown): void => {
    const text = multipart ? serializeMultipartContext(value) : withoutRetiredTurnHandles(JSON.stringify(value));
    const group = counts[role] ??= { records: 0, chars: 0, tokens: 0 };
    group.records += 1;
    group.chars += text.length;
    group.tokens += estimateTokens(text);
  };
  system.forEach((content, system_index) => add("system", multipart ? { kind: "system", system_index, content } : content));
  messages.forEach((message, message_index) => add(message.role as keyof ChatGptContextTokenBreakdown,
    multipart ? { kind: "message", message_index, message } : message));
  return counts;
}
