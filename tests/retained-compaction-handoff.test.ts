import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_HANDOFF_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { requestRetainedCompactionHandoff } from "../src/adapters/chatgpt-web/retained-compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, chatGptConversationKey } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import type { CodexParsedRequest } from "../src/types";

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }] },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      prompt_cache_key: "thread_retained_compact",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_retained_compact", turn_id: compaction ? "turn_compact" : "turn_source",
      }) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" } }],
    },
  };
}

test("retained Enhanced compact ignores marker-only Web finals and keeps the Native2 control connector", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-retained-marker-only-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const namespace = createHash("sha256").update("retained-compact-test").digest("hex");
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("done"), trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(), usageInput: sourceRequest, cancel: () => {},
  });
  let turn: BrowserTurn | undefined;
  const worker = { run: async (value: BrowserTurn) => {
    turn = value;
    return `${COMPACTION_HANDOFF_MARKER}\nThe retained Web Agent preserved the completed turn.`;
  } };
  try {
    const handoff = await requestRetainedCompactionHandoff(
      worker as never,
      request(true),
      source,
      broker,
      namespace,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "trace12345678",
      undefined,
      20,
    );

    expect(handoff).toBeUndefined();
    expect(turn?.conversationKey).toBe(chatGptConversationKey(sourceRequest, namespace));
    expect(turn?.requireRetainedConversation).toBeTrue();
    expect(turn?.nativeConnector).toBeTrue();
    expect(turn?.capabilities.localToolsEnabled).toBeFalse();
    const prepared = await turn!.prepare();
    expect(prepared.text).toContain("codex.control.compaction_handoff");
    expect(prepared.text).not.toContain(COMPACTION_HANDOFF_MARKER);
    expect(prepared.text).not.toContain("Inspect the project");
    prepared.release();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
