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
