import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { ChatGptPromptOperation } from "../src/adapters/chatgpt-web/prompt-operation";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

// Retired restored-prefix marker mutation: prefix drift still must stop the writer
// before another irreversible transaction, now through full independent DOM readback.
test("production worker preserves literal Markdown when the editor remounts between pastes", async () => {
  const prompt = "```json\n" + "field *bold* value ".repeat(Math.ceil(CHATGPT_LITERAL_PASTE_CHUNK_CHARS / "field *bold* value ".length)) + "\n```\ntail";
  const editor = literalPasteComposer({ onPaste: () => editor.remount() });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {}, activeComposer: async () => editor.composer,
    reanchorPromptCaret: async () => editor.reanchor(),
  });
  await editor.withGlobals(() => worker.insertPromptText({}, prompt));
  expect(editor.read()).toBe(prompt);
  expect(editor.pastes.join("")).toBe(prompt);
  expect(editor.pastes).toHaveLength(2);
  expect(editor.reanchors).toBe(1);
});

test("stale selection after remount is recovered before the next paste without duplicating content", async () => {
  const prompt = "a".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS) + "tail";
  const editor = literalPasteComposer({ onPaste: (_value, index) => { if (index === 1) editor.remount(true); } });
  await editor.run(prompt);
  expect(editor.pastes).toEqual(["a".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS), "tail"]);
  expect(editor.read()).toBe(prompt);
  expect(editor.reanchors).toBe(2);
});

test("asynchronous prefix drift is rejected by the production worker before another paste", async () => {
  const prompt = "a".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS) + " tail";
  const editor = literalPasteComposer({
    afterEvaluate: async input => {
      if (typeof input === "object" && input !== null && "text" in input) {
        await Bun.sleep(0);
        editor.remount();
        editor.setText("x" + editor.read().slice(1));
      }
    },
  });
  let now = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {}, activeComposer: async () => editor.composer,
    attachedPromptText: async (...args: any[]) => {
      const observed = await (ChatGptBrowserWorker.prototype as any).attachedPromptText.apply(worker, args);
      if (observed) setTimeout(() => { now = 20_001; }, 0);
      return observed;
    },
    reanchorPromptCaret: async () => editor.reanchor(),
  });
  // Advance only the settling clock after the real read has observed the mismatch.
  const operation = new ChatGptPromptOperation(undefined, undefined, () => now);
  await expect(editor.withGlobals(() => worker.insertPromptText({}, prompt, undefined, false, false,
    { traceId: "drift-fixture", stage: "attachment", operation }))).rejects.toThrow("did not commit");
  expect(editor.pastes).toHaveLength(1);
  expect(editor.reanchors).toBe(0);
});

test("keeps a surrogate pair inside one bounded edit after a remount", async () => {
  const prompt = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1) + "😀tail";
  const editor = literalPasteComposer({ onPaste: () => editor.remount() });
  await editor.run(prompt);
  expect(editor.pastes[0]!.length).toBe(CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1);
  expect(editor.pastes[1]!.startsWith("😀")).toBeTrue();
  expect(editor.read()).toBe(prompt);
});

test("abort after an editor remount prevents another bounded edit", async () => {
  const controller = new AbortController();
  const editor = literalPasteComposer({ onPaste: () => { editor.remount(); controller.abort(); } });
  await expect(editor.run("x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1),
    { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(editor.pastes).toHaveLength(1);
  expect(editor.read()).toBe(editor.pastes[0]!);
  expect(editor.reanchors).toBe(0);
});
