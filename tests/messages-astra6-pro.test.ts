import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { messagesRequest } from "../src/messages";
import { claudeGatewayModels } from "../src/messages/models";

const model = "claude-chatgpt-web-gpt-6-pro";

function request() {
  return new Request("http://127.0.0.1:17841/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "astra6-model-contract" },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: `Primary working directory: ${resolve("astra6-project")}` },
        { role: "user", content: "Confirm this model route without using tools." },
      ],
    }),
  });
}

test("Claude gateway advertises the exact account-gated Astra 6 Pro alias", () => {
  const config = defaultConfig("full");
  config.proAvailable = true;
  expect(claudeGatewayModels(config).find(row => row.id === model)).toMatchObject({
    id: model,
    display_name: "GPT-6 Pro (Web)",
    max_input_tokens: expect.any(Number),
  });
  config.proAvailable = false;
  expect(claudeGatewayModels(config).some(row => row.id === model)).toBeFalse();
});

test("Claude's Astra 6 Pro alias reaches the production browser worker as family 6 and Max", async () => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  let browserCalls = 0;
  const worker = {
    async run(turn: BrowserTurn) {
      browserCalls += 1;
      expect(turn.modelId).toBe("gpt-5.6-sol"); // Internal context profile, not the selected browser family.
      expect(turn.modelFamily).toBe("6");
      expect(turn.reasoning).toBe("max");
      expect(turn.capabilities.proAvailable).toBeTrue();
      expect(turn.capabilities.localToolsEnabled).toBeFalse();
      const prepared = await turn.prepare();
      prepared.release();
      turn.onTextDelta("Verified the local 6 Pro route.");
      return "Verified the local 6 Pro route.";
    },
    requestPreemptiveRetry: () => false,
  };
  try {
    const response = await messagesRequest(request(), config, provider => createChatGptWebAdapter(provider, { worker }));
    expect(response.status).toBe(200);
    expect(browserCalls).toBe(1);
    expect(await response.json()).toMatchObject({
      model,
      stop_reason: "end_turn",
      content: expect.arrayContaining([{ type: "text", text: "Verified the local 6 Pro route." }]),
    });
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("unavailable Astra 6 Pro fails before adapter construction rather than selecting another model", async () => {
  const config = defaultConfig("full");
  config.proAvailable = false;
  let adapterCalls = 0;
  const response = await messagesRequest(request(), config, () => {
    adapterCalls += 1;
    throw new Error("An unavailable model must not construct an adapter");
  });
  expect(response.status).toBe(400);
  expect(adapterCalls).toBe(0);
  expect(await response.text()).toContain("not available");
});
