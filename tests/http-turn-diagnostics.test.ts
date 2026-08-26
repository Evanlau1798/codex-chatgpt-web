import { expect, spyOn, test } from "bun:test";
import {
  httpStreamTimingLevel,
  reportHttpStreamTiming,
  safeErrorMetadata,
  type HttpStreamTimingDiagnostic,
} from "../src/http-stream-diagnostics";
import { HttpTurnCounter } from "../src/http-turn-counter";

async function waitForTurnCount(turns: HttpTurnCounter, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (turns.count() !== expected && Date.now() < deadline) await Bun.sleep(5);
  expect(turns.count()).toBe(expected);
}

function timing(overrides: Partial<HttpStreamTimingDiagnostic> = {}): HttpStreamTimingDiagnostic {
  return {
    route: "/v1/responses",
    stage: "lifecycle",
    platform: "win32",
    status: 200,
    requestId: null,
    outcome: "completed",
    headersMs: 1_000,
    firstChunkMs: 1_100,
    maxChunkGapMs: 500,
    totalMs: 5_000,
    chunks: 10,
    bytes: 1_024,
    errorName: null,
    errorCode: null,
    ...overrides,
  };
}

test("suppresses fast routine client closes and reports moderate latency as info", () => {
  const fastRoutineAbort = timing({
    outcome: "aborted",
    errorName: "AbortError",
    errorCode: "unknown",
  });
  const routineAbort = timing({
    outcome: "aborted",
    headersMs: 6_125,
    firstChunkMs: 6_141,
    maxChunkGapMs: 19_502,
    totalMs: 53_008,
    errorName: "AbortError",
    errorCode: "unknown",
  });

  expect(httpStreamTimingLevel(fastRoutineAbort)).toBeNull();
  expect(httpStreamTimingLevel(routineAbort)).toBe("info");
  expect(httpStreamTimingLevel(timing({ outcome: "cancelled" }))).toBeNull();
});

test("keeps failures, incomplete aborts, bad statuses, and severe latency at warning", () => {
  expect(httpStreamTimingLevel(timing({
    outcome: "failed",
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({
    outcome: "aborted",
    chunks: 0,
    bytes: 0,
    firstChunkMs: null,
    errorName: "AbortError",
    errorCode: "unknown",
  }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({ status: 400 }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({
    status: 302,
    outcome: "aborted",
    errorName: "AbortError",
    errorCode: "unknown",
  }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({ headersMs: 10_000 }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({ firstChunkMs: 10_000 }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({ maxChunkGapMs: 30_000 }))).toBe("warning");
  expect(httpStreamTimingLevel(timing({ totalMs: 180_000 }))).toBe("warning");
});

test("uses info for moderate latency and no log level for fast completion", () => {
  expect(httpStreamTimingLevel(timing())).toBeNull();
  expect(httpStreamTimingLevel(timing({ headersMs: 4_999 }))).toBeNull();
  expect(httpStreamTimingLevel(timing({ firstChunkMs: 4_999 }))).toBeNull();
  expect(httpStreamTimingLevel(timing({ maxChunkGapMs: 4_999 }))).toBeNull();
  expect(httpStreamTimingLevel(timing({ totalMs: 59_999 }))).toBeNull();
  expect(httpStreamTimingLevel(timing({ headersMs: 5_000 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ firstChunkMs: 5_000 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ maxChunkGapMs: 5_000 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ totalMs: 60_000 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ headersMs: 9_999 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ firstChunkMs: 9_999 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ maxChunkGapMs: 29_999 }))).toBe("info");
  expect(httpStreamTimingLevel(timing({ totalMs: 179_999 }))).toBe("info");
});

test("writes timing diagnostics to the console level selected by policy", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    reportHttpStreamTiming(timing({ outcome: "aborted", errorName: "AbortError", errorCode: "unknown" }));
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();

    reportHttpStreamTiming(timing({ headersMs: 5_000 }));
    expect(info).toHaveBeenCalledTimes(1);

    reportHttpStreamTiming(timing({ status: 500 }));
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
    info.mockRestore();
  }
});

test("records headers, first chunk, chunk gap, and completion timing without response content", async () => {
  const timings: unknown[] = [];
  let now = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const turns = new HttpTurnCounter(
    () => {},
    timing => timings.push(timing),
    () => now,
  );
  const response = await turns.track(async () => {
    now = 25;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    }), {
      status: 200,
      headers: { "x-request-id": "req_timing-1" },
    });
  }, undefined, "darwin", "/v1/responses");
  const reader = response.body!.getReader();

  now = 40;
  source.enqueue(new TextEncoder().encode("private first chunk"));
  expect((await reader.read()).done).toBe(false);
  now = 100;
  source.enqueue(new TextEncoder().encode("private second chunk"));
  expect((await reader.read()).done).toBe(false);
  now = 120;
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);

  expect(timings).toEqual([{
    route: "/v1/responses",
    stage: "direct",
    platform: "darwin",
    status: 200,
    requestId: "req_timing-1",
    outcome: "completed",
    headersMs: 25,
    firstChunkMs: 40,
    maxChunkGapMs: 60,
    totalMs: 120,
    chunks: 2,
    bytes: 39,
    errorName: null,
    errorCode: null,
  }]);
  expect(JSON.stringify(timings)).not.toContain("private first chunk");
  expect(JSON.stringify(timings)).not.toContain("private second chunk");
});

test("reports a content-free stream failure timing alongside the existing failure event", async () => {
  const failures: unknown[] = [];
  const timings: unknown[] = [];
  let now = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const turns = new HttpTurnCounter(
    failure => failures.push(failure),
    timing => timings.push(timing),
    () => now,
  );
  const response = await turns.track(async () => {
    now = 10;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    }), { status: 200 });
  }, undefined, "darwin", "/v1/responses");
  const reader = response.body!.getReader();

  now = 30;
  source.enqueue(new TextEncoder().encode("safe"));
  expect((await reader.read()).done).toBe(false);
  now = 55;
  source.error(Object.assign(new TypeError("sensitive stream detail"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("sensitive stream detail");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    stage: "direct",
    platform: "darwin",
    chunks: 1,
    bytes: 4,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(timings).toEqual([{
    route: "/v1/responses",
    stage: "direct",
    platform: "darwin",
    status: 200,
    requestId: null,
    outcome: "failed",
    headersMs: 10,
    firstChunkMs: 30,
    maxChunkGapMs: 0,
    totalMs: 55,
    chunks: 1,
    bytes: 4,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(timings)).not.toContain("sensitive stream detail");
});

test("uses the lifecycle observer for content-free timing on Windows", async () => {
  const timings: unknown[] = [];
  let now = 0;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const turns = new HttpTurnCounter(
    () => {},
    timing => timings.push(timing),
    () => now,
  );
  const response = await turns.track(async () => {
    now = 5;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    }), { status: 200 });
  }, undefined, "win32", "/v1/responses/compact");
  const reader = response.body!.getReader();

  now = 20;
  source.enqueue(new TextEncoder().encode("event"));
  await Bun.sleep(0);
  expect((await reader.read()).done).toBe(false);
  now = 35;
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);

  expect(timings).toEqual([{
    route: "/v1/responses/compact",
    stage: "lifecycle",
    platform: "win32",
    status: 200,
    requestId: null,
    outcome: "upstream_completed",
    headersMs: 5,
    firstChunkMs: 20,
    maxChunkGapMs: 0,
    totalMs: 35,
    chunks: 1,
    bytes: 5,
    errorName: null,
    errorCode: null,
  }]);
});

test("does not claim Windows client delivery completion when only upstream completion is observable", async () => {
  const timings: unknown[] = [];
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const turns = new HttpTurnCounter(
    () => {},
    timing => timings.push(timing),
  );
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  })), undefined, "win32", "/v1/responses");

  const clientCancellation = response.body!.cancel("client stopped reading");
  source.enqueue(new TextEncoder().encode("upstream remainder"));
  source.close();
  await clientCancellation;
  await waitForTurnCount(turns, 0);

  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({
    stage: "lifecycle",
    outcome: "upstream_completed",
  });
  expect(timings[0]).not.toMatchObject({ outcome: "completed" });
});

test("maps token-like error metadata to fixed content-safe fallbacks", () => {
  expect(safeErrorMetadata({
    name: "sk_live_privateToken123",
    code: "secret.session.token.456",
  })).toEqual({
    errorName: "Error",
    errorCode: "unknown",
  });
  expect(safeErrorMetadata(Object.assign(new TypeError("private"), { code: "ECONNRESET" }))).toEqual({
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  });
});

test("reports a headers-stage transport failure and keeps the original rejection", async () => {
  const timings: unknown[] = [];
  let now = 0;
  const turns = new HttpTurnCounter(
    () => {},
    timing => timings.push(timing),
    () => now,
  );

  const tracked = turns.track(async () => {
    now = 75;
    throw Object.assign(new TypeError("secret DNS detail"), { code: "ECONNRESET" });
  }, undefined, "win32", "/v1/responses");

  await expect(tracked).rejects.toThrow("secret DNS detail");
  expect(timings).toEqual([{
    route: "/v1/responses",
    stage: "headers",
    platform: "win32",
    status: null,
    requestId: null,
    outcome: "failed",
    headersMs: 75,
    firstChunkMs: null,
    maxChunkGapMs: 0,
    totalMs: 75,
    chunks: 0,
    bytes: 0,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(timings)).not.toContain("secret DNS detail");
});
