import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { extractChatGptTurnUserText } from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { AdapterEvent } from "../src/types";

const collaborationTools = [{
  type: "namespace",
  name: "collaboration",
  tools: [
    {
      type: "function",
      name: "spawn_agent",
      description: "Spawn a child agent",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", encrypted: true },
          fork_context: { type: "boolean" },
        },
        required: ["message"],
      },
    },
    {
      type: "function",
      name: "wait_agent",
      parameters: {
        type: "object",
        properties: { message: { type: "string", encrypted: true } },
      },
    },
  ],
}] satisfies Array<Record<string, unknown>>;

function v2Request(tools: unknown[] = collaborationTools) {
  return {
    model: "chatgpt-web/extra-high",
    input: [{ role: "user", content: [{ type: "input_text", text: "Delegate one bounded task" }] }],
    tools,
  };
}

async function* toolCallEvents(): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call_v2", name: "collaboration__spawn_agent" };
  yield { type: "tool_call_delta", arguments: '{"message":"review tests"}' };
  yield { type: "tool_call_end" };
  yield { type: "done", endTurn: false, stopReason: "tool_use" };
}

const v2ToolMap = new Map([[
  "collaboration__spawn_agent",
  { namespace: "collaboration", name: "spawn_agent", plaintextArguments: true },
]]);

describe("Codex Multi-Agent V2 plaintext transport", () => {
  test("removes the encrypted schema marker only from supported collaboration message tools", () => {
    const raw = v2Request();
    const snapshot = structuredClone(raw);
    const parsed = parseRequest(raw);
    const spawn = parsed.context.tools?.find(tool => tool.name === "spawn_agent");
    const wait = parsed.context.tools?.find(tool => tool.name === "wait_agent");

    expect(raw).toEqual(snapshot);
    expect(spawn?.namespace).toBe("collaboration");
    expect(spawn?.plaintextArguments).toBe(true);
    expect((spawn?.parameters.properties as Record<string, Record<string, unknown>>).message)
      .not.toHaveProperty("encrypted");
    expect(wait?.plaintextArguments).toBeUndefined();
    expect((wait?.parameters.properties as Record<string, Record<string, unknown>>).message.encrypted)
      .toBe(true);
  });

  test("does not rewrite a matching tool outside the collaboration namespace", () => {
    const parsed = parseRequest(v2Request([{
      ...collaborationTools[0],
      name: "other",
      tools: [collaborationTools[0]!.tools[0]],
    }]));
    const tool = parsed.context.tools?.[0];

    expect(tool?.plaintextArguments).toBeUndefined();
    expect((tool?.parameters.properties as Record<string, Record<string, unknown>>).message.encrypted)
      .toBe(true);
  });

  test("supports each Codex collaboration tool that carries a plaintext message", () => {
    for (const name of ["spawn_agent", "send_message", "followup_task"]) {
      const tool = structuredClone(collaborationTools[0]!.tools[0]);
      tool.name = name;
      const parsed = parseRequest(v2Request([{ ...collaborationTools[0], tools: [tool] }]));
      expect(parsed.context.tools?.[0]?.plaintextArguments).toBe(true);
    }
  });

  test("marks non-stream function calls as direct plaintext V2 messages", () => {
    const response = buildResponseJSON([
      { type: "tool_call_start", id: "call_v2", name: "collaboration__spawn_agent" },
      { type: "tool_call_delta", arguments: '{"message":"review tests"}' },
      { type: "tool_call_end" },
      { type: "done", endTurn: false, stopReason: "tool_use" },
    ], "chatgpt-web/extra-high", { toolNsMap: v2ToolMap });
    const call = (response.output as Array<Record<string, unknown>>)[0];

    expect(call).toMatchObject({
      type: "function_call",
      namespace: "collaboration",
      name: "spawn_agent",
      encrypted_function_args: [],
    });
  });

  test("marks added, done, and completed streaming function-call items", async () => {
    const stream = bridgeToResponsesSSE(
      toolCallEvents(),
      "chatgpt-web/extra-high",
      v2ToolMap,
      undefined,
      undefined,
      undefined,
      2_000,
    );
    const body = await new Response(stream).text();
    const frames = body.split("\n")
      .filter(line => line.startsWith("data: {") )
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const items = frames.flatMap(frame => {
      if (frame.type === "response.output_item.added" || frame.type === "response.output_item.done") {
        return [frame.item as Record<string, unknown>];
      }
      if (frame.type === "response.completed") {
        return ((frame.response as Record<string, unknown>).output ?? []) as Array<Record<string, unknown>>;
      }
      return [];
    }).filter(item => item.type === "function_call");

    expect(items).toHaveLength(3);
    expect(items.every(item => Array.isArray(item.encrypted_function_args)
      && item.encrypted_function_args.length === 0)).toBe(true);
  });

  test("preserves the plaintext marker through the full server mapping", async () => {
    const config = { ...defaultConfig("full"), proAvailable: true, useEnhancedWebSessionMode: true };
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...v2Request(), stream: false }),
    }), config, () => ({
      name: "multi-agent-v2-test",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed.context.tools?.find(tool => tool.name === "spawn_agent")?.plaintextArguments)
          .toBe(true);
        emit({ type: "tool_call_start", id: "call_v2", name: "collaboration__spawn_agent" });
        emit({ type: "tool_call_delta", arguments: '{"message":"review tests"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done", endTurn: false, stopReason: "tool_use" });
      },
    }));
    const body = await response.json() as { output: Array<Record<string, unknown>> };

    expect(body.output[0]).toMatchObject({
      type: "function_call",
      namespace: "collaboration",
      name: "spawn_agent",
      encrypted_function_args: [],
    });
  });

  test("preserves routing metadata for a readable V2 child message", () => {
    const parsed = parseRequest({
      model: "chatgpt-web/extra-high",
      input: [{
        type: "agent_message",
        author: "root",
        recipient: "child",
        content: [{ type: "input_text", text: "Inspect the test directory" }],
      }],
    });

    expect(parsed._opaqueMultiAgentV2Payload).toBeUndefined();
    expect(parsed.context.messages).toContainEqual(expect.objectContaining({
      role: "agentMessage",
      author: "root",
      recipient: "child",
      content: "Inspect the test directory",
    }));
  });

  test("uses a native V2 agent message as the child turn revision", () => {
    const parsed = parseRequest({
      model: "chatgpt-web/extra-high",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_child", parent_thread_id: "thread_parent", turn_id: "turn_child",
      }) },
      input: [{
        type: "agent_message", author: "root", recipient: "child",
        content: [{ type: "input_text", text: "Inspect the test directory" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_child" },
      }],
    });

    expect(extractChatGptTurnUserText(parsed)).toBe("Inspect the test directory");
  });
});
