import { expect, test } from "bun:test";
import {
  ChatGptBrowserObservationTimeoutError,
  ChatGptObservationRecoveryEpisode,
  ChatGptObservationRecoveryExhaustedError,
  withChatGptPageObservationRecovery,
} from "../src/adapters/chatgpt-web/browser-observation";
import {
  ChatGptViewportReadinessError,
  waitForOperationalChatGptViewport,
} from "../src/adapters/chatgpt-web/browser-stage-lifecycle";

const stalled = () => new ChatGptBrowserObservationTimeoutError(5_000);

test("rebind readiness failure and subsequent observation failure share exactly two attempts", async () => {
  const episode = new ChatGptObservationRecoveryEpisode();
  const attempts: number[] = [];
  const reconnect = async (attempt: number) => {
    attempts.push(attempt);
    if (attempt === 1) throw new ChatGptViewportReadinessError("renderer_unresponsive");
    return "same-page";
  };
  expect(await episode.recover(stalled(), reconnect)).toBe("same-page");
  await expect(episode.recover(stalled(), reconnect)).rejects.toBeInstanceOf(ChatGptObservationRecoveryExhaustedError);
  expect(attempts).toEqual([1, 2]);
  episode.resetAfterObservation();
  expect(await episode.recover(stalled(), reconnect)).toBe("same-page");
  expect(attempts).toEqual([1, 2, 1, 2]);
});

for (const kind of ["viewport_pending", "renderer_unresponsive"] as const) {
  test(`permanent ${kind} is bounded, never expanded to four attempts`, async () => {
    let attempts = 0;
    await expect(new ChatGptObservationRecoveryEpisode().recover(stalled(), async () => {
      attempts++;
      throw new ChatGptViewportReadinessError(kind);
    })).rejects.toBeInstanceOf(ChatGptObservationRecoveryExhaustedError);
    expect(attempts).toBe(2);
  });
}

for (const error of [new ChatGptViewportReadinessError("target_closed"),
  new ChatGptViewportReadinessError("unknown"), new Error("ownership mismatch"), new Error("renderer gone")]) {
  test(`does not retry ${error.message}`, async () => {
    let attempts = 0;
    await expect(new ChatGptObservationRecoveryEpisode().recover(stalled(), async () => {
      attempts++;
      throw error;
    })).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
}

test("same awake deadline shrinks between rebinds and cannot reset with an attempt", async () => {
  let now = 0;
  const observed: number[] = [];
  const episode = new ChatGptObservationRecoveryEpisode(() => 1_000, () => now, 100);
  expect(await episode.recover(stalled(), async (attempt, _cause, _signal, remaining) => {
    observed.push(remaining());
    now += 60;
    if (attempt === 1) throw new ChatGptViewportReadinessError("viewport_pending");
    now = 90;
    return "ready";
  })).toBe("ready");
  expect(observed).toEqual([100, 40]);
});

test("exhausted parent deadline prevents the second rebind", async () => {
  let remaining = 40;
  let attempts = 0;
  const episode = new ChatGptObservationRecoveryEpisode(() => remaining);
  await expect(episode.recover(stalled(), async () => {
    attempts++;
    remaining = 0;
    throw new ChatGptViewportReadinessError("renderer_unresponsive");
  })).rejects.toBeInstanceOf(ChatGptObservationRecoveryExhaustedError);
  expect(attempts).toBe(1);
});

test("episode deadline aborts an in-flight read-side acquisition with no second attempt", async () => {
  let attempts = 0;
  let signal: AbortSignal | undefined;
  await expect(new ChatGptObservationRecoveryEpisode(() => Infinity, undefined, 5)
    .recover(stalled(), async (_attempt, _cause, child) => {
      attempts++; signal = child; return new Promise(() => {});
    })).rejects.toBeInstanceOf(ChatGptObservationRecoveryExhaustedError);
  expect(signal?.aborted).toBe(true);
  expect(attempts).toBe(1);
});

test("caller abort preserves its reason before and after recovery; no second attempt", async () => {
  const controller = new AbortController();
  const reason = new Error("native turn cancelled");
  let attempts = 0;
  await expect(new ChatGptObservationRecoveryEpisode().recover(stalled(), async () => {
    attempts++; controller.abort(reason); return "late page";
  }, controller.signal)).rejects.toBe(reason);
  await expect(new ChatGptObservationRecoveryEpisode().recover(stalled(), async () => {
    attempts++; return "another page";
  }, controller.signal)).rejects.toBe(reason);
  expect(attempts).toBe(1);
});

test("late observation after cancellation cannot be accepted", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel during read");
  await expect(withChatGptPageObservationRecovery({} as never, async () => {
    controller.abort(reason); return "untrusted late result";
  }, undefined, controller.signal)).rejects.toBe(reason);
});

const page = (evaluate: () => Promise<{ width: number; height: number }>, isClosed = () => false) => ({ evaluate, isClosed }) as never;

test("viewport reader accepts only actual operational dimensions", async () => {
  let reads = 0;
  await waitForOperationalChatGptViewport(page(async () => {
    reads++; return reads === 1 ? { width: 0, height: 0 } : { width: 320, height: 240 };
  }), undefined, 200);
  expect(reads).toBe(2);
});

test("responsive small viewport is distinguished from a renderer that never responds", async () => {
  await expect(waitForOperationalChatGptViewport(page(async () => ({ width: 100, height: 200 })), undefined, 5))
    .rejects.toMatchObject({ kind: "viewport_pending", dimensions: { width: 100, height: 200 } });
  let reads = 0;
  await expect(waitForOperationalChatGptViewport(page(() => { reads++; return new Promise(() => {}); }), undefined, 5))
    .rejects.toMatchObject({ kind: "renderer_unresponsive", dimensions: undefined });
  expect(reads).toBe(1);
});

test("closed target and unknown transport failures are not transient readiness", async () => {
  await expect(waitForOperationalChatGptViewport(page(async () => ({ width: 800, height: 600 }), () => true)))
    .rejects.toMatchObject({ kind: "target_closed" });
  const failure = new Error("private transport error body");
  const error = await waitForOperationalChatGptViewport(page(async () => { throw failure; })).catch(error => error);
  expect(error.kind).toBe("unknown");
  expect(error.message).not.toContain("private");
});

test("cancelled viewport returns the original reason, not a zero-size claim", async () => {
  const controller = new AbortController();
  const reason = new Error("original cancellation");
  const pending = waitForOperationalChatGptViewport(page(() => new Promise(() => {})), controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test("same-page acquisition does not recreate a broker binding or replay a delivered call", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaultBrokerEndpoint } = await import("../src/config");
  const { TurnBroker, callTurnBroker } = await import("../src/adapters/chatgpt-web/turn-broker");
  const root = mkdtempSync(join(tmpdir(), "cgw-read-recovery-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{ name: "fixture_echo", description: "Inert fixture", parameters: { type: "object" } }],
    });
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
    const result = callTurnBroker(broker.socketPath, {
      method: "invoke", bindingId, wireName: "fixture_echo", arguments: { value: "safe fixture" },
    });
    const requests = await broker.nextToolBatch(token);
    expect(requests).toHaveLength(1);
    const callId = requests[0]!.callId;
    let completed = false;
    const attempts: number[] = [];
    await new ChatGptObservationRecoveryEpisode().recover(stalled(), async attempt => {
      attempts.push(attempt);
      if (attempt === 1) {
        broker.completeTool(token, callId, { content: [{ type: "text", text: "safe result" }] });
        await expect(result).resolves.toMatchObject({ content: [{ type: "text", text: "safe result" }] });
        completed = true;
        throw new ChatGptViewportReadinessError("viewport_pending");
      }
      expect(completed).toBe(true);
      return "same owned page";
    });
    expect(attempts).toEqual([1, 2]);
    // A second completion of the original call is still rejected by the real broker.
    expect(() => broker.completeTool(token, callId, { content: [] })).toThrow("not pending");
    const emptyQueue = new AbortController();
    const next = broker.nextToolBatch(token, emptyQueue.signal);
    emptyQueue.abort();
    await expect(next).rejects.toThrow("tool wait aborted");
  } finally { await broker.close(); rmSync(root, { recursive: true, force: true }); }
});
