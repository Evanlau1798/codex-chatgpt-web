import { expect, test } from "bun:test";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("the production adapter accepts an internal deterministic browser worker", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "browser://worker-injection",
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  };
  const worker = {
    async run(turn: BrowserTurn): Promise<string> {
      const prepared = await turn.prepare();
      prepared.release();
      turn.onTextDelta("deterministic production answer");
      return "deterministic production answer";
    },
    requestPreemptiveRetry: () => false,
  };
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    context: { messages: [{ role: "user", content: "Run production composition.", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "worker-injection-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "worker-injection-thread", turn_id: "worker-injection-turn" }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run production composition." }],
        internal_chat_message_metadata_passthrough: { turn_id: "worker-injection-turn" },
      }],
    },
  };
  const events: AdapterEvent[] = [];

  try {
    await createChatGptWebAdapter(provider, { worker }).runTurn!(
      parsed,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
      .toContain("deterministic production answer");
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    chatGptTurnSessions.clear();
  }
});
