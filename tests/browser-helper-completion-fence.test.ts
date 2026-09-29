import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserHelperFenceRegistry } from "../src/adapters/chatgpt-web/browser-helper-fence";
import { BrowserHelperOutputRegistry } from "../src/adapters/chatgpt-web/browser-helper-output";
import { assertLauncherHelperFenceFeatures, handleLauncherHelperFenceEvent } from "../src/adapters/chatgpt-web/launcher-helper-fence";
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
  expect(() => assertLauncherHelperFenceFeatures(
    { beginFinalizationOnly: async () => true } as unknown as BrowserTurn,
    new Set(["completion-fence"]),
  )).toThrow("finalization CAS");
  expect(() => assertLauncherHelperFenceFeatures(
    { cancelFinalizationOnly: async () => true } as unknown as BrowserTurn,
    new Set(["finalization-cas-v1"]),
  )).toThrow("finalization cancellation");
});

test("helper protocol validates tool boundaries and completion requests", () => {
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "tool_batch_observed", revision: 2,
  }))).toEqual({ type: "event", id: "trace_123", event: "tool_batch_observed", revision: 2 });
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "completion_fence_commit", requestId: 1, revision: -1,
  }))).toThrow("revision is invalid");
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "tunneled_output_seal", requestId: 2, afterSequence: 0, expectedRevision: 3,
  }))).toMatchObject({ event: "tunneled_output_seal", requestId: 2, afterSequence: 0, expectedRevision: 3 });
  expect(() => parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "tunneled_output_seal", requestId: 2, afterSequence: 0,
  }))).toThrow("output seal is invalid");
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "finalization_begin", requestId: 3, expectedRevision: 4,
  }))).toMatchObject({ event: "finalization_begin", requestId: 3, expectedRevision: 4 });
  expect(parseLauncherHelperMessage(JSON.stringify({
    type: "event", id: "trace_123", event: "finalization_cancel", requestId: 4, expectedRevision: 5,
  }))).toMatchObject({ event: "finalization_cancel", requestId: 4, expectedRevision: 5 });
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
  const sealed = output.seal(2, 3);
  const sealFrame = sent[1] as { requestId: number };
  expect(sent[1]).toMatchObject({ event: "tunneled_output_seal", afterSequence: 2, expectedRevision: 3 });
  registry.resolveSeal("trace_123", sealFrame.requestId, true);
  await expect(sealed).resolves.toBeTrue();
  registry.end("trace_123");
});

test("helper fence registry correlates finalization CAS acknowledgements", async () => {
  const sent: unknown[] = [];
  const registry = new BrowserHelperFenceRegistry(message => { sent.push(message); return true; }, () => {});
  const transport = registry.start("trace_123", true) as BrowserTurn;
  const pending = transport.beginFinalizationOnly!(7);
  const frame = sent[0] as { requestId: number };
  expect(sent[0]).toMatchObject({ event: "finalization_begin", expectedRevision: 7 });
  (registry as unknown as { resolveFinalization(id: string, requestId: number, started: boolean): void })
    .resolveFinalization("trace_123", frame.requestId, true);
  await expect(pending).resolves.toBeTrue();
  const confirmation = transport.armFinalizationOutput!(8);
  const confirmationFrame = sent[1] as { requestId: number };
  expect(sent[1]).toMatchObject({ event: "finalization_output_arm", expectedRevision: 8 });
  registry.resolveFinalizationOutput("trace_123", confirmationFrame.requestId, true);
  await expect(confirmation).resolves.toBeTrue();
  registry.end("trace_123");
});

test("helper fence registry correlates finalization cancellation acknowledgements", async () => {
  const sent: unknown[] = [];
  const registry = new BrowserHelperFenceRegistry(message => { sent.push(message); return true; }, () => {});
  const transport = registry.start("trace_123", true) as BrowserTurn;
  const pending = transport.cancelFinalizationOnly!(8);
  const frame = sent[0] as { requestId: number };
  expect(sent[0]).toMatchObject({ event: "finalization_cancel", expectedRevision: 8 });
  registry.resolveFinalizationCancel("trace_123", frame.requestId, true);
  await expect(pending).resolves.toBeTrue();
  registry.end("trace_123");
});

test("launcher helper forwards finalization CAS to the daemon turn", async () => {
  const sent: unknown[] = [];
  let sealed = 0;
  let reopened = 0;
  const turn = {
    beginFinalizationOnly: async (revision: number) => revision === 9,
    finalAnswerAdmission: {
      seal: () => { sealed += 1; return true; },
      reopen: () => { reopened += 1; },
    },
  } as BrowserTurn;
  handleLauncherHelperFenceEvent(
    { type: "event", id: "trace_123", event: "finalization_begin", requestId: 4, expectedRevision: 9 },
    turn,
    () => true,
    async message => { sent.push(message); },
    error => { throw error; },
  );
  await Bun.sleep(0);
  expect(sent).toEqual([{ type: "finalization_begin_ack", id: "trace_123", requestId: 4, started: true }]);
  expect(sealed).toBe(1);
  expect(reopened).toBe(0);
});

test("launcher helper arms final output only after the recovery browser submission", async () => {
  const sent: unknown[] = [];
  let reopened = 0;
  const turn = {
    armFinalizationOutput: async (revision: number) => revision === 10,
    finalAnswerAdmission: { seal: () => true, reopen: () => { reopened += 1; } },
  } as BrowserTurn;
  handleLauncherHelperFenceEvent(
    { type: "event", id: "trace_123", event: "finalization_output_arm", requestId: 5, expectedRevision: 10 },
    turn,
    () => true,
    async message => { sent.push(message); },
    error => { throw error; },
  );
  await Bun.sleep(0);
  expect(sent).toEqual([{ type: "finalization_output_arm_ack", id: "trace_123", requestId: 5, armed: true }]);
  expect(reopened).toBe(1);
});

test("launcher helper reopens daemon admission when unsent finalization is cancelled", async () => {
  const sent: unknown[] = [];
  let reopened = 0;
  const turn = {
    cancelFinalizationOnly: async (revision: number) => revision === 10,
    finalAnswerAdmission: { seal: () => true, reopen: () => { reopened += 1; } },
  } as BrowserTurn;
  handleLauncherHelperFenceEvent(
    { type: "event", id: "trace_123", event: "finalization_cancel", requestId: 6, expectedRevision: 10 },
    turn,
    () => true,
    async message => { sent.push(message); },
    error => { throw error; },
  );
  await Bun.sleep(0);
  expect(sent).toEqual([{ type: "finalization_cancel_ack", id: "trace_123", requestId: 6, cancelled: true }]);
  expect(reopened).toBe(1);
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
