import type { AdapterEvent } from "../types";

interface ResumableClaudeAgent {
  agent_id: string;
  description?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function resumableClaudeAgents(messages: unknown[]): ResumableClaudeAgent[] {
  const agentCalls = new Map<string, string | undefined>();
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const rawBlock of message.content) {
      const block = record(rawBlock);
      if (block?.type !== "tool_use" || block.name !== "Agent" || typeof block.id !== "string") continue;
      const description = record(block.input)?.description;
      agentCalls.set(block.id, typeof description === "string" && description.trim()
        ? description.trim().slice(0, 200)
        : undefined);
    }
  }
  const agents = new Map<string, ResumableClaudeAgent>();
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    for (const rawBlock of message.content) {
      const block = record(rawBlock);
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const description = agentCalls.get(block.tool_use_id);
      if (!agentCalls.has(block.tool_use_id)) continue;
      const match = /^agentId:\s*([A-Za-z0-9_-]{6,128})\b/m.exec(contentText(block.content));
      if (!match) continue;
      const agent: ResumableClaudeAgent = {
        agent_id: match[1]!,
        ...(description ? { description } : {}),
      };
      agents.delete(agent.agent_id);
      agents.set(agent.agent_id, agent);
    }
  }
  return [...agents.values()].slice(-64);
}

function resumableAgentHandoff(messages: unknown[]): string {
  const agents = resumableClaudeAgents(messages);
  if (agents.length === 0) return "";
  const instruction = "Internal Claude Code continuation state: these opaque agent IDs came from matched Agent tool results. Never expose them to the user. To continue the exact prior agent, call SendMessage with its agent_id; do not search transcripts or create a replacement agent.";
  return `\n\n<claude_resumable_agents>\n${instruction}\n${JSON.stringify(agents)}\n</claude_resumable_agents>`;
}

export function isClaudeCompactRequest(system: string, messages: unknown[]): boolean {
  const latest = [...messages].reverse().find(message => message && typeof message === "object"
    && !Array.isArray(message)
    && (message as { role?: unknown }).role === "user") as { content?: unknown } | undefined;
  const content = typeof latest?.content === "string"
    ? latest.content
    : Array.isArray(latest?.content)
      ? latest.content.flatMap(block => block && typeof block === "object" && !Array.isArray(block)
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : []).join("\n")
      : "";
  return system.includes("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.")
    && content.includes("Your task is to create a detailed summary of this conversation.");
}

function envelope(summary: string, messages: unknown[]): string {
  return `<analysis>Conversation compacted by the active ChatGPT Web agent.</analysis>\n<summary>${summary}${resumableAgentHandoff(messages)}</summary>`;
}

function missingCompactTerminal(): AdapterEvent {
  return {
    type: "error",
    message: "Claude compact source ended without a terminal event.",
    status: 502,
    errorType: "api_error",
  };
}

export function compactClaudeEvents(events: AdapterEvent[], messages: unknown[] = []): AdapterEvent[] {
  const summary = events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
  const output: AdapterEvent[] = events.filter(event => event.type !== "text_delta");
  const terminal = output.findIndex(event => event.type === "done" || event.type === "error" || event.type === "incomplete");
  if (terminal < 0) {
    output.push(missingCompactTerminal());
    return output;
  }
  output.splice(terminal, 0, { type: "text_delta", text: envelope(summary, messages), phase: "final_answer" });
  return output;
}

export async function* compactClaudeStream(
  events: AsyncIterable<AdapterEvent>,
  messages: unknown[] = [],
): AsyncIterable<AdapterEvent> {
  let summary = "";
  let terminal = false;
  for await (const event of events) {
    if (event.type === "text_delta") summary += event.text;
    else if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      terminal = true;
      const compacted: AdapterEvent = { type: "text_delta", text: envelope(summary, messages), phase: "final_answer" };
      yield compacted;
      yield event;
    } else yield event;
  }
  if (!terminal) yield missingCompactTerminal();
}
