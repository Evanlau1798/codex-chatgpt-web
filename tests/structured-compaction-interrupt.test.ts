import { expect, test } from "bun:test";
import { cancelStructuredCompactionNativeTurn, runStructuredCompactionOnce, existingStructuredCompactionRun } from "../src/adapters/chatgpt-web/compaction-handoff";

test("native interruption before registration prevents the detached compaction from starting", async () => {
  const key = `interrupt-before-registration-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const reason = new DOMException("Codex turn interrupted", "AbortError");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    reason,
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;
  const duplicateCancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new Error("duplicate interrupt must not replace the first reason"),
  );
  expect(duplicateCancellation.cancelled).toBe(0);
  await duplicateCancellation.settlement;
  const unrelatedSettlements: Promise<void>[] = [];
  for (let index = 0; index < 1_025; index += 1) {
    const unrelated = cancelStructuredCompactionNativeTurn(
      `thread-unrelated-${key}-${index}`,
      `turn-unrelated-${key}-${index}`,
      new Error(`unrelated interrupt ${index}`),
    );
    unrelatedSettlements.push(unrelated.settlement);
  }
  await Promise.all(unrelatedSettlements);

  let started = false;
  const run = runStructuredCompactionOnce(key, owner, async () => {
    started = true;
    return "must not start";
  });

  await expect(run).rejects.toBe(reason);
  expect(started).toBeFalse();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  let unrelatedStarted = false;
  await expect(runStructuredCompactionOnce(
    `${key}-unrelated`,
    {
      ...owner,
      ownerKey: `${owner.ownerKey}-unrelated`,
      nativeTurnId: `${owner.nativeTurnId}-unrelated`,
    },
    async () => {
      unrelatedStarted = true;
      return "unrelated checkpoint";
    },
  )).resolves.toBe("unrelated checkpoint");
  expect(unrelatedStarted).toBeTrue();
});

test("a completed exact compaction remains replayable after a later native interruption", async () => {
  const key = `completed-before-interrupt-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const completed = runStructuredCompactionOnce(key, owner, async () => "canonical checkpoint");
  await expect(completed).resolves.toBe("canonical checkpoint");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new DOMException("Codex turn interrupted", "AbortError"),
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;

  let restarted = false;
  const replay = runStructuredCompactionOnce(key, owner, async () => {
    restarted = true;
    return "must not replace canonical checkpoint";
  });
  expect(replay).toBe(completed);
  await expect(replay).resolves.toBe("canonical checkpoint");
  expect(restarted).toBeFalse();
});

test("a duplicate native interruption refreshes its lifetime without replacing its reason", async () => {
  const originalNow = Date.now;
  const key = `duplicate-interrupt-refresh-${originalNow()}-${Math.random()}`;
  const initialNow = 1_000_000_000;
  let now = initialNow;
  Date.now = () => now;
  try {
    const owner = {
      ownerKey: `owner-${key}`,
      traceIds: [`trace-${key}`],
      nativeThreadId: `thread-${key}`,
      nativeTurnId: `turn-${key}`,
    };
    const originalReason = new DOMException("first Codex turn interruption", "AbortError");
    cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, originalReason);

    now = initialNow + (29 * 60_000) + 59_000;
    cancelStructuredCompactionNativeTurn(
      owner.nativeThreadId,
      owner.nativeTurnId,
      new Error("duplicate reason must not become authoritative"),
    );

    now = initialNow + (30 * 60_000) + 1_000;
    let started = false;
    const run = runStructuredCompactionOnce(key, owner, async () => {
      started = true;
      return "must not start";
    });
    await expect(run).rejects.toBe(originalReason);
    expect(started).toBeFalse();
  } finally {
    Date.now = originalNow;
  }
});

test("structured compaction rejects incomplete native interruption identities", () => {
  const reason = new DOMException("Codex turn interrupted", "AbortError");
  expect(() => cancelStructuredCompactionNativeTurn(" ", "turn_valid", reason))
    .toThrow("non-empty native thread and turn ids");
  expect(() => runStructuredCompactionOnce(
    `incomplete-native-owner-${Date.now()}-${Math.random()}`,
    { ownerKey: "incomplete-native-owner", traceIds: [], nativeThreadId: "thread_valid" },
    async () => "must not start",
  )).toThrow("non-empty native thread and turn ids");
});
