import { expect, test } from "bun:test";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

function settledRuntime(overrides: Record<string, unknown> = {}) {
  return {
    mode: "read-only" as const,
    browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
    ...overrides,
  };
}

test("TTL pruning releases a settled retained browser surface", async () => {
  const sessions = new ChatGptTurnSessions(1);
  let released = 0;
  const expired = sessions.getOrCreate("expired", () => settledRuntime({
    conversationKey: "retained-conversation",
    release: async () => { released += 1; },
  }));
  await expired.browserOutcome;
  await Bun.sleep(5);

  sessions.getOrCreate("replacement", () => settledRuntime());
  await Bun.sleep(0);
  expect(released).toBe(1);
});

test("clearing the registry releases settled retained browser surfaces", async () => {
  const sessions = new ChatGptTurnSessions();
  let released = 0;
  const settled = sessions.getOrCreate("settled", () => settledRuntime({
    conversationKey: "retained-conversation",
    release: async () => { released += 1; },
  }));
  await settled.browserOutcome;

  expect(sessions.clear()).toBe(1);
  await Bun.sleep(0);
  expect(released).toBe(1);
});

test("a replacement owner waits for ordinary retirement of the same conversation", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishRelease!: () => void;
  const release = new Promise<void>(resolve => { finishRelease = resolve; });
  const settled = sessions.getOrCreate("old-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    release: async () => { await release; },
  }));
  await settled.browserOutcome;

  const retirement = sessions.retireAndWait("old-owner");
  await Bun.sleep(0);
  let replacements = 0;
  const replacement = sessions.getOrCreateAfterConversationRetirement(
    "new-owner",
    "shared-conversation",
    () => {
      replacements += 1;
      return settledRuntime({ conversationKey: "shared-conversation" });
    },
  );
  await Bun.sleep(0);
  expect(replacements).toBe(0);

  finishRelease();
  expect(await retirement).toBeTrue();
  await replacement;
  expect(replacements).toBe(1);
});

test("an overlapping same-key retirement includes the replacement owner", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishRelease!: () => void;
  const release = new Promise<void>(resolve => { finishRelease = resolve; });
  const settled = sessions.getOrCreate("same-owner", () => settledRuntime({
    release: async () => { await release; },
  }));
  await settled.browserOutcome;

  expect(sessions.retire("same-owner", settled)).toBeTrue();
  let replacementCancelled = 0;
  let replacementReleased = 0;
  sessions.getOrCreate("same-owner", () => settledRuntime({
    cancel: () => { replacementCancelled += 1; },
    release: async () => { replacementReleased += 1; },
  }));
  const overlappingRetirement = sessions.retireAndWait("same-owner");
  await Bun.sleep(0);
  expect(replacementCancelled).toBe(1);
  expect(replacementReleased).toBe(1);

  finishRelease();
  expect(await overlappingRetirement).toBeTrue();
  expect(sessions.find("same-owner")).toBeUndefined();
});
