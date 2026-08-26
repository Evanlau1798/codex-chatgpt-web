import { expect, test } from "bun:test";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

test("a replay tombstone cannot bypass physical browser retirement", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishBrowser!: () => void;
  let cancellations = 0;
  const browser = new Promise<string>(resolve => { finishBrowser = () => resolve("done"); });
  const previous = sessions.getOrCreate("previous", () => ({
    mode: "read-only" as const,
    browser,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "shared-conversation",
    cancel: () => { cancellations += 1; },
  }));
  previous.setTerminalError(new Error("replay this failure to the original request"));

  let replacementStarts = 0;
  const replacement = sessions.getOrCreateAfterConversationRetirement(
    "replacement",
    "shared-conversation",
    () => {
      replacementStarts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("replacement done"),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        conversationKey: "shared-conversation",
        cancel: () => {},
      };
    },
  );

  expect(await Promise.race([
    replacement.then(() => "replacement-started" as const),
    Bun.sleep(25).then(() => "retirement-pending" as const),
  ])).toBe("retirement-pending");
  expect(replacementStarts).toBe(0);
  expect(cancellations).toBe(1);

  finishBrowser();
  await replacement;
  expect(replacementStarts).toBe(1);
  sessions.clear();
});
