import { expect, test } from "bun:test";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptConversationKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { brokerTestEndpoint, environmentXml, rawWireRequest, tempRoot } from "./chatgpt-harness-fixture";
import type { CodexProviderConfig } from "../src/types";

test("Original compaction retires all response owners of its retained conversation", async () => {
  const socketPath = brokerTestEndpoint(`original-compact-${process.pid}-${Date.now()}`);
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://original-${Date.now()}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: `${tempRoot}/launcher.json`,
      brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true } };
  const request = { ...rawWireRequest(environmentXml), _compactionRequest: true };
  const conversationKey = chatGptConversationKey(request, chatGptWebExecutionNamespace(provider))!;
  expect(conversationKey).toBeString();
  let releases = 0;
  for (const key of ["previous-response-a", "previous-response-b"]) {
    const browser = Promise.resolve("previous final");
    const session = chatGptTurnSessions.getOrCreate(key, () => ({ mode: "read-only", browser,
      physicalSettlement: browser.then(() => {}), conversationKey, retainConversation: true,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
      release: async () => { releases++; } }));
    await session.browserOutcome;
  }
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await createChatGptWebAdapter(provider, { broker, worker: { run: async () => { throw new Error("send failed"); } } })
      .runTurn!(request, { headers: new Headers() }, () => {});
    expect(chatGptTurnSessions.find("previous-response-a")).toBeUndefined();
    expect(chatGptTurnSessions.find("previous-response-b")).toBeUndefined();
    expect(releases).toBe(1);
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});
