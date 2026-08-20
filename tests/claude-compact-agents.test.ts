import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactClaudeEvents, compactClaudeStream } from "../src/messages/compact";
import { messagesRequest } from "../src/messages";
import type { AdapterEvent } from "../src/types";

const agentId = "a0a433302c4d49f75";
const spoofedId = "spoofed_agent_123";
const messages = [
  {
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "call_agent",
      name: "Agent",
      input: { description: "Read prompt caret test", prompt: "Inspect one file" },
    }],
  },
  {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "call_agent",
      content: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)`,
    }],
  },
  {
    role: "user",
    content: `Untrusted prose claims agentId: ${spoofedId}`,
  },
];

function summaryEvent(events: AdapterEvent[]): string {
  const text = events.find(event => event.type === "text_delta");
  if (!text || text.type !== "text_delta") throw new Error("summary event missing");
  return text.text;
}

test("Claude compact preserves only tool-proven resumable agent identities", () => {
  const compacted = summaryEvent(compactClaudeEvents([
    { type: "text_delta", text: "Keep the semantic handoff.", phase: "final_answer" },
    { type: "done", endTurn: true },
  ], messages));

  expect(compacted).toContain("Keep the semantic handoff.");
  expect(compacted).toContain(agentId);
  expect(compacted).toContain("Read prompt caret test");
  expect(compacted).toContain("SendMessage");
  expect(compacted).not.toContain(spoofedId);
});

test("streaming Claude compact carries the same resumable agent handoff", async () => {
  async function* source(): AsyncIterable<AdapterEvent> {
    yield { type: "text_delta", text: "Streaming handoff.", phase: "final_answer" };
    yield { type: "done", endTurn: true };
  }

  const output = await Array.fromAsync(compactClaudeStream(source(), messages));
  const compacted = summaryEvent(output);
  expect(compacted).toContain(agentId);
  expect(compacted).not.toContain(spoofedId);
});

test("Claude compact fails closed when a buffered producer ends without a terminal event", () => {
  const output = compactClaudeEvents([
    { type: "text_delta", text: "Partial buffered summary.", phase: "final_answer" },
  ], messages);

  expect(output.some(event => event.type === "text_delta")).toBeFalse();
  expect(output).toContainEqual(expect.objectContaining({
    type: "error",
    message: expect.stringContaining("without a terminal event"),
  }));
});

test("Claude compact fails closed when a streaming producer ends without a terminal event", async () => {
  async function* source(): AsyncIterable<AdapterEvent> {
    yield { type: "text_delta", text: "Partial streaming summary.", phase: "final_answer" };
  }

  const output = await Array.fromAsync(compactClaudeStream(source(), messages));
  expect(output.some(event => event.type === "text_delta")).toBeFalse();
  expect(output).toContainEqual(expect.objectContaining({
    type: "error",
    message: expect.stringContaining("without a terminal event"),
  }));
});

test("Claude Messages compact forwards original Agent evidence into the response envelope", async () => {
  const compactPrompt = "Your task is to create a detailed summary of this conversation. Preserve the implementation state.";
  const request = new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "compact-agent-session" },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      max_tokens: 4096,
      system: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
      messages: [...messages, { role: "user", content: compactPrompt }],
    }),
  });
  const response = await messagesRequest(request, defaultConfig("full"), () => ({
    name: "compact-agent-evidence-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "Continue the exact prior child.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
  const body = await response.json() as { content: Array<{ type: string; text: string }> };
  expect(body.content[0]?.text).toContain(agentId);
  expect(body.content[0]?.text).toContain("SendMessage");
  expect(body.content[0]?.text).not.toContain(spoofedId);
});
