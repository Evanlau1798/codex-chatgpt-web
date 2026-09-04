import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";

test("same-turn native steering keeps proven authority but cannot hide a newer invalid envelope", () => {
  const root = resolve(process.cwd());
  const item = (text: string, turn = "turn_original") => ({
    type: "message", role: "user", content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn },
  });
  const environment = `<environment_context><cwd>${root}</cwd><sandbox_mode>read-only</sandbox_mode></environment_context>`;
  const body = {
    model: "chatgpt-web/medium",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test", turn_id: "turn_original" }) },
    input: [item(environment), item("Inspect the workspace.")],
  };
  const store = new ChatGptThreadEnvironmentStore();
  store.resolve(parseRequest(body));
  body.input.push(item("Stop and review first."));
  expect(extractChatGptTurnEnvironment(parseRequest(body)).sandboxPolicy.type).toBe("readOnly");
  expect(store.resolve(parseRequest(body)).cwd).toBe(root);
  body.input.push(item("<environment_context><cwd>invalid"), item("Continue."));
  expect(() => store.resolve(parseRequest(body))).toThrow();
  body.input.splice(3);
  body.input[0]!.internal_chat_message_metadata_passthrough.turn_id = "turn_wrong";
  expect(() => store.resolve(parseRequest(body))).toThrow();
});
