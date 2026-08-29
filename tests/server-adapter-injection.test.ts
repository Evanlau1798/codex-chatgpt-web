import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { startServer } from "../src/server";

const jsonHeaders = { "content-type": "application/json" };

function scriptedAdapter(calls: string[]): ProviderAdapter {
  return {
    name: "server-route-script",
    async runTurn(parsed, _incoming, emit) {
      const phase = parsed._compactionRequest ? "compact" : calls.length === 0 ? "responses" : "messages";
      calls.push(phase);
      emit({
        type: "text_delta",
        text: phase === "compact" ? "Deterministic compact summary." : `deterministic ${phase}`,
        phase: "final_answer",
      });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  };
}

test("startServer injects one adapter factory through Responses, Messages, and compact routes", async () => {
  const config = defaultConfig("browser-only");
  config.port = 0;
  const calls: string[] = [];
  const server = startServer(config, { adapterFactory: () => scriptedAdapter(calls) });
  const post = (path: string, body: Record<string, unknown>) => fetch(
    `http://127.0.0.1:${server.port}${path}`,
    { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) },
  );

  try {
    const responses = await post("/v1/responses", {
      model: "chatgpt-web/high",
      input: "Run the deterministic Responses route.",
    });
    expect(responses.status).toBe(200);
    expect(JSON.stringify(await responses.json())).toContain("deterministic responses");

    const messages = await post("/v1/messages", {
      model: "claude-chatgpt-web-high",
      max_tokens: 64,
      messages: [{ role: "user", content: "Run the deterministic Messages route." }],
    });
    expect(messages.status).toBe(200);
    expect(JSON.stringify(await messages.json())).toContain("deterministic messages");

    const compact = await post("/v1/responses/compact", {
      model: "chatgpt-web/high",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Compact me." }] }],
    });
    expect(compact.status).toBe(200);
    expect(JSON.stringify(await compact.json())).toContain(`${SUMMARY_PREFIX}\\nDeterministic compact summary.`);
    expect(calls).toEqual(["responses", "messages", "compact"]);
  } finally {
    await server.stop(true);
  }
});
