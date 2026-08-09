import type { AdapterEvent } from "../types";

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

function envelope(summary: string): string {
  return `<analysis>Conversation compacted by the active ChatGPT Web agent.</analysis>\n<summary>${summary}</summary>`;
}

export function compactClaudeEvents(events: AdapterEvent[]): AdapterEvent[] {
  const summary = events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
  const output: AdapterEvent[] = events.filter(event => event.type !== "text_delta");
  const terminal = output.findIndex(event => event.type === "done" || event.type === "error" || event.type === "incomplete");
  output.splice(terminal < 0 ? output.length : terminal, 0, { type: "text_delta", text: envelope(summary), phase: "final_answer" });
  return output;
}

export async function* compactClaudeStream(events: AsyncIterable<AdapterEvent>): AsyncIterable<AdapterEvent> {
  let summary = "";
  for await (const event of events) {
    if (event.type === "text_delta") summary += event.text;
    else if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      const compacted: AdapterEvent = { type: "text_delta", text: envelope(summary), phase: "final_answer" };
      yield compacted;
      yield event;
    } else yield event;
  }
}
