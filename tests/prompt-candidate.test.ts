import { expect, test } from "bun:test";
import { planChatGptPromptInsertion } from "../src/adapters/chatgpt-web/prompt-insertion-plan";
import { ChatGptCandidateAttachmentBudget } from "../src/adapters/chatgpt-web/prompt-candidate-budget";
import { ChatGptPromptInsertionMetrics } from "../src/adapters/chatgpt-web/prompt-insertion-metrics";
import { resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { providerConfig, defaultConfig } from "../src/config";

for (const size of [15999, 16000, 16001, 32000, 32001, 330000]) {
  test(`candidate preserves strict threshold at ${size}`, () => {
    const text = "x".repeat(size);
    expect(planChatGptPromptInsertion(text).strategy).toBe("guarded-chunked");
    expect(planChatGptPromptInsertion(text, { candidatePlainText: true }).strategy)
      .toBe(size > 32000 ? "direct-text" : "guarded-chunked");
    expect(planChatGptPromptInsertion(text, { largeStructuredDirect: true, candidatePlainText: true }).strategy)
      .toBe(size > 32000 ? "direct-html" : "guarded-chunked");
  });
}
for (const suffix of ["\r\n\0", "\u00a0\u2028", "\n```\n**[x](y)\n```\n", "👩‍💻e\u0301"]) {
  test(`candidate keeps literal input category ${JSON.stringify(suffix)}`, () => {
    const text = "x".repeat(32001) + suffix;
    const plan = planChatGptPromptInsertion(text, { candidatePlainText: true });
    expect(plan.strategy).toBe(/[\r\u0000]/u.test(suffix) || !/[\n\u2028\u2029]/u.test(suffix)
      ? "direct-text" : "direct-html-prewrap");
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
test("marker reductions are progress even when verified length does not change", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("*".repeat(100));
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, s => budget.observe(s), () => now);
  metrics.markers(100);
  await metrics.run("markdown_restore", async () => {
    now = 19000; metrics.markers(99);
    expect(budget.remainingMs()).toBe(20000);
    now = 38000; metrics.markers(98);
    expect(budget.remainingMs()).toBe(20000);
    now = 57000; metrics.markers(97);
    expect(budget.remainingMs()).toBe(3000);
  });
});

test("candidate never overrides an existing forced direct choice", () => {
  const text = "x".repeat(40000);
  expect(planChatGptPromptInsertion(text, { candidatePlainText: true, forceStructuredDirect: true }).strategy).toBe("direct-html");
  expect(planChatGptPromptInsertion(text + "\r", { candidatePlainText: true, largeStructuredDirect: true }).strategy).toBe("direct-text");
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
  const page = { keyboard: { press: async () => {} } };
  const parent = new ChatGptPromptOperation(undefined, () => 5000);
  for (const [tools, inline] of [[false, false], [true, false], [false, true]]) {
    await worker.attachPrompt(page, "x".repeat(33000), tools, undefined, undefined, false,
      { triggerAttempts: 0 }, false, inline, false, undefined, { traceId: "fixture", stage: "attachment", operation: parent });
  }
  expect(seen.map(s => s.context.insertionPlan.strategy)).toEqual(["direct-text", "direct-text", "direct-html"]);
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
    .toEqual(["direct-html-prewrap", "direct-html-prewrap"]);
  expect(asserted.slice(-2)).toEqual([
    { text: multiline, preserveLeading: true },
    { text: ` ${multiline}`, preserveLeading: true },
  ]);
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

test("a single direct edit may settle after 20 seconds but cannot exceed its hard deadline", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("x".repeat(89_000), { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, snapshot => budget.observe(snapshot), () => now);
  expect(plan.strategy).toBe("direct-text");
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

test("a failed direct edit does not leave the stall exemption active for a later attempt", async () => {
  let now = 0;
  const plan = planChatGptPromptInsertion("x".repeat(40_000), { candidatePlainText: true });
  const budget = new ChatGptCandidateAttachmentBudget(plan, () => now);
  const metrics = new ChatGptPromptInsertionMetrics(plan, snapshot => budget.observe(snapshot), () => now);
  await expect(metrics.run("insert", async () => { metrics.editStarted(); throw new Error("editor rejected"); })).rejects.toThrow("editor rejected");
  now = 20_001;
  expect(() => budget.remainingMs()).toThrow("no verified progress");
});

test("composer acquisition cannot borrow the direct native-edit stall exemption", async () => {
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

test("a direct edit starting just before stall keeps a usable native mutation timeout", async () => {
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
