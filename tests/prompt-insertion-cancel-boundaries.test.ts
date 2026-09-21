import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import type { ChatGptPromptInsertionOptions } from "../src/adapters/chatgpt-web/prompt-insertion-plan";

function cancellationProbe(
  abortAt: string,
  text = "plain fixture",
  options?: ChatGptPromptInsertionOptions,
) {
  const controller = new AbortController();
  const reason = new DOMException("Fixture cancelled", "AbortError");
  const calls: string[] = [];
  let verification = 0;
  const visit = (name: string) => {
    calls.push(name);
    if (name === abortAt) controller.abort(reason);
  };
  const composer = {
    focus: async () => { visit("focus"); },
    evaluate: async (_operation: unknown, input: unknown) => {
      if (typeof input === "object" && input !== null && "replacements" in input) {
        visit("restore");
        return 1; // The tiny synthetic Markdown case has exactly one marker.
      }
      if (Array.isArray(input)) { visit("count-markers"); return 0; }
      visit("edit");
      return true;
    },
  } as unknown as Locator;
  const run = () => insertChatGptPromptText(text, controller.signal, {
    composer: async () => { visit("acquire"); return composer; },
    verify: async () => { visit(`verify-${++verification}`); },
    reanchor: async () => { visit("reanchor"); },
  }, options);
  return { controller, reason, calls, run };
}

for (const options of [undefined, { forceStructuredDirect: true }]) {
  test(`pre-aborted ${options ? "direct" : "chunked"} insertion starts no action`, async () => {
    const probe = cancellationProbe("none", "plain fixture", options);
    probe.controller.abort(probe.reason);
    await assert.rejects(probe.run, error => error === probe.reason);
    assert.deepEqual(probe.calls, []);
  });
}

test("an already cancelled empty default insertion does not report success", async () => {
  const probe = cancellationProbe("none", "");
  probe.controller.abort(probe.reason);
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.deepEqual(probe.calls, []);
});

for (const abortAt of ["verify-1", "acquire", "edit", "verify-2", "verify-3", "reanchor"]) {
  test(`direct insertion stops after cancellation at ${abortAt}`, async () => {
    const probe = cancellationProbe(abortAt, "plain fixture", { forceStructuredDirect: true });
    await assert.rejects(probe.run, error => error === probe.reason);
    assert.equal(probe.calls.at(-1), abortAt);
    assert.equal(probe.calls.filter(call => call === "edit").length <= 1, true);
  });
}

for (const abortAt of ["acquire", "edit", "verify-1", "reanchor"]) {
  test(`chunked insertion stops after cancellation at ${abortAt}`, async () => {
    const probe = cancellationProbe(abortAt, "x".repeat(32_001));
    await assert.rejects(probe.run, error => error === probe.reason);
    assert.equal(probe.calls.at(-1), abortAt);
    assert.equal(probe.calls.filter(call => call === "edit").length <= 1, true);
  });
}

test("cancellation during the final chunk verification cannot return success", async () => {
  const probe = cancellationProbe("verify-1", "plain fixture");
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.equal(probe.calls.at(-1), "verify-1");
});

test("cancellation after guarded prefix verification prevents Markdown restoration", async () => {
  const probe = cancellationProbe("verify-1", "plain_fixture");
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.deepEqual(probe.calls, ["acquire", "focus", "edit", "verify-1"]);
});

test("cancellation at the final restored readback prevents the final caret action", async () => {
  const probe = cancellationProbe("verify-2", "plain_fixture");
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.equal(probe.calls.at(-1), "verify-2");
  assert.equal(probe.calls.includes("restore"), true);
  assert.equal(probe.calls.includes("reanchor"), false);
});

test("an in-flight native operation settles before insertion rejects cancellation", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Fixture cancelled", "AbortError");
  let releaseEdit!: () => void;
  let editStarted!: () => void;
  const started = new Promise<void>(resolve => { editStarted = resolve; });
  const pendingEdit = new Promise<void>(resolve => { releaseEdit = resolve; });
  const calls: string[] = [];
  const composer = {
    focus: async () => {},
    evaluate: async () => { calls.push("edit-started"); editStarted(); await pendingEdit; calls.push("edit-settled"); return true; },
  } as unknown as Locator;
  let settled = false;
  const work = insertChatGptPromptText("plain fixture", controller.signal, {
    composer: async () => composer,
    verify: async () => { calls.push("verify"); },
    reanchor: async () => { calls.push("reanchor"); },
  }, { forceStructuredDirect: true });
  const outcome = work.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  await started;
  controller.abort(reason);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseEdit();
  assert.equal(await outcome, reason);
  assert.deepEqual(calls, ["verify", "edit-started", "edit-settled"]);
});

test("a real verification failure is preserved and does not start recovery or caret work", async () => {
  const failure = new Error("Synthetic integrity failure");
  let acquisitions = 0;
  let anchors = 0;
  await assert.rejects(() => insertChatGptPromptText("plain fixture", undefined, {
    composer: async () => { acquisitions += 1; throw new Error("Unexpected acquisition"); },
    verify: async () => { throw failure; },
    reanchor: async () => { anchors += 1; },
  }, { forceStructuredDirect: true }), error => error === failure);
  assert.equal(acquisitions, 0);
  assert.equal(anchors, 0);
});
