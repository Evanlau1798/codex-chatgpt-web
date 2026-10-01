import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

test.each([true, false])("production insertion reads only prefixes needed by its writer (prepared=%s)", async prepared => {
  const prefix = prepared ? " Harness\n" : " ";
  const prompt = `${prefix}new **literal** request\nturn_current`;
  const editor = literalPasteComposer({ initialText: prefix, connector: true });
  const readbacks: number[] = [];
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {}, activeComposer: async () => editor.composer,
    attachedPromptText: async () => { readbacks.push(editor.read().length); return editor.read(); },
    reanchorPromptCaret: () => editor.reanchor(),
  });
  await editor.withGlobals(() => worker.insertPromptText({}, prompt, undefined, false, false,
    { traceId: "readback", stage: "prompt_attachment", ...(prepared ? { preparedPrefix: prefix } : {}) }, true));
  expect(editor.read()).toBe(prompt);
  expect(editor.pastes).toEqual([prompt.slice(prefix.length)]);
  expect(readbacks).toEqual([prefix.length, prompt.length]);
});

test("a supplied prepared prefix is still verified before any paste", async () => {
  const editor = literalPasteComposer({ initialText: "changed draft", connector: true });
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {}, activeComposer: async () => editor.composer,
    waitForPromptChunkAttached: (_page: unknown, expected: string) => editor.verify(expected),
    reanchorPromptCaret: () => editor.reanchor(),
  });
  await expect(editor.withGlobals(() => worker.insertPromptText({}, " Harness\nrequest", undefined,
    false, false, { traceId: "readback", stage: "prompt_attachment", preparedPrefix: " Harness\n" }, true)))
    .rejects.toThrow("integrity mismatch");
  expect(editor.pastes).toEqual([]);
});
