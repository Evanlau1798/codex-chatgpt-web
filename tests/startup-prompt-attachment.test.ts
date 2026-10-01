import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";

test("production startup preparation accepts a token-free archive prefix and excludes compact staging", async () => {
  const primed: string[] = [];
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {}, startupPages: { maintain: async (_key: string, prefix: string) => { primed.push(prefix); } },
  });
  const prepared = { text: 'Harness\n<codex_context_archive>\ncontext_01234567890123456789012345678901\n</codex_context_archive>\n'
    + '<codex_context_json>\n{"version":3,"system":[],"messages":[]}\n</codex_context_json>',
    transport: "native2-archive", images: [] };
  const turn = { modelId: "gpt-5.6-sol", modelFamily: "5.6", capabilities: {}, reasoning: "high" };
  await worker.primeStartupPage(turn, prepared, false);
  expect(primed).toEqual([" Harness\n"]);
  await worker.primeStartupPage({ ...turn, compaction: true }, prepared, false);
  await worker.primeStartupPage(turn, { ...prepared, multipart: {} }, false);
  expect(primed).toEqual([" Harness\n"]);
});

for (const state of ["ready", "changed-harness", "changed-draft", "missing-connector"] as const) {
  test(`production attachment handles a ${state} startup page without stale content`, async () => {
    const prefix = " Harness\n", prompt = "Harness\nlatest request\nturn_current";
    const editor = literalPasteComposer({ initialText: state === "changed-draft" ? "old draft" : prefix });
    const calls: string[] = [];
    const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: {}, activeComposer: async () => editor.composer,
      attachedPromptText: async () => editor.read(),
      connectorIsSelected: async () => state !== "missing-connector",
      selectConnector: async () => { calls.push("select"); editor.setText(" "); return editor.composer; },
      clearChatGptComposerState: async () => { editor.setText(""); },
      insertPromptText: async (_page: unknown, text: string, _signal: unknown, _large: unknown,
        _force: unknown, context: { preparedPrefix?: string }) => {
        await editor.run(text, { connectorSelected: true, existingPrefix: context.preparedPrefix ?? " " });
      },
      assertPromptAttached: async (_page: unknown, text: string) => editor.verify(text),
    });
    const absent: any = { filter: () => absent, last: () => absent, isVisible: async () => false };
    const page = { locator: () => absent, keyboard: { press: async () => editor.moveCaretToEnd() } };
    await worker.attachPrompt(page, prompt, true, undefined, undefined, false, { triggerAttempts: 0 },
      false, false, false, undefined, { traceId: "warm", stage: "attachment",
        preparedPrefix: state === "changed-harness" ? " Different harness\n" : prefix });
    expect(editor.read()).toBe(` ${prompt}`);
    expect(calls).toEqual(state === "ready" ? [] : ["select"]);
    expect(editor.pastes).toEqual([state === "ready" ? prompt.slice(prefix.length - 1) : prompt]);
  });
}
