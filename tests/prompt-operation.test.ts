import { expect, test } from "bun:test";
import { ChatGptPromptDeadlineError, ChatGptPromptOperation } from "../src/adapters/chatgpt-web/prompt-operation";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { insertChatGptComposerGuardedText, clearChatGptComposerInput,
  restoreChatGptPromptChunkBoundary, restoreChatGptPromptMarkdown, guardChatGptPromptMarkdown,
  reanchorChatGptComposerCaret } from "../src/adapters/chatgpt-web/prompt-caret";
import { ChatGptPersistentBrowserStateError, runChatGptMutationCleanup } from "../src/browser-mutation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("nested operation budgets never replenish their parent's remaining time", () => {
  let awake = 0;
  const parent = new ChatGptPromptOperation(undefined, () => 90 - awake, () => awake);
  const child = parent.budget(60);
  expect(child.options().timeout).toBe(60);
  awake = 35;
  expect(child.options().timeout).toBe(25);
  expect(child.budget(20_000).options().timeout).toBe(25);
  awake = 60;
  expect(() => child.options()).toThrow(ChatGptPromptDeadlineError);
  expect(parent.options().timeout).toBe(30);
});

test("suspension refunds match the stage's awake-time clock", () => {
  let elapsed = 0; let suspended = 0;
  const op = new ChatGptPromptOperation(undefined, () => 100 - elapsed + suspended, () => elapsed - suspended).budget(80);
  elapsed = 60_020; suspended = 60_000;
  expect(op.options().timeout).toBe(60);
  elapsed += 60;
  expect(() => op.check()).toThrow(ChatGptPromptDeadlineError);
});

for (const helper of ["insert", "clear", "boundary", "markdown", "caret"] as const) {
  test(`${helper}: cancellation during focus/clear prevents the next editor operation`, async () => {
    const controller = new AbortController();
    const reason = new DOMException("fixture cancellation", "AbortError");
    let evaluations = 0; let presses = 0;
    const composer = {
      focus: async () => { controller.abort(reason); },
      fill: async () => { controller.abort(reason); },
      evaluate: async () => { evaluations += 1; return true; },
      press: async () => { presses += 1; },
    } as never;
    const run = helper === "insert" ? () => insertChatGptComposerGuardedText(composer, "text", controller.signal)
      : helper === "clear" ? () => clearChatGptComposerInput(composer, controller.signal)
      : helper === "boundary" ? () => restoreChatGptPromptChunkBoundary(composer, { marker: "\ue000", value: " " }, controller.signal)
      : helper === "markdown" ? () => restoreChatGptPromptMarkdown(composer, "a_b\n", guardChatGptPromptMarkdown("a_b\n")!, controller.signal)
      : () => reanchorChatGptComposerCaret(composer, 2, controller.signal);
    await expect(run()).rejects.toBe(reason);
    expect(evaluations).toBe(0); expect(presses).toBe(0);
  });
}

test("native edit receives the remaining budget after focus, not another full timeout", async () => {
  let remaining = 50;
  const budgets: number[] = [];
  const op = new ChatGptPromptOperation(undefined, () => remaining);
  const composer = {
    focus: async (options: { timeout: number }) => { budgets.push(options.timeout); remaining = 7; },
    evaluate: async (_reader: unknown, _input: unknown, options: { timeout: number }) => { budgets.push(options.timeout); return true; },
  } as never;
  await insertChatGptComposerGuardedText(composer, "fixture", undefined, false, undefined, op);
  expect(budgets).toEqual([50, 7]);
});

test("expired parent prevents a new native edit after successful focus", async () => {
  let remaining = 10; let edits = 0;
  const op = new ChatGptPromptOperation(undefined, () => remaining);
  await expect(insertChatGptComposerGuardedText({
    focus: async () => { remaining = 0; },
    evaluate: async () => { edits += 1; return true; },
  } as never, "fixture", undefined, false, undefined, op)).rejects.toBeInstanceOf(ChatGptPromptDeadlineError);
  expect(edits).toBe(0);
});

test("a cancelled read returns boundedly and ignores a later successful value", async () => {
  const controller = new AbortController(); const pending = deferred<string>();
  const reason = new DOMException("fixture cancel", "AbortError");
  const op = new ChatGptPromptOperation(controller.signal);
  const result = op.read(() => pending.promise).catch(error => error);
  controller.abort(reason);
  expect(await result).toBe(reason);
  pending.resolve("late value");
  await Bun.sleep(0);
  expect(() => op.check()).toThrow(reason);
});

test("an unresponsive reader is a timeout, not an integrity comparison", async () => {
  const op = new ChatGptPromptOperation().budget(15);
  await expect(op.read(() => new Promise(() => {}))).rejects.toMatchObject({
    code: "chatgpt_prompt_attachment_timeout", retryable: false,
  });
});

test("native edits are awaited through cancellation until they actually resolve", async () => {
  const controller = new AbortController(); const pending = deferred<void>();
  const op = new ChatGptPromptOperation(controller.signal); let settled = false;
  const outcome = op.mutate(() => pending.promise).catch(error => error).finally(() => { settled = true; });
  const reason = new DOMException("fixture cancel", "AbortError"); controller.abort(reason);
  await Bun.sleep(0); expect(settled).toBeFalse();
  pending.resolve(); expect(await outcome).toBe(reason);
});

test("a native transport timeout is not treated as proof that the mutation stopped", async () => {
  const timeout = Object.assign(new Error("private editor contents"), { name: "TimeoutError" });
  await expect(new ChatGptPromptOperation().mutate(async () => { throw timeout; }))
    .rejects.toMatchObject({ name: "ChatGptPersistentBrowserStateError", message: "ChatGPT editor mutation settlement could not be confirmed" });
});

test("worker readback passes the same signal and parent budget to acquisition and evaluate", async () => {
  const controller = new AbortController(); const seen: number[] = [];
  let remaining = 40;
  const op = new ChatGptPromptOperation(controller.signal, () => remaining);
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async (_page: unknown, _timeout: number, signal: AbortSignal, operation: ChatGptPromptOperation) => {
      expect(signal).toBe(controller.signal); expect(operation).toBe(op); remaining = 8;
      return { evaluate: async (_fn: unknown, _arg: unknown, options: { signal: AbortSignal; timeout: number }) => {
        expect(options.signal).toBe(controller.signal); seen.push(options.timeout); return "fixture";
      } };
    },
  });
  expect(await worker.attachedPromptText({}, controller.signal, op)).toBe("fixture");
  expect(seen).toEqual([8]);
});

test("worker stage exposes one shrinking budget and preserves the owner's abort reason", async () => {
  const controller = new AbortController();
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  const reason = new DOMException("stage fixture cancel", "AbortError");
  const run = worker.runStage("budget_fixture", "prompt_attachment", 5_000,
    async (signal: AbortSignal, remaining: () => number) => {
      const first = remaining(); await Bun.sleep(5); expect(remaining()).toBeLessThan(first);
      controller.abort(reason); expect(signal.reason).toBe(reason);
    }, controller.signal, undefined, true);
  await expect(run).rejects.toBe(reason);
});

test("independent cleanup is bounded even when its operation ignores cancellation", async () => {
  await expect(runChatGptMutationCleanup(() => new Promise(() => {})))
    .rejects.toBeInstanceOf(ChatGptPersistentBrowserStateError);
}, 7_000);
