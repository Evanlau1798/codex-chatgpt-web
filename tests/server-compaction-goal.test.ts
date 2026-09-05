import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";

test("v1 goal compaction authorizes the human instruction retained by Codex", async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: "thread_goal_compaction", turn_id: "turn_goal_continuation" };
  const source = {
    type: "message", role: "user", id: "msg_human",
    content: [{ type: "input_text", text: "Finish the requested work" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_human", content_item_kinds: ["user.text"] },
  };
  const goal = {
    type: "message", role: "user", id: "msg_goal_context",
    content: [{ type: "input_text", text: '<codex_internal_context source="goal">\nContinue the active goal.\n</codex_internal_context>' }],
    internal_chat_message_metadata_passthrough: {
      turn_id: metadata.turn_id,
      content_item_kinds: ["goal.internal_context"],
    },
  };
  const original = {
    model: "chatgpt-web/high",
    stream: false,
    input: [source, goal],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const compactAdapter = (): ProviderAdapter => ({
    name: "goal-compactor",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "Continue the current verified goal.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify(original),
  }), config, compactAdapter);
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: Array<{ id?: string }> };
  expect(compacted.output).not.toContainEqual(expect.objectContaining({ id: goal.id }));

  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    body: JSON.stringify({ ...original, input: compacted.output }),
  }), config, () => ({
    name: "goal-continuation",
    async runTurn(parsed, _incoming, emit) {
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      emit({ type: "text_delta", text: "Goal continued", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
  expect(response.status).toBe(200);
  expect((await response.json() as { status: string }).status).toBe("completed");
});
