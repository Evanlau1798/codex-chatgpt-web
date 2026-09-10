import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { defaultConfig } from "../src/config";
import { messagesRequest } from "../src/messages";
import type { CodexParsedRequest } from "../src/types";

test("Claude streaming usage includes the compiled Enhanced tunnel prompt", async () => {
  const config = defaultConfig("full");
  let parsedForEstimate: CodexParsedRequest | undefined;
  const response = await messagesRequest(new Request("http://127.0.0.1:17841/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": "enhanced-usage-session",
      "x-claude-code-agent-id": "agent-main",
    },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      max_tokens: 1024,
      stream: true,
      system: `You are Claude Code.\n- Primary working directory: ${resolve("claude-project")}`,
      messages: [{ role: "user", content: "Read package.json" }],
      tools: [{
        name: "read_file",
        description: "Read one file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    }),
  }), config, () => ({
    name: "messages-enhanced-usage-test",
    async runTurn(parsed, _incoming, emit) {
      parsedForEstimate = parsed;
      emit({ type: "text_delta", text: "Ready.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  const events = (await response.text()).split("\n").filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  const started = events.find(event => event.type === "message_start");
  const expected = estimateChatGptWebInputTokens(parsedForEstimate!, {
    localToolsEnabled: true,
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
  }, { nativeControlConnector: true, useEnhancedOutputTunnel: true });
  expect(started.message.usage.input_tokens).toBe(expected);
});
