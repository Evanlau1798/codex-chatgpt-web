import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_COMPOSER_SELECTOR, CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import type { BrokerTurnOutputEvent } from "../src/adapters/chatgpt-web/turn-broker-protocol";
import { activeCompactionToolResultInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { submitTurnOutput, waitForTurnOutput, sealTurnOutput, resetTurnOutput } from "../src/adapters/chatgpt-web/turn-broker-output";
import type { TurnChannel } from "../src/adapters/chatgpt-web/turn-broker-state";
import { chatGptSameSurfaceRecoveryDecision, CHATGPT_SAME_SURFACE_RECOVERY_PROMPT } from "../src/adapters/chatgpt-web/runtime-lifecycle";

const OLD = "Review in progress.";
const FINAL = "Findings: No blocking defects. Review complete.";

async function runFixture(options: {
  stale?: boolean; tunneledFinal?: boolean; steering?: boolean; batches?: number;
  missingBaseline?: boolean; abortAtBaseline?: boolean; delayedResult?: boolean;
  pastToolBatch?: boolean; retained?: boolean; tunneledRetry?: "answer" | "preemptive";
  compactionSettlement?: boolean;
  emptyStopped?: boolean; recoveryFails?: boolean; composerBusy?: boolean; stoppedThinking?: boolean;
  composerBusyAfterAdmission?: boolean;
  recentToolProgress?: boolean;
} = {}) {
  const diagnostics = mkdtempSync(join(tmpdir(), "boole-browser-"));
  const progress = new ChatGptExternalTurnProgress();
  const actions: string[] = [];
  const deltas: string[] = [];
  const logs: string[] = [];
  const info = spyOn(console, "info").mockImplementation(message => { logs.push(`info:${message}`); });
  const warn = spyOn(console, "warn").mockImplementation(message => { logs.push(`warn:${message}`); });
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error("fixture did not settle")), options.recentToolProgress ? 4_000 : 10_000);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let submitted = 0;
  let composerText = options.composerBusy ? "User draft" : "";
  let finalSequence = 1;
  let text = OLD;
  let pendingReaders = 0;
  const channel = {
    outputEnabled: true, outputSealed: false, outputEvents: [], outputChars: 0,
    outputWaiters: new Set(), outputResumeAfter: 0, activities: new Set(), invocations: new Map(),
    completionCommitted: false, activityRevision: 0,
  } as unknown as TurnChannel;
  const commentary: string[] = [];
  if (options.emptyStopped) submitTurnOutput(channel, "commentary", "Working.");
  let batch = 0;
  if (options.pastToolBatch) {
    batch = progress.recordToolBatch(1);
    await progress.acknowledgeToolBatch(batch);
    progress.recordToolResult();
  }
  let remainingBatches = options.batches ?? 1;
  let pendingResult = false;
  let snapshotsBeforeDispatch = 0;
  let domWaits = 0;
  let lastToolResultAt = now;
  let fallbackAgeMs: number | undefined;
  const acknowledge = progress.acknowledgeToolBatch.bind(progress);
  progress.acknowledgeToolBatch = async revision => {
    await acknowledge(revision);
    if (progress.snapshot().activeToolCalls === 0) return;
    await progress.waitForToolBatchObservation(revision);
    actions.push("tool-dispatched");
    if (options.delayedResult) { pendingResult = true; return; }
    progress.recordToolResult();
    lastToolResultAt = now;
    actions.push("tool-settled");
    remainingBatches--;
    if (remainingBatches > 0) {
      text = "Intermediate review.";
      progress.recordToolBatch(1);
    } else if (!options.stale) text = options.emptyStopped ? "" : FINAL;
  };
  const hidden: any = {
    count: async () => 0, isVisible: async () => false,
    filter() { return this; }, first() { return this; }, last() { return this; }, nth() { return this; },
    getByText() { return this; }, getByRole() { return this; }, getByTestId() { return this; },
  };
  const response: any = { ...hidden, count: async () => 1 };
  const turns: any = {
    ...hidden, nth: () => response, page: () => page,
    evaluateAll: async () => {
      now += options.recentToolProgress ? 500 : options.emptyStopped ? 15_000 : 61_000; // Advance observation time, never sleep to guess tool completion.
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
  const page: any = Object.assign(new EventEmitter(), {
    isClosed: () => false, url: () => CHATGPT_TEMPORARY_CHAT_URL, evaluate: async () => ({}),
    locator: (selector: string) => {
      if (selector === CHATGPT_ASSISTANT_TURN_SELECTOR) return turns;
      if (selector === "[data-turn-id-container], [data-turn-key]") return {
        evaluateAll: async () => ["historical", ...Array.from({ length: submitted }, (_, index) => `current${index || ""}`)],
      };
      if (selector.startsWith('[data-turn-id="current')) return response;
      if (selector === CHATGPT_COMPOSER_SELECTOR) return {
        ...hidden, count: async () => 1, textContent: async () => composerText,
      };
      return hidden;
    },
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics },
    finalizingRuns: new Set<string>(),
    takePreemptiveRetry: () => options.tunneledRetry === "preemptive" && submitted === 1
      ? options.compactionSettlement ? activeCompactionToolResultInstruction() : "Apply pending steering." : undefined,
    runStage: async (_trace: string, _name: string, _timeout: number, action: (s: AbortSignal) => unknown) => action(controller.signal),
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string) => resolveChatGptWebModelMode(
      model, effort, { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true },
    ),
    attachPromptWithCompactionRetry: async (...args: any[]) => {
      const bindConnector = args[2];
      expect(bindConnector).toBe(!options.retained && submitted === 0);
      if (options.emptyStopped && submitted > 0) {
        await (ChatGptBrowserWorker.prototype as any).attachPromptWithCompactionRetry.apply(worker, args);
      }
      actions.push("attach");
    },
    insertPromptText: async () => { actions.push("insert"); },
    attachFiles: async () => {}, assertPromptAttached: async () => {}, connectorIsSelected: async () => true,
    activeComposer: async () => {
      if (options.composerBusyAfterAdmission && actions.includes("recovery:eligible")) composerText = "User draft";
      return { textContent: async () => composerText,
        fill: async () => { composerText = ""; actions.push("clear"); }, focus: async () => {},
        locator: () => ({ locator: () => ({
      waitFor: async () => {}, isEnabled: async () => true,
      press: async () => {
        submitted++;
        if (options.pastToolBatch) text = FINAL;
        if (options.compactionSettlement && submitted === 2) text = "CODEX_COMPACTION_SOURCE_SETTLED";
        if (options.emptyStopped && submitted === 2 && !options.recoveryFails) {
          expect(now - lastToolResultAt).toBeGreaterThanOrEqual(60_000);
          submitTurnOutput(channel, "final", FINAL);
        }
        actions.push("send");
      },
    }) }) }; },
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
        completionActionVisible: !options.emptyStopped, globalCompletionActionVisible: !options.emptyStopped,
        stoppedThinkingVisible: options.stoppedThinking === true,
        projection: { rootId: "current-final", boundaryProtocolPresent: false,
          lastNodePresent: true, lastMutationAt: 1, animations: [] },
      };
    },
    waitForTurnDomOrExternalProgress: async () => {
      now += 61_000;
      if (++domWaits > 8) controller.abort(new Error("fixture exhausted the bounded DOM observations"));
    },
    stalledTurnDiagnostic: async () => "fixture stable DOM",
  });
  const turn: BrowserTurn = {
    traceId: "boole_fallback_fixture", modelId: "gpt-5.6-sol", reasoning: "xhigh",
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true },
    nativeConnector: true, externalProgress: progress, abortSignal: controller.signal,
    prepare: async () => ({ text: "Review the candidate.", images: [], transport: "native2-archive",
      release: () => { actions.push("release"); } }),
    onSubmitted: () => { actions.push("submitted"); }, onTextDelta: delta => { deltas.push(delta); },
    onCommentary: text => { commentary.push(text); },
    retryPromptForError: async (error, attempt) => {
      const session = {
        runtime: { text: { value: () => "" } }, outstanding: () => [],
        unresolvedSupersededResultIds: () => [], canonicalCallDiagnostics: () => ({ complete: true }),
      };
      const decision = chatGptSameSurfaceRecoveryDecision(error, session as never, attempt, true, controller.signal);
      actions.push(`recovery:${decision.reason}`);
      return decision.eligible ? { text: CHATGPT_SAME_SURFACE_RECOVERY_PROMPT, replaceCandidate: true } : undefined;
    },
    retryPromptForAnswer: (_answer, attempt) => options.steering || (options.tunneledRetry === "answer" && attempt === 1)
      ? { text: "Apply pending steering.", onSubmitted: () => { actions.push("retry-submitted"); } } : undefined,
    completionFence: {
      begin: async () => { actions.push("fence-begin"); return 1; },
      commit: async () => { actions.push("fence-commit"); return true; },
    },
    tunneledOutput: {
      next: (after, signal) => {
        if (options.emptyStopped) {
          if (!batch) batch = progress.recordToolBatch(1);
          return waitForTurnOutput(channel, after, signal);
        }
        if (options.tunneledFinal && after < finalSequence && !(options.compactionSettlement && submitted === 2)) {
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
        if (options.emptyStopped) { resetTurnOutput(channel, sequence); return; }
        if (!options.tunneledRetry) throw new Error("unexpected replay");
        expect(sequence).toBe(finalSequence);
        actions.push("output-reset");
        finalSequence++;
      },
      seal: async (sequence, revision) => {
        expect(progress.snapshot().activeToolCalls).toBe(0); actions.push("output-seal");
        fallbackAgeMs = now - lastToolResultAt;
        return options.emptyStopped ? sealTurnOutput(channel, sequence, revision) : true;
      },
    },
  };
  let answer: string | undefined;
  let error: unknown;
  try { answer = await worker.runBrowserTurn(turn, undefined, page, options.retained); }
  catch (cause) { error = cause; }
  finally {
    clearTimeout(guard);
    clock.mockRestore();
    info.mockRestore();
    warn.mockRestore();
    progress.retire(new Error("fixture finished"));
    rmSync(diagnostics, { recursive: true, force: true });
  }
  expect(pendingReaders).toBe(0);
  expect(channel.outputWaiters.size).toBe(0);
  expect(actions.filter(a => a === "release")).toHaveLength(1);
  if (!options.emptyStopped) {
    expect(actions.filter(a => a === "send")).toHaveLength(options.tunneledRetry ? 2 : 1);
    expect(actions.filter(a => a === "submitted")).toHaveLength(options.tunneledRetry ? 2 : 1);
  }
  return { answer, error, actions, deltas, snapshotsBeforeDispatch, logs, commentary, composerText, fallbackAgeMs };
}

test("a stopped empty Web response continues once before sealing the native output channel", async () => {
  const result = await runFixture({ emptyStopped: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.commentary).toEqual(["Working."]);
  expect(result.actions.filter(a => a === "send")).toHaveLength(2);
  expect(result.actions.filter(a => a === "tool-dispatched")).toHaveLength(1);
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
  expect(result.actions).toContain("recovery:eligible");
  expect(result.actions).not.toContain("output-seal");
});

test("a second empty response escalates without another same-conversation submission", async () => {
  const result = await runFixture({ emptyStopped: true, recoveryFails: true });
  expect(result.error).toMatchObject({ code: "chatgpt_completion_evidence_missing", retryable: true });
  expect(result.actions.filter(a => a === "send")).toHaveLength(2);
  expect(result.actions).toContain("recovery:already_recovered");
  expect(result.actions).not.toContain("output-seal");
  expect(result.deltas).toEqual([]);
});

test("empty-response recovery preserves an occupied composer and escalates safely", async () => {
  const result = await runFixture({ emptyStopped: true, composerBusy: true });
  expect(result.error).toMatchObject({ code: "chatgpt_surface_changed", retryable: true });
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
  expect(result.actions).not.toContain("recovery:eligible");
  expect(result.deltas).toEqual([]);
});

test("Stopped thinking blocks empty-response recovery before sealing or submitting again", async () => {
  const result = await runFixture({ emptyStopped: true, stoppedThinking: true });
  expect(result.error).toMatchObject({ code: "chatgpt_stopped_thinking", retryable: false });
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
  expect(result.actions).not.toContain("output-seal");
  expect(result.actions).not.toContain("recovery:eligible");
  expect(result.deltas).toEqual([]);
});

test("recovery rechecks the composer at attachment before clearing a draft added after admission", async () => {
  const result = await runFixture({ emptyStopped: true, composerBusyAfterAdmission: true });
  expect(result.error).toMatchObject({ code: "chatgpt_surface_changed", retryable: true });
  expect(result.composerText).toBe("User draft");
  expect(result.actions).toContain("recovery:eligible");
  expect(result.actions).not.toContain("clear");
  expect(result.actions).not.toContain("insert");
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
});

test.each([1, 2])("Boole regression: DOM fallback delivers a final already rendered after %i native batches", async batches => {
  const result = await runFixture({ batches });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.snapshotsBeforeDispatch).toBe(batches);
  expect(result.actions.indexOf(`snapshot:${OLD}`)).toBeLessThan(result.actions.indexOf("tool-dispatched"));
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
  expect(result.logs.some(line => line.includes("warn:") && line.includes("output recovery path=dom reason=tunnel_final_missing"))).toBeTrue();
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
  expect(result.logs.some(line => line.includes("warn:") && line.includes("retrying final answer attempt=2"))).toBeTrue();
  expect(result.logs.some(line => line.includes("compaction source settlement"))).toBeFalse();
});

test("compaction source settlement reports a planned control response and DOM observation", async () => {
  const result = await runFixture({ tunneledFinal: true, tunneledRetry: "preemptive", compactionSettlement: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe("CODEX_COMPACTION_SOURCE_SETTLED");
  expect(result.deltas).toEqual(["CODEX_COMPACTION_SOURCE_SETTLED"]);
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
  expect(result.actions.filter(a => a === "output-reset")).toHaveLength(1);
  expect(result.actions.filter(a => a === "output-seal")).toHaveLength(1);
  expect(result.logs.some(line => line.includes("info:") && line.includes("compaction source settlement action=send_control_response attempt=2"))).toBeTrue();
  expect(result.logs.some(line => line.includes("info:") && line.includes("output observation path=dom reason=compaction_source_settlement"))).toBeTrue();
  expect(result.logs.some(line => line.includes("warn:") && /retrying final answer|output recovery/.test(line))).toBeFalse();
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

test("an identified current turn may use an empty baseline before its first native tool", async () => {
  const result = await runFixture({ missingBaseline: true });
  expect(result.error).toBeUndefined();
  expect(result.actions).toContain("tool-dispatched");
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
});

test("a visible completed answer after a settled native tool does not wait for the 60s progress grace", async () => {
  const result = await runFixture({ recentToolProgress: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.fallbackAgeMs).toBeLessThan(10_000);
}, 8_000);

test("recent tool progress cannot seal the tunnel for unchanged pre-tool text", async () => {
  const result = await runFixture({ recentToolProgress: true, stale: true });
  expect(result.actions).not.toContain("output-seal");
  expect(result.deltas).toEqual([]);
}, 8_000);

test("cancellation during baseline observation cannot release a waiting tool batch", async () => {
  const result = await runFixture({ abortAtBaseline: true });
  expect(result.error).toMatchObject({ name: "AbortError" });
  expect(result.actions).not.toContain("tool-dispatched");
  expect(result.deltas).toEqual([]);
});
