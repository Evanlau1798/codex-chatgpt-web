import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import type { BrokerTurnOutputEvent } from "../src/adapters/chatgpt-web/turn-broker-protocol";

const OLD = "Review in progress.";
const FINAL = "Findings: No blocking defects. Review complete.";

async function runFixture(options: {
  stale?: boolean; tunneledFinal?: boolean; steering?: boolean; batches?: number;
  missingBaseline?: boolean; abortAtBaseline?: boolean; delayedResult?: boolean;
  pastToolBatch?: boolean; retained?: boolean; tunneledRetry?: "answer" | "preemptive";
} = {}) {
  const diagnostics = mkdtempSync(join(import.meta.dir, "../tmp/boole-browser-"));
  const progress = new ChatGptExternalTurnProgress();
  const actions: string[] = [];
  const deltas: string[] = [];
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error("fixture did not settle")), 5_000);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let submitted = 0;
  let finalSequence = 1;
  let text = OLD;
  let pendingReaders = 0;
  let batch = 0;
  if (options.pastToolBatch) {
    batch = progress.recordToolBatch(1);
    await progress.acknowledgeToolBatch(batch);
    progress.recordToolResult();
  }
  let remainingBatches = options.batches ?? 1;
  let pendingResult = false;
  let snapshotsBeforeDispatch = 0;
  const acknowledge = progress.acknowledgeToolBatch.bind(progress);
  progress.acknowledgeToolBatch = async revision => {
    await acknowledge(revision);
    if (progress.snapshot().activeToolCalls === 0) return;
    await progress.waitForToolBatchObservation(revision);
    actions.push("tool-dispatched");
    if (options.delayedResult) { pendingResult = true; return; }
    progress.recordToolResult();
    actions.push("tool-settled");
    remainingBatches--;
    if (remainingBatches > 0) {
      text = "Intermediate review.";
      progress.recordToolBatch(1);
    } else if (!options.stale) text = FINAL;
  };
  const hidden: any = {
    count: async () => 0, isVisible: async () => false,
    filter() { return this; }, last() { return this; }, nth() { return this; },
    getByText() { return this; }, getByRole() { return this; }, getByTestId() { return this; },
  };
  const response: any = { ...hidden, count: async () => 1 };
  const turns: any = {
    ...hidden, nth: () => response, page: () => page,
    evaluateAll: async () => {
      now += 61_000; // Advance observation time, never sleep to guess tool completion.
      if (pendingResult) {
        expect(actions).not.toContain("output-seal");
        expect(deltas).toEqual([]);
        progress.recordToolResult();
        actions.push("tool-settled");
        text = FINAL;
        pendingResult = false;
      }
      const identities = ["historical", ...Array.from({ length: submitted }, (_, index) => `current${index || ""}`)];
      return { count: identities.length, lastId: identities.at(-1), identities };
    },
  };
  const page: any = {
    isClosed: () => false, url: () => CHATGPT_TEMPORARY_CHAT_URL, evaluate: async () => ({}),
    locator: (selector: string) => {
      if (selector === CHATGPT_ASSISTANT_TURN_SELECTOR) return turns;
      if (selector === "[data-turn-id-container]") return {
        evaluateAll: async () => ["historical", ...Array.from({ length: submitted }, (_, index) => `current${index || ""}`)],
      };
      if (selector.startsWith('[data-turn-id="current')) return response;
      return hidden;
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics },
    finalizingRuns: new Set<string>(),
    takePreemptiveRetry: () => options.tunneledRetry === "preemptive" && submitted === 1
      ? "Apply pending steering." : undefined,
    runStage: async (_trace: string, _name: string, _timeout: number, action: (s: AbortSignal) => unknown) => action(controller.signal),
    prepareTemporaryChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(
      model, effort, { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    ),
    attachPromptWithCompactionRetry: async (_page: unknown, _prompt: string, bindConnector: boolean) => {
      expect(bindConnector).toBe(!options.retained && submitted === 0);
      actions.push("attach");
    },
    attachFiles: async () => {}, assertPromptAttached: async () => {}, connectorIsSelected: async () => true,
    activeComposer: async () => ({ locator: () => ({ getByTestId: () => ({
      waitFor: async () => {}, isEnabled: async () => true,
      press: async () => { submitted++; if (options.pastToolBatch) text = FINAL; actions.push("send"); },
    }) }) }),
    waitForSubmissionAccepted: async () => "generation_running",
    responseDomSnapshot: async (locator: unknown) => {
      expect(locator).toBe(response);
      if (progress.snapshot().activeToolCalls) snapshotsBeforeDispatch++;
      if (progress.snapshot().activeToolCalls && options.abortAtBaseline) controller.abort();
      actions.push(`snapshot:${text}`);
      return {
        responsePresent: !(options.missingBaseline && progress.snapshot().activeToolCalls),
        visibleText: text, fullHtml: text, plainTextFallback: text,
        markdownSegments: [], markdownRoots: [], traceBlocks: [], nativeToolCandidates: [],
        completionActionVisible: true, globalCompletionActionVisible: true, stoppedThinkingVisible: false,
        projection: { rootId: "current-final", boundaryProtocolPresent: false,
          lastNodePresent: true, lastMutationAt: 1, animations: [] },
      };
    },
    waitForTurnDomOrExternalProgress: async () => { now += 61_000; },
    stalledTurnDiagnostic: async () => "fixture stable DOM",
  });
  const turn: BrowserTurn = {
    traceId: "boole_fallback_fixture", modelId: "gpt-5.6-sol", reasoning: "xhigh",
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    nativeConnector: true, externalProgress: progress, abortSignal: controller.signal,
    prepare: async () => ({ text: "Review the candidate.", images: [], transport: "native2-archive",
      release: () => { actions.push("release"); } }),
    onSubmitted: () => { actions.push("submitted"); }, onTextDelta: delta => { deltas.push(delta); },
    retryPromptForAnswer: (_answer, attempt) => options.steering || (options.tunneledRetry === "answer" && attempt === 1)
      ? { text: "Apply pending steering.", onSubmitted: () => { actions.push("retry-submitted"); } } : undefined,
    completionFence: {
      begin: async () => { actions.push("fence-begin"); return 1; },
      commit: async () => { actions.push("fence-commit"); return true; },
    },
    tunneledOutput: {
      next: (after, signal) => {
        if (options.tunneledFinal && after < finalSequence) {
          return Promise.resolve({ sequence: finalSequence, kind: "final",
            text: options.tunneledRetry && finalSequence === 1 ? "Superseded review." : FINAL });
        }
        if (!batch && !options.tunneledFinal) batch = progress.recordToolBatch(1);
        return new Promise<BrokerTurnOutputEvent>((_resolve, reject) => {
          pendingReaders++;
          signal!.addEventListener("abort", () => {
            pendingReaders--;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
      reset: async sequence => {
        if (!options.tunneledRetry) throw new Error("unexpected replay");
        expect(sequence).toBe(finalSequence);
        actions.push("output-reset");
        finalSequence++;
      },
      seal: async () => { expect(progress.snapshot().activeToolCalls).toBe(0); actions.push("output-seal"); return true; },
    },
  };
  let answer: string | undefined;
  let error: unknown;
  try { answer = await worker.runBrowserTurn(turn, undefined, page, options.retained); }
  catch (cause) { error = cause; }
  finally {
    clearTimeout(guard);
    clock.mockRestore();
    progress.retire(new Error("fixture finished"));
    rmSync(diagnostics, { recursive: true, force: true });
  }
  expect(pendingReaders).toBe(0);
  expect(actions.filter(a => a === "release")).toHaveLength(1);
  expect(actions.filter(a => a === "send")).toHaveLength(options.tunneledRetry ? 2 : 1);
  expect(actions.filter(a => a === "submitted")).toHaveLength(options.tunneledRetry ? 2 : 1);
  return { answer, error, actions, deltas, snapshotsBeforeDispatch };
}

test.each([1, 2])("Boole regression: DOM fallback delivers a final already rendered after %i native batches", async batches => {
  const result = await runFixture({ batches });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.snapshotsBeforeDispatch).toBe(batches);
  expect(result.actions.indexOf(`snapshot:${OLD}`)).toBeLessThan(result.actions.indexOf("tool-dispatched"));
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
});

test("a new response does not classify settled historical tools against its current final", async () => {
  const result = await runFixture({ pastToolBatch: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).not.toContain("tool-dispatched");
});

test("retained conversation keeps native tools and final delivery without another connector mention", async () => {
  const result = await runFixture({ retained: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.filter(a => a === "tool-dispatched")).toHaveLength(1);
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
});

test("DOM fallback still rejects an unchanged pre-tool answer", async () => {
  const result = await runFixture({ stale: true });
  expect((result.error as Error).message).toContain("without producing a final answer after its last Codex tool call");
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("fence-commit");
});

test("an explicit tunneled final without work tools needs no rich DOM traversal", async () => {
  const result = await runFixture({ tunneledFinal: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.some(a => a.startsWith("snapshot:"))).toBeFalse();
});

test.each(["answer", "preemptive"] as const)("a tunneled final requiring %s retry cannot complete with an empty buffer", async tunneledRetry => {
  const result = await runFixture({ tunneledFinal: true, tunneledRetry });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.filter(a => a === "output-reset")).toHaveLength(1);
  expect(result.actions.filter(a => a === "retry-submitted")).toHaveLength(tunneledRetry === "answer" ? 1 : 0);
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
  expect(result.actions).not.toContain("output-seal");
});

test("DOM fallback does not publish a final superseded by pending steering", async () => {
  const result = await runFixture({ steering: true });
  expect(result.error).toMatchObject({ code: "chatgpt_tunneled_fallback_retry_required" });
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("fence-commit");
});

test("DOM fallback preserves the most recent boundary across multiple tool batches", async () => {
  const result = await runFixture({ batches: 2, stale: true });
  expect((result.error as Error).message).toContain("without producing a final answer after its last Codex tool call");
  expect(result.snapshotsBeforeDispatch).toBe(2);
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("fence-commit");
});

test("terminal Web controls do not seal fallback while a native tool is running", async () => {
  const result = await runFixture({ delayedResult: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions.indexOf("tool-settled")).toBeLessThan(result.actions.indexOf("output-seal"));
});

test("a missing pre-tool DOM observation fails before dispatch or final publication", async () => {
  const result = await runFixture({ missingBaseline: true });
  expect((result.error as Error).message).toContain("could not observe the current answer before native tool dispatch");
  expect(result.actions).not.toContain("tool-dispatched");
  expect(result.deltas).toEqual([]);
});

test("cancellation during baseline observation cannot release a waiting tool batch", async () => {
  const result = await runFixture({ abortAtBaseline: true });
  expect(result.error).toMatchObject({ name: "AbortError" });
  expect(result.actions).not.toContain("tool-dispatched");
  expect(result.deltas).toEqual([]);
});
