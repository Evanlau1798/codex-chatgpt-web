import assert from "node:assert/strict";
import { test } from "node:test";
import { insertChatGptPromptText } from "../src/adapters/chatgpt-web/prompt-insertion";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS, type ChatGptPromptInsertionOptions } from "../src/adapters/chatgpt-web/prompt-insertion-plan";

function cancellationProbe(abortAt: string, text = "plain fixture", options?: ChatGptPromptInsertionOptions) {
  const controller = new AbortController();
  const reason = new DOMException("Fixture cancelled", "AbortError");
  const calls: string[] = [];
  let verification = 0;
  const visit = (name: string) => { calls.push(name); if (name === abortAt) controller.abort(reason); };
  const editor = literalPasteComposer({
    onFocus: () => visit("focus"),
    onPaste: () => visit(`edit-${editor.pastes.length}`),
  });
  const composer = async () => { visit("acquire"); return editor.composer; };
  const run = () => editor.withGlobals(() => insertChatGptPromptText(text, controller.signal, {
    composer,
    verify: async expected => { await editor.verify(expected); visit(`verify-${++verification}`); },
    reanchor: async () => { await editor.reanchor(); visit("reanchor"); },
  }, options));
  return { controller, reason, calls, run, editor };
}

for (const options of [undefined, { forceStructuredDirect: true }]) {
  test(`pre-aborted literal insertion starts no action (legacy flag ${Boolean(options)})`, async () => {
    const probe = cancellationProbe("none", "plain fixture", options);
    probe.controller.abort(probe.reason);
    await assert.rejects(probe.run, error => error === probe.reason);
    assert.deepEqual(probe.calls, []);
    assert.deepEqual(probe.editor.pastes, []);
  });
}

test("an already cancelled empty insertion does not report success", async () => {
  const probe = cancellationProbe("none", "");
  probe.controller.abort(probe.reason);
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.deepEqual(probe.calls, []);
});

for (const abortAt of ["verify-1", "acquire", "focus", "edit-1", "verify-2", "verify-3", "reanchor"]) {
  test(`short literal insertion stops at cancellation boundary ${abortAt}`, async () => {
    const probe = cancellationProbe(abortAt, "plain fixture", { forceStructuredDirect: true });
    await assert.rejects(probe.run, error => error === probe.reason);
    assert.equal(probe.calls.at(-1), abortAt);
    assert.ok(probe.editor.pastes.length <= 1);
  });
}

for (const [abortAt, edits] of [
  ["verify-1", 0], ["acquire", 0], ["focus", 0], ["edit-1", 1],
  ["verify-2", 1], ["edit-2", 2], ["verify-3", 2], ["verify-4", 3],
  ["verify-5", 3], ["reanchor", 3],
] as const) {
  test(`multi-paste insertion stops at ${abortAt} after ${edits} settled edits`, async () => {
    const probe = cancellationProbe(abortAt, "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1));
    await assert.rejects(probe.run, error => error === probe.reason);
    assert.equal(probe.calls.at(-1), abortAt);
    assert.equal(probe.editor.pastes.length, edits);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(probe.calls.at(-1), abortAt);
  });
}

// Retired cancellation-between-marker-restoration tests: there are no replacement
// mutations. Their replacements stop at verified literal prefix and final readback.
test("cancellation after literal prefix verification prevents the next native paste", async () => {
  const probe = cancellationProbe("verify-2", "plain_fixture".repeat(Math.ceil((CHATGPT_LITERAL_PASTE_CHUNK_CHARS + 1) / "plain_fixture".length)));
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.deepEqual(probe.calls, ["verify-1", "acquire", "focus", "edit-1", "verify-2"]);
});

test("cancellation at final full readback prevents the final caret action", async () => {
  const probe = cancellationProbe("verify-3", "plain_fixture");
  await assert.rejects(probe.run, error => error === probe.reason);
  assert.equal(probe.calls.at(-1), "verify-3");
  assert.equal(probe.calls.includes("reanchor"), false);
  assert.equal(probe.editor.pastes.length, 1);
});

test("in-flight public paste settles before insertion rejects cancellation", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Fixture cancelled", "AbortError");
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { started = resolve; });
  const editor = literalPasteComposer({
    afterEvaluate: async input => {
      if (typeof input === "object" && input !== null && "text" in input) { started(); await pending; }
    },
  });
  let settled = false;
  const outcome = editor.run("plain fixture", { signal: controller.signal })
    .then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  await start;
  controller.abort(reason);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(editor.pastes, ["plain fixture"]);
  release();
  assert.equal(await outcome, reason);
  assert.deepEqual(editor.verified, [""]);
  assert.equal(editor.reanchors, 0);
});

test("real verification failure is preserved without acquisition, recovery or caret work", async () => {
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
