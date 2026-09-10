import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserHelperFenceRegistry } from "../src/adapters/chatgpt-web/browser-helper-fence";
import { BrowserHelperOutputRegistry } from "../src/adapters/chatgpt-web/browser-helper-output";
import { assertLauncherHelperFenceFeatures } from "../src/adapters/chatgpt-web/launcher-helper-fence";
import { forwardLauncherHelperProgress } from "../src/adapters/chatgpt-web/launcher-helper-progress";
import { parseLauncherHelperMessage } from "../src/adapters/chatgpt-web/launcher-helper-protocol";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const fencedTurn = { externalProgress: {} } as BrowserTurn;

test("legacy helpers remain usable only for turns without external MCP progress", () => {
  expect(() => assertLauncherHelperFenceFeatures({} as BrowserTurn, new Set())).not.toThrow();
  expect(() => assertLauncherHelperFenceFeatures({ retryPromptForAnswer: () => undefined } as unknown as BrowserTurn, new Set()))
    .toThrow("answer retries before committing completion");
  expect(() => assertLauncherHelperFenceFeatures(
    { retryPromptForAnswer: () => undefined } as unknown as BrowserTurn,
    new Set(["answer-before-completion"]),
  )).not.toThrow();
  expect(() => assertLauncherHelperFenceFeatures(fencedTurn, new Set(["progress"])))
    .toThrow("tool-boundary acknowledgement");
  expect(() => assertLauncherHelperFenceFeatures(fencedTurn, new Set(["progress", "tool-boundary-ack"])))
    .toThrow("completion fence");
  expect(() => assertLauncherHelperFenceFeatures(
    { tunneledOutput: {} } as BrowserTurn,
    new Set(["progress", "tool-boundary-ack", "completion-fence"]),
  )).toThrow("does not support tunneled Web output");
});

test("helper protocol validates tool boundaries and completion requests", () => {
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "tool_batch_observed", revision: 2,
  }))).toEqual({ type: "event", id: "trace_123", event: "tool_batch_observed", revision: 2 });
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "completion_fence_commit", requestId: 1, revision: -1,
  }))).toThrow("revision is invalid");
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "tunneled_output_seal", requestId: 2, afterSequence: 0,
  }))).toMatchObject({ event: "tunneled_output_seal", requestId: 2, afterSequence: 0 });
});

test("helper fence registry correlates begin and commit acknowledgements", async () => {
  const sent: unknown[] = [];
  const registry = new BrowserHelperFenceRegistry(message => {
    sent.push(message);
    return true;
  }, () => {});
  const transport = registry.start("trace_123", true);
  const begin = transport.completionFence!.begin();
  const beginFrame = sent[0] as { requestId: number };
  registry.resolveBegin("trace_123", beginFrame.requestId, 4);
  expect(await begin).toBe(4);

  const commit = transport.completionFence!.commit(4);
  const commitFrame = sent[1] as { requestId: number };
  registry.resolveCommit("trace_123", commitFrame.requestId, true);
  expect(await commit).toBeTrue();
  registry.end("trace_123");
});

test("ending a helper turn rejects an outstanding completion fence", async () => {
  const registry = new BrowserHelperFenceRegistry(() => true, () => {});
  const pending = registry.start("trace_123", true).completionFence!.begin();
  registry.end("trace_123");
  let failure: unknown;
  try { await pending; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DOMException);
});

test("browser helper mirrors ordered output and acknowledges final reset", async () => {
  const sent: unknown[] = [];
  const registry = new BrowserHelperOutputRegistry(message => { sent.push(message); return true; });
  const output = registry.start("trace_123", true).tunneledOutput!;
  const first = output.next(0);
  registry.apply("trace_123", { sequence: 1, kind: "final", text: "Done." });
  expect(await first).toEqual({ sequence: 1, kind: "final", text: "Done." });
  const reset = output.reset(1);
  const frame = sent[0] as { requestId: number };
  registry.resolveReset("trace_123", frame.requestId, true);
  await expect(reset).resolves.toBeUndefined();
  const retried = output.next(0);
  await expect(Promise.race([
    retried.then(() => "replayed"),
    new Promise(resolve => setTimeout(() => resolve("waiting"), 10)),
  ])).resolves.toBe("waiting");
  registry.apply("trace_123", { sequence: 2, kind: "final", text: "Retried." });
  expect(await retried).toEqual({ sequence: 2, kind: "final", text: "Retried." });
  const sealed = output.seal(2);
  const sealFrame = sent[1] as { requestId: number };
  registry.resolveSeal("trace_123", sealFrame.requestId, true);
  await expect(sealed).resolves.toBeTrue();
  registry.end("trace_123");
});

test("ending a browser helper output mirror rejects a pending reset", async () => {
  const registry = new BrowserHelperOutputRegistry(() => true);
  const output = registry.start("trace_123", true).tunneledOutput!;
  const reset = output.reset(1);
  registry.end("trace_123");
  await expect(reset).rejects.toMatchObject({ name: "AbortError" });
  const source = readFileSync(join(import.meta.dir, "..", "src/adapters/chatgpt-web/browser-helper-main.ts"), "utf8");
  const abort = source.slice(source.indexOf('message.type === "abort"'), source.indexOf('message.type === "progress"'));
  expect(abort.indexOf("tunneledOutputs.end(message.id)")).toBeGreaterThan(-1);
  expect(abort.indexOf("tunneledOutputs.end(message.id)")).toBeLessThan(abort.indexOf(".abort("));
});

test("launcher helper forwards tunneled output once and in broker order", async () => {
  const controller = new AbortController();
  const events = [
    { sequence: 1, kind: "commentary" as const, text: "Working." },
    { sequence: 2, kind: "final" as const, text: "Done." },
  ];
  let index = 0;
  let finish!: () => void;
  const forwarded: unknown[] = [];
  const done = new Promise<void>(resolve => { finish = resolve; });
  const turn = {
    traceId: "trace_123",
    tunneledOutput: {
      next: async (_after: number, signal?: AbortSignal) => {
        const event = events[index++];
        if (event) return event;
        return new Promise<never>((_, reject) => signal?.addEventListener(
          "abort", () => reject(new DOMException("aborted", "AbortError")), { once: true },
        ));
      },
      reset: async () => {},
    },
  } as unknown as BrowserTurn;
  forwardLauncherHelperProgress(turn, new Set(["tunneled-output-v1"]), controller.signal, async message => {
    forwarded.push(message);
    if (forwarded.length === 2) { controller.abort(); finish(); }
  });
  await done;
  expect(forwarded).toEqual(events.map(output => ({ type: "tunneled_output", id: "trace_123", output })));
});

for (const failureAt of ["read", "send"] as const) {
  test(`launcher helper fails the turn when tunneled output ${failureAt} fails`, async () => {
    const controller = new AbortController();
    let failure: Error | undefined;
    const turn = {
      traceId: "trace_123",
      tunneledOutput: {
        next: async () => {
          if (failureAt === "read") throw new Error("output read failed");
          return { sequence: 1, kind: "final" as const, text: "Done." };
        },
        reset: async () => {},
        seal: async () => true,
      },
    } as unknown as BrowserTurn;
    forwardLauncherHelperProgress(
      turn,
      new Set(["tunneled-output-v1"]),
      controller.signal,
      async () => { if (failureAt === "send") throw new Error("output send failed"); },
      error => { failure = error; controller.abort(); },
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failure?.message).toContain(`output ${failureAt} failed`);
  });
}
