import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

test("Responses declares that its usage already includes retained reasoning", async () => {
  const config = { ...defaultConfig("full"), proAvailable: true };
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/medium",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply briefly." }] }],
    }),
  }), config, () => ({
    name: "reasoning-usage-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "thinking_delta", thinking: "Visible reasoning summary." });
      emit({ type: "text_delta", text: "Done." });
      emit({
        type: "done",
        endTurn: true,
        usage: { inputTokens: 100, outputTokens: 8, reasoningOutputTokens: 3 },
      });
    },
  }), { rememberState: false });

  expect(response.headers.get("x-reasoning-included")).toBe("true");
  await response.text();
});
