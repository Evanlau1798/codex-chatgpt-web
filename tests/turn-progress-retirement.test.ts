import { expect, test } from "bun:test";
import { ChatGptExternalTurnProgress, chatGptExternalProgressIsLive } from "../src/adapters/chatgpt-web/turn-progress";
test("current-turn MCP progress tracks active calls without claiming completion", async () => {
  const progress = new ChatGptExternalTurnProgress();
  expect(chatGptExternalProgressIsLive(progress.snapshot(), 1_000, 60_000)).toBeFalse();

  const changed = progress.waitForChange(0);
  const toolBatchRevision = progress.recordToolBatch(2, 1_000);
  expect(await changed).toEqual({
    revision: 1,
    lastToolBatchRevision: 1,
    activeToolCalls: 2,
    lastProgressAt: 1_000,
  });
  expect(chatGptExternalProgressIsLive(progress.snapshot(), 100_000, 60_000)).toBeTrue();
  const observed = progress.waitForToolBatchObservation(toolBatchRevision);
  await progress.acknowledgeToolBatch(toolBatchRevision);
  await expect(observed).resolves.toBeUndefined();

  progress.recordToolResult(2_000);
  progress.recordToolResult(3_000);
  expect(progress.snapshot()).toEqual({
    revision: 3,
    lastToolBatchRevision: 1,
    activeToolCalls: 0,
    lastProgressAt: 3_000,
  });
  expect(chatGptExternalProgressIsLive(progress.snapshot(), 62_999, 60_000)).toBeTrue();
  expect(chatGptExternalProgressIsLive(progress.snapshot(), 63_000, 60_000)).toBeFalse();
  expect(() => progress.recordToolResult()).toThrow("without an active call");
});

test("current-turn MCP progress wait remains abortable", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const controller = new AbortController();
  const waiting = progress.waitForChange(0, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});

test("tool-boundary observation wait is cancelled by browser settlement", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const revision = progress.recordToolBatch(1);
  const browserSettlement = new AbortController();
  const waiting = progress.waitForToolBatchObservation(revision, browserSettlement.signal);

  browserSettlement.abort();

  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});

test("retiring current-turn MCP progress atomically clears calls and rejects its browser boundary", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const revision = progress.recordToolBatch(2, 1_000);
  const boundary = progress.waitForToolBatchObservation(revision).then(
    () => ({ type: "observed" as const }),
    error => ({ type: "retired" as const, error: error instanceof Error ? error : new Error(String(error)) }),
  );
  const retirement = new Error("MCP invocation retired its turn binding");

  expect(progress.retire(retirement)).toBeTrue();
  expect(progress.retire(new Error("duplicate retirement"))).toBeFalse();
  expect(progress.snapshot()).toEqual({
    revision: 2,
    lastToolBatchRevision: 1,
    activeToolCalls: 0,
    lastProgressAt: 1_000,
  });
  const boundaryOutcome = await boundary;
  expect(boundaryOutcome.type).toBe("retired");
  if (boundaryOutcome.type !== "retired") throw new Error("retired tool boundary was observed as active");
  expect(boundaryOutcome.error).toBe(retirement);
  expect(() => progress.assertToolBatchActive(revision)).toThrow("retired its turn binding");
  expect(() => progress.recordToolBatch(1)).toThrow("retired its turn binding");
  expect(() => progress.recordToolResult()).toThrow("retired its turn binding");
});
