import type { CodexParsedRequest } from "../../types";

/** New native inter-agent data on a retained turn, distinct from human steering. */
export class NativeAgentInputInbox {
  private seeded = false;
  private readonly seen = new Map<string, string>();
  private readonly pending: string[] = [];
  observe(parsed: CodexParsedRequest): void {
    if (parsed._canonicalContextComplete !== true) return;
    const raw = parsed._rawBody as { input?: unknown; client_metadata?: Record<string, unknown> } | undefined;
    let name: unknown;
    try { name = JSON.parse(String(raw?.client_metadata?.["x-codex-turn-metadata"] ?? "{}"))?.agent_name; }
    catch { return; }
    if (typeof name !== "string" || !Array.isArray(raw?.input)) return;
    const candidates: Array<{ id: string; text: string }> = [];
    for (const value of raw.input) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (item.type !== "agent_message" || item.recipient !== name) continue;
      if (typeof item.id !== "string" || !item.id || item.id.length > 256
        || typeof item.author !== "string" || !item.author || item.author.length > 256) {
        throw new Error("Invalid native inter-agent input identity");
      }
      const content = item.content;
      const readable = typeof content === "string" || (Array.isArray(content) && content.every(block => (
        block && typeof block === "object" && !Array.isArray(block)
        && block.type === "input_text" && typeof block.text === "string"
      )));
      if (!readable) throw new Error("Native inter-agent input is not readable text");
      const text = JSON.stringify({ type: "agent_message", id: item.id, author: item.author,
        recipient: item.recipient, content });
      const prior = this.seen.get(item.id);
      if (prior !== undefined && prior !== text) throw new Error("Native inter-agent input identity changed its content");
      if (prior === undefined && !candidates.some(candidate => candidate.id === item.id)) candidates.push({ id: item.id, text });
      else if (candidates.some(candidate => candidate.id === item.id && candidate.text !== text)) {
        throw new Error("Conflicting native inter-agent input in one snapshot");
      }
    }
    if (this.seen.size + candidates.length > 1024
      || [...this.seen.values(), ...candidates.map(item => item.text)]
        .reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 1048576
      || (this.seeded && (this.pending.length + candidates.length > 128
        || Buffer.byteLength([...this.pending, ...candidates.map(item => item.text)].join("\n")) > 262144))) {
      throw new Error("Native inter-agent delivery capacity exceeded");
    }
    for (const candidate of candidates) {
      this.seen.set(candidate.id, candidate.text);
      // Initial inputs are already in the initial prompt; never replay them.
      if (this.seeded) this.pending.push(candidate.text);
    }
    this.seeded = true;
  }
  peek(): string[] { return [...this.pending]; }
  acknowledge(count: number): void { this.pending.splice(0, count); }
}
