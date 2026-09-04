import { expect, test } from "bun:test";
import { HttpTurnCounter } from "../src/http-turn-counter";

test("native interrupt remembers an exact owner before HTTP identity registration", async () => {
  const counter = new HttpTurnCounter(() => {}, () => {});
  const reason = new DOMException("native user interrupt", "AbortError");
  const cancelled = counter.beginCancelTurn({ threadId: "thread_one", turnId: "turn_one" }, reason);
  expect(cancelled.cancelled).toBe(0);
  await cancelled.settlement;
  let observed: unknown;
  await counter.track(async (signal, bind) => {
    bind({ threadId: "thread_one", turnId: "turn_one" });
    observed = signal.reason;
    return new Response(null, { status: 204 });
  });
  expect(observed).toBe(reason);
  expect(counter.count()).toBe(0);
});

test("native interrupt does not cancel another thread sharing its turn label", async () => {
  const counter = new HttpTurnCounter(() => {}, () => {});
  const controllers: AbortSignal[] = [];
  let finishOther!: () => void;
  const other = new Promise<void>(resolve => { finishOther = resolve; });
  const one = counter.track(async (signal, bind) => {
    bind({ threadId: "thread_one", turnId: "turn_shared" });
    controllers.push(signal);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return new Response(null, { status: 204 });
  });
  const two = counter.track(async (signal, bind) => {
    bind({ threadId: "thread_two", turnId: "turn_shared" });
    controllers.push(signal);
    await other;
    return new Response(null, { status: 204 });
  });
  try {
    const cancelled = counter.beginCancelTurn({ threadId: "thread_one", turnId: "turn_shared" }, new Error("interrupt"));
    expect(cancelled.cancelled).toBe(1);
    await cancelled.settlement;
    expect(controllers.map(signal => signal.aborted)).toEqual([true, false]);
    expect(counter.count()).toBe(1);
  } finally {
    finishOther();
    await Promise.allSettled([one, two]);
  }
  expect(counter.count()).toBe(0);
});

test("a tracked request cannot change its native owner", async () => {
  const counter = new HttpTurnCounter(() => {}, () => {});
  await expect(counter.track(async (_signal, bind) => {
    bind({ threadId: "thread_one", turnId: "turn_one" });
    bind({ threadId: "thread_two", turnId: "turn_one" });
    return new Response(null);
  })).rejects.toThrow("identity");
  expect(counter.count()).toBe(0);
});
