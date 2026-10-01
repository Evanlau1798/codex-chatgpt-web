import { expect, test } from "bun:test";
import { CHATGPT_LITERAL_PASTE_CHUNK_CHARS, planChatGptPromptInsertion } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { ChatGptCandidateAttachmentBudget } from "../src/adapters/chatgpt-web/prompt-candidate-budget";
import { ChatGptPromptInsertionMetrics } from "../src/adapters/chatgpt-web/prompt-insertion-metrics";
import { resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { literalPasteComposer } from "./fixtures/literal-paste-composer";
import { providerConfig, defaultConfig } from "../src/config";

// Retired candidate/direct-HTML thresholds: old options are compatibility inputs only.
for (const size of [CHATGPT_LITERAL_PASTE_CHUNK_CHARS - 1, CHATGPT_LITERAL_PASTE_CHUNK_CHARS,
  CHATGPT_LITERAL_PASTE_CHUNK_CHARS + 1, CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2,
  CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1, 330000]) {
  test(`candidate flags cannot change literal paste strategy at ${size}`, () => {
    const text = "x".repeat(size);
    const plan = planChatGptPromptInsertion(text);
    expect(plan.strategy).toBe("literal-paste");
    expect(planChatGptPromptInsertion(text, { candidatePlainText: true })).toEqual(plan);
    expect(planChatGptPromptInsertion(text, { largeStructuredDirect: true, candidatePlainText: true })).toEqual(plan);
  });
}
for (const suffix of ["\r\n\0", "\u00a0\u2028", "\n```\n**[x](y)\n```\n", "👩‍💻e\u0301"]) {
  test(`candidate keeps literal input category ${JSON.stringify(suffix)}`, () => {
    const text = "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1) + suffix;
    const plan = planChatGptPromptInsertion(text, { candidatePlainText: true });
    expect(plan.strategy).toBe("literal-paste");
    expect(plan.utf16Units).toBe(text.length);
  });
}
test("candidate opt-in survives provider and resolved helper configuration", () => {
  const config = defaultConfig();
  expect(resolveBrowserConfig(providerConfig(config)).experimentalComposerPlainText).toBeUndefined();
  config.experimentalComposerPlainText = true;
  expect(resolveBrowserConfig(providerConfig(config)).experimentalComposerPlainText).toBeTrue();
});
test("progress cannot refill a hard deadline or pass a no-progress limit", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("x".repeat(40000), { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, s => budget.observe(s), () => now);
  expect(budget.remainingMs()).toBe(90000);
  await metrics.run("insert", async () => {});
  now = 19000;
  await metrics.run("verify", async () => metrics.verified(100));
  expect(budget.remainingMs()).toBe(20000);
  now = 38000;
  await metrics.run("verify", async () => metrics.verified(100));
  expect(budget.remainingMs()).toBe(1000);
  now = 39000;
  expect(() => budget.remainingMs()).toThrow("no verified progress");
  now = 90000;
  expect(budget.remainingMs()).toBe(0);
});
// Marker reductions are retired; each real paste settlement grants a bounded
// readback window without refilling the original hard deadline.
test("settled paste transactions grant readback time without replenishing the deadline", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("*".repeat(100));
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, s => budget.observe(s), () => now);
  for (const time of [19000, 38000, 57000]) {
    await metrics.run("insert", async () => {
      metrics.editStarted();
      now = time;
      metrics.editSettled({ result: true, attempts: 1, accepted: 1 });
      expect(budget.remainingMs()).toBe(20000);
    });
  }
  now = 90000;
  expect(budget.remainingMs()).toBe(0);
});

test("combined legacy flags retain the same normalized writer choice", () => {
  const text = "x".repeat(40000);
  expect(planChatGptPromptInsertion(text, { candidatePlainText: true, forceStructuredDirect: true }).strategy).toBe("literal-paste");
  expect(planChatGptPromptInsertion(text + "\r", { candidatePlainText: true, largeStructuredDirect: true }).strategy).toBe("literal-paste");
});

test("actual attachment caller shares its plan and remaining budget with staging and inline writers", async () => {
  const { ChatGptBrowserWorker } = await import("../src/adapters/chatgpt-web/browser-worker");
  const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
  const seen: Array<{ text: string; context: any }> = [];
  const asserted: Array<{ text: string; preserveLeading: boolean }> = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { experimentalComposerPlainText: true },
    activeComposer: async () => ({ fill: async () => {}, focus: async () => {} }),
    selectConnector: async () => ({ focus: async () => {} }),
    insertPromptText: async (_page: unknown, text: string, _signal: unknown, _large: boolean, _force: boolean, context: any) => { seen.push({ text, context }); },
    assertPromptAttached: async (_page: unknown, text: string, _signal: unknown, _operation: unknown,
      preserveLeading: boolean) => { asserted.push({ text, preserveLeading }); },
  });
  const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
  const page = { keyboard: { press: async () => {} }, locator: () => absentDialog };
  const parent = new ChatGptPromptOperation(undefined, () => 5000);
  for (const [tools, inline] of [[false, false], [true, false], [false, true]]) {
    await worker.attachPrompt(page, "x".repeat(33000), tools, undefined, undefined, false,
      { triggerAttempts: 0 }, false, inline, false, undefined, { traceId: "fixture", stage: "attachment", operation: parent });
  }
  expect(seen.map(s => s.context.insertionPlan.strategy)).toEqual(["literal-paste", "literal-paste", "literal-paste"]);
  for (const value of seen) {
    expect(value.context.candidateBudget.plan).toBe(value.context.insertionPlan);
    expect(value.context.insertionPlan.utf16Units).toBe(value.text.length);
    expect(value.context.operation.timeLeft()).toBeLessThanOrEqual(5000);
  }
  expect(seen[1]!.text.startsWith(" ")).toBeTrue();
  const multiline = `${"x".repeat(33000)}\nlast line`;
  await worker.attachPrompt(page, multiline, false, undefined, undefined, false,
    { triggerAttempts: 0 }, false, true, false, undefined,
    { traceId: "fixture", stage: "attachment", operation: parent });
  await worker.attachPrompt(page, multiline, true, undefined, undefined, false,
    { triggerAttempts: 0 }, false, true, false, undefined,
    { traceId: "fixture", stage: "attachment", operation: parent });
  expect(seen.slice(-2).map(value => value.context.insertionPlan.strategy))
    .toEqual(["literal-paste", "literal-paste"]);
  expect(asserted.slice(-2)).toEqual([
    { text: multiline, preserveLeading: true },
    { text: ` ${multiline}`, preserveLeading: true },
  ]);
});

test("worker reuses only one exact connector separator for short and bounded long insertion", async () => {
  const { ChatGptBrowserWorker } = await import("../src/adapters/chatgpt-web/browser-worker");
  for (const text of [" short", " " + "x".repeat(CHATGPT_LITERAL_PASTE_CHUNK_CHARS * 2 + 1) + "\nend"]) {
    for (const before of [" ", "", "  ", "\u00a0"]) {
      const editor = literalPasteComposer({ initialText: before, connector: true });
      let reads = 0;
      const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
        config: {},
        attachedPromptText: async (_page: unknown, _signal: unknown, _op: unknown, preserveLeading: boolean) => {
          expect(preserveLeading).toBeTrue(); reads += 1; return editor.read();
        },
        activeComposer: async () => editor.composer,
        waitForPromptChunkAttached: async (_page: unknown, expected: string, _signal: unknown, _op: unknown,
          preserveLeading: boolean) => { expect(preserveLeading).toBeTrue(); await editor.verify(expected); },
        reanchorPromptCaret: async () => editor.reanchor(),
      });
      const run = () => editor.withGlobals(() => worker.insertPromptText({}, text, undefined, true, false, undefined, true));
      if (before === " " || before === "") {
        await run();
        expect(editor.pastes.join("")).toBe(before === " " ? text.slice(1) : text);
        expect(editor.read()).toBe(text);
        expect(editor.verified.at(-1)).toBe(text);
      } else {
        await expect(run()).rejects.toThrow("integrity mismatch");
        expect(editor.pastes).toHaveLength(1);
        expect(editor.reanchors).toBe(0);
      }
      expect(reads).toBe(1);
      expect(editor.pastes.every(value => value.length <= CHATGPT_LITERAL_PASTE_CHUNK_CHARS)).toBeTrue();
      expect(editor.element.querySelector('[data-id="plugin:test"]')!.textContent).toBe("Codex Native2");
    }
  }
});

test("existing safe compaction repair cannot refill the candidate deadline", async () => {
  const { ChatGptBrowserWorker, ChatGptPromptAttachmentIntegrityError } = await import("../src/adapters/chatgpt-web/browser-worker");
  const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
  let now = 0; const contexts: any[] = []; const remaining: number[] = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { experimentalComposerPlainText: true },
    attachPrompt: async (...args: any[]) => {
      const context = args.at(-1); contexts.push(context); remaining.push(context.operation.timeLeft());
      if (contexts.length === 1) { now = 50000; throw new ChatGptPromptAttachmentIntegrityError("synthetic readiness failure"); }
    },
    currentSubmissionEvidence: async () => undefined,
    resetCompactionComposerForRetry: async (_p: unknown, _b: unknown, _s: unknown, operation: any) => expect(operation.timeLeft()).toBe(40000),
  });
  await worker.attachPromptWithCompactionRetry({}, "x".repeat(33000), false, true,
    { userTurns: 0, responseTurns: 0, initialTurnIdentities: [] }, undefined, undefined, false,
    { triggerAttempts: 0 }, false, false, false, undefined,
    { traceId: "fixture", stage: "attachment", operation: new ChatGptPromptOperation(undefined, () => 900000, () => now) });
  expect(remaining).toEqual([90000, 40000]);
  expect(contexts[0].candidateBudget).toBe(contexts[1].candidateBudget);
});

for (const legacyFlag of [undefined, false, true]) {
  const name = legacyFlag === undefined ? "default config without flag" : `legacy flag ${legacyFlag}`;
  test(`${name}: all attachment routes share finite hard and verified-stall budgets`, async () => {
    const { ChatGptBrowserWorker } = await import("../src/adapters/chatgpt-web/browser-worker");
    const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
    let now = 0;
    const contexts: any[] = [];
    const config = defaultConfig();
    if (legacyFlag !== undefined) config.experimentalComposerPlainText = legacyFlag;
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: resolveBrowserConfig(providerConfig(config)),
      activeComposer: async () => ({ fill: async () => {}, focus: async () => {} }),
      selectConnector: async () => ({ focus: async () => {} }),
      insertPromptText: async (...args: any[]) => { contexts.push(args[5]); },
      assertPromptAttached: async () => {},
    });
    const absentDialog = { filter: () => absentDialog, last: () => absentDialog, isVisible: async () => false };
    const page = { keyboard: { press: async () => {} }, locator: () => absentDialog };
    const parent = new ChatGptPromptOperation(undefined, () => 900_000 - now, () => now);
    for (const [tools, inline] of [[false, false], [true, false], [false, true], [true, true]]) {
      await worker.attachPrompt(page, "x".repeat(33_000), tools, undefined, undefined, false,
        { triggerAttempts: 0 }, false, inline, false, undefined,
        { traceId: "normalized-budget-fixture", stage: "attachment", operation: parent });
    }
    expect(contexts.map(context => context.operation.timeLeft())).toEqual([90_000, 90_000, 90_000, 90_000]);
    for (const context of contexts) {
      expect(context.candidateBudget).toBeInstanceOf(ChatGptCandidateAttachmentBudget);
      expect(context.candidateBudget.plan).toBe(context.insertionPlan);
      expect(context.insertionPlan.strategy).toBe("literal-paste");
    }
    const context = contexts[0];
    const metrics = new ChatGptPromptInsertionMetrics(context.insertionPlan,
      snapshot => context.candidateBudget.observe(snapshot), () => now);
    await metrics.run("verify", async () => metrics.verified(1));
    now = 19_000;
    await metrics.run("verify", async () => metrics.verified(2));
    expect(context.operation.timeLeft()).toBe(20_000);
    now = 38_000;
    await metrics.run("verify", async () => metrics.verified(2));
    expect(context.operation.timeLeft()).toBe(1_000);
    now = 39_000;
    expect(() => context.operation.check()).toThrow("no verified progress");
    now = 90_000;
    expect(context.operation.timeLeft()).toBe(0);
    expect(() => context.operation.check()).toThrow("remaining readiness budget");
  });

  test(`${name}: compaction retry retains one original attachment deadline`, async () => {
    const { ChatGptBrowserWorker, ChatGptPromptAttachmentIntegrityError } = await import("../src/adapters/chatgpt-web/browser-worker");
    const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
    let now = 0;
    const contexts: any[] = [];
    const remaining: number[] = [];
    const resetRemaining: number[] = [];
    const config = defaultConfig();
    if (legacyFlag !== undefined) config.experimentalComposerPlainText = legacyFlag;
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: resolveBrowserConfig(providerConfig(config)),
      attachPrompt: async (...args: any[]) => {
        const context = args.at(-1);
        contexts.push(context); remaining.push(context.operation.timeLeft());
        if (contexts.length === 1) {
          now = 50_000;
          throw new ChatGptPromptAttachmentIntegrityError("synthetic readiness failure");
        }
      },
      currentSubmissionEvidence: async () => undefined,
      resetCompactionComposerForRetry: async (_page: unknown, _baseline: unknown, _signal: unknown,
        operation: any) => { resetRemaining.push(operation.timeLeft()); },
    });
    await worker.attachPromptWithCompactionRetry({}, "x".repeat(33_000), false, true,
      { userTurns: 0, responseTurns: 0, initialTurnIdentities: [] }, undefined, undefined, false,
      { triggerAttempts: 0 }, false, false, false, undefined,
      { traceId: "normalized-retry-fixture", stage: "attachment",
        operation: new ChatGptPromptOperation(undefined, () => 900_000 - now, () => now) });
    expect(remaining).toEqual([90_000, 40_000]);
    expect(resetRemaining).toEqual([40_000]);
    expect(contexts[0].candidateBudget).toBeInstanceOf(ChatGptCandidateAttachmentBudget);
    expect(contexts[1].candidateBudget).toBe(contexts[0].candidateBudget);
    expect(contexts[1].insertionPlan).toBe(contexts[0].insertionPlan);
    now = 90_000;
    expect(contexts[1].operation.timeLeft()).toBe(0);
  });
}

test("a single native paste may settle after 20 seconds but cannot exceed its hard deadline", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("x".repeat(89_000), { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, snapshot => budget.observe(snapshot), () => now);
  expect(plan.strategy).toBe("literal-paste");
  await metrics.run("insert", async () => {
    metrics.editStarted();
    now = 52_000;
    expect(budget.remainingMs()).toBe(38_000);
    metrics.editSettled({ result: true, attempts: 1, accepted: 1 });
  });
  expect(budget.remainingMs()).toBe(20_000);
  now = 90_000;
  expect(budget.remainingMs()).toBe(0);
});

test("a failed native paste does not leave the stall exemption active for a later attempt", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("x".repeat(40_000), { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, snapshot => budget.observe(snapshot), () => now);
  await expect(metrics.run("insert", async () => { metrics.editStarted(); throw new Error("editor rejected"); })).rejects.toThrow("editor rejected");
  now = 20_001;
  expect(() => budget.remainingMs()).toThrow("no verified progress");
});

test("composer acquisition cannot borrow the native-paste stall exemption", async () => {
  const { insertChatGptPromptText } = await import("../src/adapters/chatgpt-web/prompt-insertion");
  const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
  let now = 0;
  const text = "x".repeat(40_000);
  const plan = planChatGptPromptInsertion(text, { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  let nativeEdits = 0;
  await expect(insertChatGptPromptText(text, undefined, {
    composer: async () => {
      now = 20_001; // Surface lookup settles before any native editor evaluation.
      return { focus: async () => {}, evaluate: async () => { nativeEdits += 1; return true; } } as never;
    },
    verify: async () => {}, reanchor: async () => {},
    onProgress: snapshot => budget.observe(snapshot),
  }, { candidatePlainText: true }, new ChatGptPromptOperation(undefined, () => budget.remainingMs(), () => now), plan))
    .rejects.toThrow("no verified progress");
  expect(nativeEdits).toBe(0);
});

test("a native paste starting just before stall keeps a usable native mutation timeout", async () => {
  const { insertChatGptPromptText } = await import("../src/adapters/chatgpt-web/prompt-insertion");
  const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
  let now = 0;
  let editTimeout = 0;
  const text = "x".repeat(40_000);
  const plan = planChatGptPromptInsertion(text, { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const composer = {
    focus: async () => { now = 19_999; },
    evaluate: async (_callback: unknown, _input: unknown, options: { timeout: number }) => {
      editTimeout = options.timeout;
      return { result: true, attempts: 1, accepted: 1 };
    },
  } as never;
  await insertChatGptPromptText(text, undefined, {
    composer: async () => composer, verify: async () => {}, reanchor: async () => {},
    onProgress: snapshot => budget.observe(snapshot),
  }, { candidatePlainText: true }, new ChatGptPromptOperation(undefined, () => budget.remainingMs(), () => now), plan);
  expect(editTimeout).toBeGreaterThan(1_000);
});

test("launcher surface rebind cannot refill the candidate deadline", async () => {
  const { ChatGptBrowserWorker } = await import("../src/adapters/chatgpt-web/browser-worker");
  const { ChatGptWebAdapterError } = await import("../src/adapters/chatgpt-web/adapter-error");
  const { ChatGptPromptOperation } = await import("../src/adapters/chatgpt-web/prompt-operation");
  let now = 0; const contexts: any[] = []; const remaining: number[] = [];
  const plan = planChatGptPromptInsertion("x".repeat(33000), { candidatePlainText: true });
  const candidateBudget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { experimentalComposerPlainText: true },
    attachPrompt: async (...args: any[]) => {
      const context = args.at(-1); contexts.push(context); remaining.push(context.operation.timeLeft());
      if (contexts.length === 1) throw new ChatGptWebAdapterError("ChatGPT browser stage timed out: prompt_attachment", {
        status: 502, errorType: "server_error", code: "chatgpt_surface_changed", retryable: true,
      });
    },
  });
  const action = () => worker.attachPromptWithCompactionRetry({}, "x".repeat(33000), false, false,
    { userTurns: 0, responseTurns: 0, initialTurnIdentities: [] }, undefined, undefined, false,
    { triggerAttempts: 0 }, false, false, false, undefined,
    { traceId: "fixture", stage: "attachment",
      operation: new ChatGptPromptOperation(undefined, () => 900000, () => now), insertionPlan: plan, candidateBudget });
  await worker.retryPromptAttachmentAfterRebind(action, async () => { now = 50000; });
  expect(remaining).toEqual([90000, 40000]);
  expect(contexts[0].candidateBudget).toBe(candidateBudget);
  expect(contexts[1].candidateBudget).toBe(candidateBudget);
});
