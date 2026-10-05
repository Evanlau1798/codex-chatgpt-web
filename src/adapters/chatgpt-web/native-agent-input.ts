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
    const candidates = new Map<string, string>();
    let seenBytes = [...this.seen.values()].reduce((bytes, text) => bytes + Buffer.byteLength(text), 0);
    let pendingBytes = Buffer.byteLength(this.pending.join("\n"));
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
      const candidate = candidates.get(item.id);
      if (candidate !== undefined && candidate !== text) {
        throw new Error("Conflicting native inter-agent input in one snapshot");
      }
      if (prior !== undefined || candidate !== undefined) continue;
      const bytes = Buffer.byteLength(text);
      if (this.seeded) pendingBytes += bytes + (this.pending.length + candidates.size > 0 ? 1 : 0);
      seenBytes += bytes;
      candidates.set(item.id, text);
      // Bound scanning work too, not only the eventually committed inbox.
      if (this.seen.size + candidates.size > 1024 || seenBytes > 1048576
        || (this.seeded && (this.pending.length + candidates.size > 128 || pendingBytes > 262144))) {
        throw new Error("Native inter-agent delivery capacity exceeded");
      }
    }
    for (const [id, text] of candidates) {
      this.seen.set(id, text);
      // Initial inputs are already in the initial prompt; never replay them.
      if (this.seeded) this.pending.push(text);
    }
    this.seeded = true;
  }
  peek(): string[] { return [...this.pending]; }
  acknowledge(count: number): void { this.pending.splice(0, count); }
}
