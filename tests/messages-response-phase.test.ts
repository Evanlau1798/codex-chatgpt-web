import { expect, test } from "bun:test";
import { buildClaudeMessage, streamClaudeMessage } from "../src/messages/response";
import type { AdapterEvent } from "../src/types";

const adjacentTextPhases: AdapterEvent[] = [
  { type: "text_delta", text: "Loading task context.", phase: "commentary" },
  { type: "text_delta", text: "Final answer.", phase: "final_answer" },
  { type: "done", stopReason: "stop", endTurn: true },
];

async function* streamedEvents(): AsyncGenerator<AdapterEvent> {
  yield* adjacentTextPhases;
}

test("preserves adjacent Claude commentary and final text as separate non-streaming blocks", async () => {
  const response = buildClaudeMessage(adjacentTextPhases, {
    model: "claude-chatgpt-web-extra-high",
    inputTokens: 12,
  });

  const body = await response.json() as Record<string, any>;
  expect(body.content).toEqual([
    { type: "text", text: "Loading task context." },
    { type: "text", text: "Final answer." },
  ]);
});

test("preserves adjacent Claude commentary and final text as separate streaming blocks", async () => {
  const stream = streamClaudeMessage(streamedEvents(), {
    model: "claude-chatgpt-web-extra-high",
    inputTokens: 12,
  });
  const body = await new Response(stream).text();
  const events = body.split("\n").filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));

  expect(events.filter(event => event.type === "content_block_start")
    .map(event => [event.index, event.content_block.type]))
    .toEqual([[0, "text"], [1, "text"]]);
  expect(events.filter(event => event.type === "content_block_delta")
    .map(event => [event.index, event.delta.text]))
    .toEqual([[0, "Loading task context."], [1, "Final answer."]]);
});

test("rejects a non-streaming Claude response that ends without a terminal event", async () => {
  const response = buildClaudeMessage([
    { type: "text_delta", text: "Truncated answer.", phase: "final_answer" },
  ], {
    model: "claude-chatgpt-web-extra-high",
    inputTokens: 12,
  });

  expect(response.status).toBe(502);
  const body = await response.json() as { type: string; error: { type: string; message: string } };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("api_error");
  expect(body.error.message).toContain("without a terminal event");
});

test("fails a streaming Claude response that ends without a terminal event", async () => {
  async function* truncatedEvents(): AsyncGenerator<AdapterEvent> {
    yield { type: "text_delta", text: "Truncated answer.", phase: "final_answer" };
  }

  const stream = streamClaudeMessage(truncatedEvents(), {
    model: "claude-chatgpt-web-extra-high",
    inputTokens: 12,
  });
  const body = await new Response(stream).text();
  const events = body.split("\n").filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));

  expect(events.some(event => event.type === "error"
    && event.error.type === "api_error"
    && event.error.message.includes("without a terminal event"))).toBe(true);
  expect(events.some(event => event.type === "message_stop")).toBe(false);
});
