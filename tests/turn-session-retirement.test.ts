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

test("retiring a stale owner preserves a retained surface still owned by a newer execution", async () => {
  const sessions = new ChatGptTurnSessions();
  let released = 0;
  const shared = {
    conversationKey: "shared-conversation",
    release: async () => { released += 1; },
  };
  const stale = sessions.getOrCreate("stale-owner", () => settledRuntime(shared));
  const current = sessions.getOrCreate("current-owner", () => settledRuntime(shared));
  await Promise.all([stale.browserOutcome, current.browserOutcome]);

  expect(await sessions.retireAndWait("stale-owner")).toBeTrue();
  expect(released).toBe(0);
  expect(sessions.find("current-owner")).toBe(current);

  expect(await sessions.retireAndWait("current-owner")).toBeTrue();
  expect(released).toBe(1);
});

test("native cancellation releases a shared retained surface only once", async () => {
  const sessions = new ChatGptTurnSessions();
  let released = 0;
  const nativeIdentity = { threadId: "thread-shared", turnId: "turn-shared" };
  const shared = { conversationKey: "shared-conversation", nativeIdentity };
  const first = sessions.getOrCreate("first-owner", () => settledRuntime({
    ...shared,
    release: async () => { released += 1; },
  }));
  const second = sessions.getOrCreate("second-owner", () => settledRuntime({
    ...shared,
    release: async () => { released += 1; },
  }));
  await Promise.all([first.browserOutcome, second.browserOutcome]);

  const cancelled = sessions.cancelNativeTurn("thread-shared", "turn-shared", new Error("interrupted"));
  expect(cancelled.cancelled).toBe(2);
  await cancelled.settlement;
  expect(released).toBe(1);
});

test("a retirement cannot release a same-conversation owner created while settlement is pending", async () => {
  const sessions = new ChatGptTurnSessions();
  let settle!: () => void;
  let released = 0;
  const physicalSettlement = new Promise<void>(resolve => { settle = resolve; });
  const stale = sessions.getOrCreate("stale-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    physicalSettlement,
    release: async () => { released += 1; },
  }));
  await stale.browserOutcome;

  const retirement = sessions.retireAndWait("stale-owner");
  sessions.getOrCreate("new-owner", () => settledRuntime({ conversationKey: "shared-conversation" }));
  settle();
  await retirement;

  expect(released).toBe(0);
  expect(sessions.find("new-owner")).toBeDefined();
});

test("overlapping retirements wait for every shared-conversation settlement and release once", async () => {
  const sessions = new ChatGptTurnSessions();
  let settleFirst!: () => void;
  let settleSecond!: () => void;
  let released = 0;
  const firstSettlement = new Promise<void>(resolve => { settleFirst = resolve; });
  const secondSettlement = new Promise<void>(resolve => { settleSecond = resolve; });
  const shared = {
    conversationKey: "shared-conversation",
    release: async () => { released += 1; },
  };
  sessions.getOrCreate("first-owner", () => settledRuntime({ ...shared, physicalSettlement: firstSettlement }));
  const firstRetirement = sessions.retireAndWait("first-owner");
  sessions.getOrCreate("second-owner", () => settledRuntime({ ...shared, physicalSettlement: secondSettlement }));
  const secondRetirement = sessions.retireAndWait("second-owner");

  settleFirst();
  await Bun.sleep(0);
  expect(released).toBe(0);
  settleSecond();
  await Promise.all([firstRetirement, secondRetirement]);
  expect(released).toBe(1);
});

test("native cancellation waits for every shared-conversation physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settleFirst!: () => void;
  let settleSecond!: () => void;
  let released = 0;
  const firstSettlement = new Promise<void>(resolve => { settleFirst = resolve; });
  const secondSettlement = new Promise<void>(resolve => { settleSecond = resolve; });
  const nativeIdentity = { threadId: "thread-shared", turnId: "turn-shared" };
  sessions.getOrCreate("first-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    nativeIdentity,
    physicalSettlement: firstSettlement,
  }));
  sessions.getOrCreate("second-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    nativeIdentity,
    physicalSettlement: secondSettlement,
    release: async () => { released += 1; },
  }));

  const cancellation = sessions.cancelNativeTurn("thread-shared", "turn-shared", new Error("interrupted"));
  settleSecond();
  await Bun.sleep(0);
  expect(released).toBe(0);
  settleFirst();
  await cancellation.settlement;
  expect(released).toBe(1);
});

test("conversation-wide retirement consumes an older retained release candidate", async () => {
  const sessions = new ChatGptTurnSessions();
  let staleReleased = 0;
  let currentReleased = 0;
  let replacementReleased = 0;
  const stale = sessions.getOrCreate("stale-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    release: async () => { staleReleased += 1; },
  }));
  sessions.getOrCreate("current-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    release: async () => { currentReleased += 1; },
  }));
  await stale.browserOutcome;

  expect(await sessions.retireAndWait("stale-owner")).toBeTrue();
  expect(staleReleased).toBe(0);
  expect(await sessions.retireConversationAndWait("shared-conversation")).toBe(1);
  expect(currentReleased).toBe(1);

  sessions.getOrCreate("replacement-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    release: async () => { replacementReleased += 1; },
  }));
  expect(await sessions.retireAndWait("replacement-owner")).toBeTrue();
  expect(staleReleased).toBe(0);
  expect(replacementReleased).toBe(1);
});

test("conversation-wide retirement rechecks owners after an overlapping retirement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settleStale!: () => void;
  let staleReleased = 0;
  let currentReleased = 0;
  let replacementReleased = 0;
  const staleSettlement = new Promise<void>(resolve => { settleStale = resolve; });
  sessions.getOrCreate("stale-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    physicalSettlement: staleSettlement,
    release: async () => { staleReleased += 1; },
  }));
  sessions.getOrCreate("current-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    release: async () => { currentReleased += 1; },
  }));

  const staleRetirement = sessions.retireAndWait("stale-owner");
  const conversationRetirement = sessions.retireConversationAndWait("shared-conversation");
  settleStale();
  expect(await staleRetirement).toBeTrue();
  expect(await conversationRetirement).toBe(1);
  expect(sessions.find("current-owner")).toBeUndefined();
  expect(staleReleased).toBe(0);
  expect(currentReleased).toBe(1);

  sessions.getOrCreate("replacement-owner", () => settledRuntime({
    conversationKey: "shared-conversation",
    release: async () => { replacementReleased += 1; },
  }));
  expect(await sessions.retireAndWait("replacement-owner")).toBeTrue();
  expect(staleReleased).toBe(0);
  expect(replacementReleased).toBe(1);
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

test("a new execution cannot overlap an active owner of the same conversation", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  let cancelled = 0;
  sessions.getOrCreate("old-execution", () => settledRuntime({
    browser,
    conversationKey: "shared-conversation",
    cancel: () => { cancelled += 1; },
  }));

  let replacements = 0;
  const replacement = sessions.getOrCreateAfterConversationRetirement(
    "new-execution",
    "shared-conversation",
    () => {
      replacements += 1;
      return settledRuntime({ conversationKey: "shared-conversation" });
    },
  );
  await Bun.sleep(0);

  expect(cancelled).toBe(1);
  expect(replacements).toBe(0);

  finishBrowser("cancelled");
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
