import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_COMPOSER_SELECTOR, CHATGPT_EFFORT_CONTROL_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR, CHATGPT_TEMPORARY_CHAT_URL, CHATGPT_USER_TURN_SELECTOR } from "../src/chatgpt-session";
import type { BrokerTurnOutputEvent } from "../src/adapters/chatgpt-web/turn-broker-protocol";
import { activeCompactionToolResultInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { publishPendingFinalizationOutput, submitTurnOutput, waitForTurnOutput, sealTurnOutput, resetTurnOutput } from "../src/adapters/chatgpt-web/turn-broker-output";
import type { TurnChannel } from "../src/adapters/chatgpt-web/turn-broker-state";
import { chatGptSameSurfaceRecoveryDecision, CHATGPT_SAME_SURFACE_RECOVERY_PROMPT } from "../src/adapters/chatgpt-web/runtime-lifecycle";
import { chatGptSameSurfaceRecoveryPrompt } from "../src/adapters/chatgpt-web/same-surface-recovery";
import * as launcherControl from "../src/launcher-browser-host";
const hostSource = createRequire(import.meta.url).resolve("../launcher/electron/browser-host.cjs");
const hostRequire = createRequire(hostSource);
const hostModule = { exports: {} as any };
runInNewContext(readFileSync(hostSource, "utf8"), {
  require: (id: string) => id === "electron" ? {} : hostRequire(id),
  module: hostModule, exports: hostModule.exports, Buffer, URL, process,
});
const { BrowserHost } = hostModule.exports;

const OLD = "Review in progress.";
const FINAL = "Findings: No blocking defects. Review complete.";

async function runFixture(options: {
  manualApproval?: boolean;
  approvalOutcome?: "timeout" | "aborted";
  stale?: boolean; tunneledFinal?: boolean; steering?: boolean; batches?: number;
  missingBaseline?: boolean; missingAssistantTurn?: boolean; abortAtBaseline?: boolean; delayedResult?: boolean;
  pastToolBatch?: boolean; retained?: boolean; tunneledRetry?: "answer" | "preemptive";
  compactionSettlement?: boolean;
  emptyStopped?: boolean; recoveryFails?: boolean; composerBusy?: boolean; stoppedThinking?: boolean;
  postToolRecovery?: boolean;
  composerBusyAfterAdmission?: boolean;
  boundRecoveryParagraphs?: boolean;
  localizedGeneration?: boolean;
  lateFinalBeforeRecoverySend?: boolean;
  lateFinalAfterFinalizationCas?: boolean;
  lateDomFinalBeforeRecoverySend?: boolean;
  lateDomFinalAfterFinalizationCas?: boolean;
  finalizationRevisionChanged?: boolean;
  generationResumesBeforeRecoveryInsertion?: boolean;
  generationResumesAtRecoveryInsertion?: boolean;
  draftDuringFinalization?: boolean;
  draftAtAtomicRecoverySubmission?: boolean;
  toolBatchAtRecoveryInsertion?: boolean;
  recoverySendActivationCallback?: boolean;
  finalDuringRecoverySubmission?: boolean;
  recoveryReceiptFails?: boolean;
  steeringBeforeRecoverySend?: boolean;
  recentToolProgress?: boolean;
  delayedSecondBatch?: boolean;
  finalAfterToolWithoutAssistantTurn?: boolean;
  unsettledBaseline?: boolean;
  settledPreToolProjection?: boolean;
  slowTerminalProjection?: boolean;
  untunneled?: boolean;
  conversationRoute?: string;
  initialRoute?: string;
  progressScenario?: "status" | "native-tool" | "static" | "foreign";
} = {}) {
  const recoverable = options.emptyStopped || options.postToolRecovery;
  const diagnostics = mkdtempSync(join(tmpdir(), "boole-browser-"));
  const progress = new ChatGptExternalTurnProgress();
  const actions: string[] = [];
  const selections: Array<{ url: string; model: string; effort: string; family?: string }> = [];
  const deltas: string[] = [];
  const logs: string[] = [];
  const info = spyOn(console, "info").mockImplementation(message => { logs.push(`info:${message}`); });
  const warn = spyOn(console, "warn").mockImplementation(message => { logs.push(`warn:${message}`); });
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error("fixture did not settle")),
    (options.recentToolProgress || options.missingAssistantTurn) && !recoverable ? 4_000 : 10_000);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let submitted = 0;
  let progressObservations = 0;
  const progressTimes: number[] = [];
  let progressStartedAt = now;
  let composerText = options.composerBusy ? "User draft" : "";
  // Recorded Web behavior: the sent app mention does not bind the next message.
  let currentMessageConnector = false;
  const localizedComposer = options.localizedGeneration
    ? (require("@mixmark-io/domino") as { createDocument(html: string): Document }).createDocument(
      '<form data-chatgpt-composer><button type="button" aria-label="停止"><svg class="icon-primary-action"><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z"></path></svg></button></form>',
    ) : undefined;
  let finalSequence = 1;
  let text = options.unsettledBaseline ? "Review in" : OLD;
  let pendingReaders = 0;
  const channel = {
    outputEnabled: true, outputSealed: false, outputEvents: [], outputChars: 0,
    outputWaiters: new Set(), outputResumeAfter: 0, activities: new Set(), invocations: new Map(),
    completionCommitted: false, activityRevision: 0, finalizationOnly: false, finalizationOutputArmed: false,
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
  let pendingSecondBatch = false;
  let snapshotsBeforeDispatch = 0;
  let domWaits = 0;
  let lastToolResultAt = now;
  let fallbackAgeMs: number | undefined;
  let recoveryDecisionAgeMs: number | undefined;
  let resumedGenerationChecks = 0;
  let finalizationStarted = false;
  let finalAnswerAdmissionSealed = false;
  let recoveryGuardNonce: string | undefined;
  let recoveryGuardSent = false;
  let terminalProjectionReads = 0;
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
    if (options.toolBatchAtRecoveryInsertion && actions.includes("recovery-tool-started")) {
      submitTurnOutput(channel, "final", FINAL);
    }
    if (options.finalAfterToolWithoutAssistantTurn) submitTurnOutput(channel, "final", FINAL);
    remainingBatches--;
    if (remainingBatches > 0) {
      text = options.emptyStopped ? "" : "Intermediate review.";
      if (options.delayedSecondBatch) pendingSecondBatch = true;
      else progress.recordToolBatch(1);
    } else if (options.unsettledBaseline) text = OLD;
    else if (!options.stale) text = options.emptyStopped ? "" : FINAL;
  };
  const hidden: any = {
    count: async () => 0, isVisible: async () => false,
    filter() { return this; }, first() { return this; }, last() { return this; }, nth() { return this; },
    getByText() { return this; }, getByRole() { return this; }, getByTestId() { return this; },
  };
  const response: any = {
    ...hidden,
    count: async () => 1,
    evaluate: async () => text,
  };
  const turns: any = {
    ...hidden, nth: () => response, page: () => page,
    evaluateAll: async () => {
      now += options.recentToolProgress ? 500 : options.emptyStopped ? 15_000 : 61_000; // Advance observation time, never sleep to guess tool completion.
      if (options.progressScenario && submitted && ++progressObservations === 9) submitTurnOutput(channel, "final", FINAL);
      if (pendingSecondBatch && now - lastToolResultAt >= 75_000) {
        pendingSecondBatch = false;
        progress.recordToolBatch(1);
        actions.push("delayed-tool-started");
      }
      if (pendingResult) {
        expect(actions).not.toContain("output-seal");
        expect(deltas).toEqual([]);
        progress.recordToolResult();
        actions.push("tool-settled");
        text = FINAL;
        pendingResult = false;
      }
      const projected = options.progressScenario === "foreign" || (options.missingAssistantTurn && !actions.includes("tool-dispatched"))
        || options.finalAfterToolWithoutAssistantTurn ? 0 : submitted;
      const identities = ["historical", ...Array.from({ length: projected }, (_, index) => `current${index || ""}`)];
      return { count: identities.length, lastId: identities.at(-1), identities };
    },
  };
  const page: any = Object.assign(new EventEmitter(), {
    isClosed: () => false, url: () => submitted && options.conversationRoute || options.initialRoute || CHATGPT_TEMPORARY_CHAT_URL, evaluate: async () => ({}),
    keyboard: { press: async () => { actions.push("composer-end"); } },
    locator: (selector: string) => {
      if (options.manualApproval && selector === '[role="dialog"], [data-testid="tool-approval-card"]') return approvalDialog;
      if (selector === CHATGPT_ASSISTANT_TURN_SELECTOR) return turns;
      if (selector === CHATGPT_STOP_BUTTON_SELECTOR && options.progressScenario) return {
        ...hidden, isVisible: async () => submitted > 0 && progressObservations < 9,
      };
      if (selector === CHATGPT_USER_TURN_SELECTOR) return { ...hidden, evaluateAll: async () => [] };
      if (selector === "[data-turn-id-container], [data-turn-key]") return {
        evaluateAll: async () => ["historical", ...Array.from({ length: submitted }, (_, index) => `current${index || ""}`)],
      };
      if (selector.startsWith('[data-turn-id="current')) return response;
      if (selector === CHATGPT_COMPOSER_SELECTOR) return {
        ...hidden, count: async () => 1, textContent: async () => composerText,
      };
      if (selector === CHATGPT_STOP_BUTTON_SELECTOR) return {
        ...hidden,
        isVisible: async () => {
          if (localizedComposer?.querySelector(CHATGPT_STOP_BUTTON_SELECTOR) && submitted > 0) {
            if (now - lastToolResultAt < 90_000) return true;
            if (!actions.includes("localized-generation-settled")) {
              actions.push("localized-generation-settled");
              submitTurnOutput(channel, "final", FINAL);
            }
            return false;
          }
          const recoveryReached = options.generationResumesAtRecoveryInsertion
            ? actions.includes("recovery-attachment-started")
            : actions.includes("recovery:eligible");
          if (!(options.generationResumesBeforeRecoveryInsertion || options.generationResumesAtRecoveryInsertion)
            || !recoveryReached) return false;
          resumedGenerationChecks += 1;
          if (resumedGenerationChecks === 1) {
            actions.push("generation-resumed");
            return true;
          }
          if (!actions.includes("generation-settled")) {
            actions.push("generation-settled");
            submitTurnOutput(channel, "final", FINAL);
          }
          return false;
        },
      };
      return hidden;
    },
  });
  const approvalVisibility: boolean[] = [];
  const approvalTab = { id: "approval-tab", traceId: "boole_fallback_fixture", helperPid: process.pid,
    status: "running", interactionMode: "automatic", interactionLocked: true,
    interactionShield: { setVisible: (visible: boolean) => approvalVisibility.push(visible),
      webContents: { isDestroyed: () => false, focus: () => actions.push("approval-shield-focus") } },
    view: { webContents: { isDestroyed: () => false, focus: () => actions.push("approval-focus") } } };
  const otherTab = { ...approvalTab, id: "other", traceId: "other-turn", interactionShield: undefined };
  const approvalHost = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map<string, typeof approvalTab | typeof otherTab>([[approvalTab.id, approvalTab], [otherTab.id, otherTab]]), closedTurnOwners: new Map(),
    selectedTabId: approvalTab.id, visible: true, surfaceActive: true, boundsReady: true,
    window: { isVisible: () => true, isMinimized: () => false },
    presentPrimaryView() {}, presentTurnView() {}, snapshot: () => ({}),
  });
  let approvalShown = options.manualApproval === true;
  let approvalReads = 0;
  const approvalDialog: any = { ...hidden, waitFor: async () => {}, isVisible: async () => {
    if (++approvalReads > 1 && approvalShown) {
      if (options.approvalOutcome === "aborted") controller.abort();
      else if (approvalVisibility.at(-1) === false && !options.approvalOutcome) approvalShown = false; // User can only approve through the unlocked UI.
      else now += 60_001; // A blocked user reaches the production manual-approval deadline.
    }
    return approvalShown;
  }, getByRole: (_role: string, query: { name: string | RegExp }) => ({ ...hidden,
    waitFor: async () => {}, press: async () => {
      const label = ["Allow once", "Deny"].find(label => typeof query.name === "string"
        ? label === query.name : query.name.test(label));
      if (!label) throw Error("No matching approval button in fixture");
      actions.push(`approval-${label}`); approvalShown = false;
    },
  }) };
  const approvalControl = options.manualApproval ? spyOn(launcherControl, "notifyLauncherTurn").mockImplementation(async (_path, activity) => {
    expect(activity.phase).toBe("approval");
    if (activity.phase !== "approval") throw new Error("unexpected control request");
    approvalHost.setTurnApprovalPending(activity.traceId, activity.helperPid, activity.pending);
    approvalHost.focusActiveSurface();
    actions.push(`approval-pending:${activity.pending}`);
    return {};
  }) : undefined;
  if (options.manualApproval) approvalHost.syncViewVisibility();
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, autoApproveToolCalls: false,
      ...(options.manualApproval ? { browserHostDescriptorPath: "fixture-control" } : {}) },
    finalizingRuns: new Set<string>(),
    takePreemptiveRetry: () => {
      if (options.steeringBeforeRecoverySend && actions.includes("insert") && !actions.includes("steering-issued")) {
        actions.push("steering-issued");
        return "Apply pending steering.";
      }
      return options.tunneledRetry === "preemptive" && submitted === 1
        ? options.compactionSettlement ? activeCompactionToolResultInstruction() : "Apply pending steering." : undefined;
    },
    runStage: async (_trace: string, _name: string, _timeout: number,
      action: (s: AbortSignal, remainingMs: () => number) => unknown) => action(controller.signal, () => 60_000),
    prepareChatSurface: async () => {},
    selectModelAndEffort: async (_page: unknown, model: string, effort: string, _capabilities: unknown, _capture: unknown, _track: unknown, family?: string) => {
      selections.push({ url: page.url(), model, effort, family });
      return {
        ...resolveChatGptWebModelMode(model, effort, { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true }),
        ...(options.conversationRoute ? { selection: { url: page.url(), label: "Extra High" } } : {}),
      };
    },
    attachPromptWithCompactionRetry: async (...args: any[]) => {
      const bindConnector = args[2];
      expect(bindConnector).toBe(true);
      if (recoverable && submitted > 0) {
        if (options.toolBatchAtRecoveryInsertion && !actions.includes("recovery-tool-started")) {
          progress.recordToolBatch(1);
          actions.push("recovery-tool-started");
        }
        if (options.generationResumesAtRecoveryInsertion) actions.push("recovery-attachment-started");
        await (ChatGptBrowserWorker.prototype as any).attachPromptWithCompactionRetry.apply(worker, args);
      } else {
        currentMessageConnector = true;
        actions.push("message-connector-selected");
      }
      actions.push("attach");
    },
    clearChatGptComposerState: async () => { composerText = ""; actions.push("clear"); },
    insertPromptText: async (_page: unknown, prompt: string) => { composerText = prompt; actions.push("insert"); },
    attachFiles: async () => {}, assertPromptAttached: async () => {},
    attachedPromptText: async (_page: unknown, _signal?: AbortSignal, _operation?: unknown, preserveLeading = false) =>
      preserveLeading ? composerText : composerText.trimStart(),
    connectorIsSelected: async () => currentMessageConnector,
    selectConnector: async () => { currentMessageConnector = true; actions.push("message-connector-selected"); return worker.activeComposer(); },
    activeComposer: async () => {
      if (options.composerBusyAfterAdmission && actions.includes("recovery:eligible")) composerText = "User draft";
      return { textContent: async () => {
        if (options.lateFinalAfterFinalizationCas && actions.includes("finalization-only:1")
          && !actions.includes("late-final-buffered")) {
          submitTurnOutput(channel, "final", FINAL);
          actions.push("late-final-buffered");
        }
        // Lexical projects inserted newlines as paragraph boundaries, not textContent newlines.
        return options.boundRecoveryParagraphs ? composerText.replaceAll("\n", "") : composerText;
      }, evaluate: async (_fn: unknown, input: string | {
        expectedPrompt: string;
        guard: { responseHtml: string };
        nonce: string;
        sendButtonSelector: string;
      } | { nonce: string; sendButtonSelector: string }) => {
        if (typeof input === "string") {
          if (composerText.trimStart() !== input) return false;
          composerText = "";
          actions.push("clear");
          return true;
        }
        if (!("expectedPrompt" in input)) {
          if (options.recoveryReceiptFails && recoveryGuardSent) throw new Error("renderer receipt unavailable");
          const matched = recoveryGuardSent && recoveryGuardNonce === input.nonce;
          recoveryGuardNonce = undefined;
          recoveryGuardSent = false;
          return matched;
        }
        if (options.lateFinalAfterFinalizationCas && actions.includes("finalization-only:1")
          && !actions.includes("late-final-buffered")) {
          submitTurnOutput(channel, "final", FINAL);
          actions.push("late-final-buffered");
        }
        if (options.draftAtAtomicRecoverySubmission) {
          composerText = "User draft at atomic submission";
          actions.push("user-draft-at-atomic-submission");
        }
        if (composerText.trimStart() !== input.expectedPrompt || input.guard.responseHtml !== text) return false;
        recoveryGuardNonce = input.nonce;
        return true;
      }, isEditable: async () => true,
        fill: async () => { composerText = ""; actions.push("clear"); }, focus: async () => {},
        locator: () => ({ locator: (selector: string) => selector === CHATGPT_EFFORT_CONTROL_SELECTOR ? {
          ...hidden, count: async () => 1, innerText: async () => "Extra High", getAttribute: async () => "false",
        } : ({
      waitFor: async () => {}, isEnabled: async () => true,
      click: async ({ signal }: { signal?: AbortSignal }) => {
        signal?.throwIfAborted();
        expect(currentMessageConnector).toBe(true);
        if (!recoveryGuardNonce) throw new Error("recovery send guard was not installed");
        recoveryGuardSent = true;
        composerText = "";
         submitted++;
         currentMessageConnector = false;
         if (options.postToolRecovery && submitted === 2 && options.recoveryFails) text = "";
         if (options.finalDuringRecoverySubmission) submitTurnOutput(channel, "final", FINAL);
         actions.push("send");
      },
      press: async () => {
        expect(currentMessageConnector).toBe(true);
        if (submitted > 0) composerText = "";
        submitted++;
        currentMessageConnector = false;
        if (options.postToolRecovery && submitted === 2 && options.recoveryFails) text = "";
        if (options.pastToolBatch) text = FINAL;
        if (options.compactionSettlement && submitted === 2) text = "CODEX_COMPACTION_SOURCE_SETTLED";
        if (recoverable && submitted === 2 && !options.recoveryFails) {
          submitTurnOutput(channel, "final", FINAL);
        }
        actions.push("send");
      },
    }) }) }; },
    waitForSubmissionAccepted: async () => { actions.push("submission-confirmed"); return "generation_running"; },
    responseDomSnapshot: async (locator: unknown) => {
      expect(locator).toBe(response);
      if ((options.lateDomFinalBeforeRecoverySend && actions.includes("insert")
        || options.lateDomFinalAfterFinalizationCas && actions.includes("finalization-only:1"))
        && !actions.includes("late-dom-final")) {
        text = FINAL;
        actions.push("late-dom-final");
      }
      if (progress.snapshot().activeToolCalls) snapshotsBeforeDispatch++;
      if (progress.snapshot().activeToolCalls && options.abortAtBaseline) controller.abort();
      const projectedText = options.slowTerminalProjection && progress.snapshot().activeToolCalls === 0
        && ++terminalProjectionReads < 6
        ? `${FINAL}${"!".repeat(terminalProjectionReads)}`
        : text;
      actions.push(`snapshot:${projectedText}`);
      return {
        responsePresent: !(options.missingBaseline && progress.snapshot().activeToolCalls),
        visibleText: projectedText, fullHtml: projectedText, plainTextFallback: projectedText,
        markdownSegments: [], markdownRoots: [],
        traceBlocks: options.progressScenario ? [{ kind: "status", key: "thinking",
          text: options.progressScenario === "status" ? `Étape de réflexion ${progressObservations}` : "Réflexion" }] : [],
        nativeToolCandidates: options.progressScenario === "native-tool" ? [{ kind: "native_tool",
          withinStreamingStatus: true, ancestorsVisible: true, ariaBusy: true, runningFiniteAnimation: false }] : [],
        completionActionVisible: !options.emptyStopped || actions.includes("late-dom-final")
          || Boolean(options.settledPreToolProjection && progress.snapshot().activeToolCalls),
        globalCompletionActionVisible: !options.emptyStopped || actions.includes("late-dom-final")
          || Boolean(options.settledPreToolProjection && progress.snapshot().activeToolCalls),
        stoppedThinkingVisible: options.stoppedThinking === true,
        projection: { rootId: "current-final", boundaryProtocolPresent: false,
          lastNodePresent: true, lastMutationAt: options.unsettledBaseline ? now : 1, animations: [] },
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
    modelFamily: options.conversationRoute ? "5.6" : undefined,
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true },
    nativeConnector: true, externalProgress: progress, abortSignal: controller.signal,
    prepare: async () => ({ text: "Review the candidate.", images: [], transport: "native2-archive",
      release: () => { actions.push("release"); } }),
    onSubmitted: () => {
      actions.push("submitted");
      progressStartedAt = now;
      if (options.untunneled) batch = progress.recordToolBatch(1);
    }, onTextDelta: delta => { deltas.push(delta); },
    onSendActivated: () => {
      if (options.recoverySendActivationCallback && submitted === 1) {
        composerText = "User draft during send activation";
        actions.push("recovery-send-activated");
      }
    },
    onCommentary: text => { commentary.push(text); },
    onProgress: () => { progressTimes.push(now); },
    retryPromptForError: async (error, attempt) => {
      if (!recoverable) return undefined;
      if (pendingSecondBatch) actions.push("recovery-before-delayed-tool");
      if (options.emptyStopped) recoveryDecisionAgeMs = now - lastToolResultAt;
      const session = {
        runtime: { text: { value: () => "" } }, outstanding: () => [],
        unresolvedSupersededResultIds: () => [], canonicalCallDiagnostics: () => ({ complete: true }),
      };
      const decision = chatGptSameSurfaceRecoveryDecision(error, session as never, attempt, true, controller.signal);
      actions.push(`recovery:${decision.reason}`);
      return decision.eligible ? { text: options.boundRecoveryParagraphs
        ? chatGptSameSurfaceRecoveryPrompt("turn_fixture_current")
        : CHATGPT_SAME_SURFACE_RECOVERY_PROMPT, replaceCandidate: true } : undefined;
    },
    retryPromptForAnswer: (_answer, attempt) => options.steering || (options.tunneledRetry === "answer" && attempt === 1)
      ? { text: "Apply pending steering.", onSubmitted: () => { actions.push("retry-submitted"); } } : undefined,
    finalAnswerAdmission: {
      seal: () => {
        if (finalAnswerAdmissionSealed) return false;
        finalAnswerAdmissionSealed = true;
        actions.push("final-answer-admission-sealed");
        return true;
      },
      reopen: () => {
        finalAnswerAdmissionSealed = false;
        actions.push("final-answer-admission-reopened");
      },
    },
    completionFence: {
      begin: async () => { actions.push("fence-begin"); return channel.activityRevision || 1; },
      commit: async () => { actions.push("fence-commit"); return true; },
    },
    beginFinalizationOnly: async revision => {
      actions.push(`finalization-only:${revision}`);
      if (options.draftDuringFinalization) {
        composerText = "User draft during CAS";
        actions.push("user-draft-during-cas");
        return false;
      }
      if (options.lateFinalBeforeRecoverySend) {
        submitTurnOutput(channel, "final", FINAL);
        return false;
      }
      if (options.finalizationRevisionChanged) {
        now += 600_000;
        return false;
      }
      if (channel.outputFinalSequence !== undefined) return false;
      if (!finalizationStarted && revision === 1) {
        finalizationStarted = true;
        channel.finalizationOnly = true;
        channel.activityRevision = 2;
        return true;
      }
      return false;
    },
    cancelFinalizationOnly: async revision => {
      actions.push(`finalization-cancel:${revision}`);
      if (!finalizationStarted || revision !== 2 || channel.finalizationOutputArmed) return false;
      finalizationStarted = false;
      channel.finalizationOnly = false;
      channel.activityRevision = 3;
      publishPendingFinalizationOutput(channel);
      return true;
    },
    armFinalizationOutput: async revision => {
      actions.push(`finalization-output-arm:${revision}`);
      if (!finalizationStarted || revision !== 2) return false;
      channel.finalizationOutputArmed = true;
      channel.activityRevision = 3;
      publishPendingFinalizationOutput(channel);
      if (recoverable && submitted === 2 && !options.recoveryFails) {
        submitTurnOutput(channel, "final", FINAL);
      }
      return true;
    },
    tunneledOutput: options.untunneled ? undefined : {
      next: (after, signal) => {
        if (options.progressScenario) return waitForTurnOutput(channel, after, signal);
        if (recoverable) {
          if (!batch) batch = progress.recordToolBatch(1);
          return waitForTurnOutput(channel, after, signal);
        }
        if (options.tunneledFinal && after < finalSequence && !(options.compactionSettlement && submitted === 2)) {
          return Promise.resolve({ sequence: finalSequence, kind: "final",
            text: options.tunneledRetry && finalSequence === 1 ? "Superseded review." : FINAL });
        }
        if (!batch && !options.tunneledFinal) batch = progress.recordToolBatch(1);
        if (options.finalAfterToolWithoutAssistantTurn) return waitForTurnOutput(channel, after, signal);
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
  try { answer = await worker.runBrowserTurn(turn, options.manualApproval ? approvalTab.id : undefined, page, options.retained); }
  catch (cause) { error = cause; }
  finally {
    clearTimeout(guard);
    clock.mockRestore();
    info.mockRestore();
    warn.mockRestore();
    approvalControl?.mockRestore();
    progress.retire(new Error("fixture finished"));
    rmSync(diagnostics, { recursive: true, force: true });
  }
  expect(pendingReaders).toBe(0);
  expect(channel.outputWaiters.size).toBe(0);
  expect(actions.filter(a => a === "release")).toHaveLength(1);
  if (!recoverable) {
    expect(actions.filter(a => a === "send")).toHaveLength(options.tunneledRetry ? 2 : 1);
    expect(actions.filter(a => a === "submitted")).toHaveLength(options.tunneledRetry ? 2 : 1);
  }
  return { answer, error, actions, deltas, snapshotsBeforeDispatch, logs, commentary, composerText,
    fallbackAgeMs, recoveryDecisionAgeMs, selections, progressTimes, progressStartedAt, approvalVisibility, approvalTab, otherTab };
}

test.each([false, true])("manual approval restores its owned protection (DOM=%s)", async untunneled => {
  for (const approvalOutcome of [undefined, "timeout", "aborted"] as const) {
  const result = await runFixture({ manualApproval: true, untunneled, approvalOutcome });
  if (approvalOutcome === "aborted") expect(result.error).toBeInstanceOf(DOMException);
  else expect(result.error).toBeUndefined();
  expect(result.actions.filter(action => action.startsWith("approval-pending:"))).toEqual([
    "approval-pending:true", "approval-pending:false",
  ]);
  expect(result.actions).toContain("approval-focus");
  if (approvalOutcome === "timeout") expect(result.actions).toContain("approval-Deny");
  else expect(result.actions).not.toContain("approval-Deny");
  expect(result.approvalVisibility).toEqual([true, false, true]);
  expect(result.approvalTab.interactionLocked).toBe(true);
  expect((result.otherTab as any).approvalPending).toBeUndefined();
  if (approvalOutcome !== "aborted") expect(result.answer).toBe(FINAL);
  }
});

async function runLateCompletionActionFixture() {
  const diagnostics = mkdtempSync(join(tmpdir(), "late-completion-action-"));
  const actions: string[] = [];
  const deltas: string[] = [];
  const controller = new AbortController();
  let submitted = 0;
  let snapshotCount = 0;
  let waitCount = 0;
  let now = 100_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const hidden: any = {
    count: async () => 0, isVisible: async () => false,
    filter() { return this; }, first() { return this; }, last() { return this; }, nth() { return this; },
    getByText() { return this; }, getByRole() { return this; }, getByTestId() { return this; },
  };
  const historical: any = { ...hidden, count: async () => 1 };
  const current: any = { ...hidden, count: async () => 1 };
  const turns: any = {
    ...hidden,
    nth: (index: number) => index === 0 ? historical : current,
    page: () => page,
    evaluateAll: async () => submitted
      ? { count: 2, lastId: "current", identities: ["historical", "current"] }
      : { count: 1, lastId: "historical", identities: ["historical"] },
  };
  const page: any = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => submitted ? "https://chatgpt.com/c/current?temporary-chat=true" : CHATGPT_TEMPORARY_CHAT_URL,
    evaluate: async () => ({}),
    locator: (selector: string) => {
      if (selector === CHATGPT_ASSISTANT_TURN_SELECTOR) return turns;
      if (selector === CHATGPT_USER_TURN_SELECTOR) return { ...hidden, evaluateAll: async () => [] };
      if (selector === '[data-turn-id="current"]') return current;
      if (selector === '[data-turn-id="historical"]') return historical;
      if (selector === "[data-turn-id-container], [data-turn-key]") return {
        evaluateAll: async () => submitted ? ["historical", "current"] : ["historical"],
      };
      if (selector === CHATGPT_COMPOSER_SELECTOR) return {
        ...hidden, count: async () => 1, textContent: async () => "",
      };
      return hidden;
    },
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics },
    finalizingRuns: new Set<string>(),
    takePreemptiveRetry: () => undefined,
    runStage: async (_trace: string, _name: string, _timeout: number, action: (signal: AbortSignal) => unknown) => action(controller.signal),
    prepareChatSurface: async () => {},
    selectModelAndEffort: async () => resolveChatGptWebModelMode(
      "gpt-5.6-sol", "xhigh", { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true },
    ),
    attachPromptWithCompactionRetry: async () => {},
    insertPromptText: async () => {},
    attachFiles: async () => {},
    assertPromptAttached: async () => {},
    connectorIsSelected: async () => true,
    activeComposer: async () => ({
      textContent: async () => "", isEditable: async () => true, fill: async () => {}, focus: async () => {},
      locator: () => ({ locator: (selector: string) => selector === CHATGPT_EFFORT_CONTROL_SELECTOR ? {
        ...hidden, count: async () => 1, innerText: async () => "Extra High", getAttribute: async () => "false",
      } : ({ waitFor: async () => {}, isEnabled: async () => true, press: async () => { submitted++; } }) }),
    }),
    waitForSubmissionAccepted: async () => "assistant_turn",
    responseDomSnapshot: async (locator: unknown) => {
      expect(locator).toBe(current);
      snapshotCount++;
      const completionActionVisible = snapshotCount >= 4;
      const rootId = snapshotCount < 6 ? "current-before-remount" : "current-after-remount";
      actions.push(`snapshot:${snapshotCount}:${completionActionVisible}:${rootId}`);
      return {
        responsePresent: true,
        visibleText: FINAL,
        fullHtml: FINAL,
        plainTextFallback: FINAL,
        markdownSegments: [], markdownRoots: [], traceBlocks: [], nativeToolCandidates: [],
        completionActionVisible, globalCompletionActionVisible: true, stoppedThinkingVisible: false,
        projection: { rootId, boundaryProtocolPresent: false, lastNodePresent: true, lastMutationAt: 1, animations: [] },
      };
    },
    waitForTurnDomOrExternalProgress: async () => {
      waitCount++;
      now += waitCount === 1 ? 60_000 : waitCount === 2 ? 1 : 2_000;
    },
    stalledTurnDiagnostic: async () => "fixture stable DOM",
  });
  const turn: BrowserTurn = {
    traceId: "late_completion_action_fixture",
    modelId: "gpt-5.6-sol",
    reasoning: "xhigh",
    modelFamily: "5.6",
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true, extraHighAvailable: true },
    nativeConnector: true,
    abortSignal: controller.signal,
    prepare: async () => ({ text: "Review the candidate.", images: [], transport: "inline", release: () => {} }),
    onSubmitted: () => {},
    onTextDelta: delta => { deltas.push(delta); },
  };
  try {
    const answer = await worker.runBrowserTurn(turn, undefined, page, false);
    return { answer, actions, deltas, snapshotCount, waitCount, now };
  } finally {
    clock.mockRestore();
    rmSync(diagnostics, { recursive: true, force: true });
  }
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
  expect(result.recoveryDecisionAgeMs).toBeGreaterThanOrEqual(60_000);
  expect(result.actions).not.toContain("output-seal");
});

test("the bound recovery prompt survives Lexical paragraph projection without weakening draft ownership", async () => {
  const result = await runFixture({ emptyStopped: true, boundRecoveryParagraphs: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
  expect(result.actions.filter(action => action === "fence-commit")).toHaveLength(1);
});

test("localized ongoing generation after settled native tools does not trigger final recovery", async () => {
  const result = await runFixture({ emptyStopped: true, localizedGeneration: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).toContain("localized-generation-settled");
  expect(result.actions).not.toContain("recovery:eligible");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
  expect(result.actions.some(action => action.startsWith("finalization-only:"))).toBe(false);
});

test("a settled tool can be followed by another tool after a long reasoning gap", async () => {
  const result = await runFixture({ emptyStopped: true, batches: 2, delayedSecondBatch: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions.filter(action => action === "tool-dispatched")).toHaveLength(2);
  expect(result.actions).toContain("delayed-tool-started");
  expect(result.actions).not.toContain("recovery-before-delayed-tool");
});

test("a late completion action is rebound to the current turn and still settles after a remount", async () => {
  const result = await runLateCompletionActionFixture();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.snapshotCount).toBeGreaterThanOrEqual(7);
  expect(result.waitCount).toBeGreaterThanOrEqual(4);
  expect(result.now).toBeGreaterThanOrEqual(164_001);
  expect(result.actions).toContain("snapshot:4:true:current-before-remount");
  expect(result.actions).toContain("snapshot:6:true:current-after-remount");
});

test("a terminal response that keeps projecting is governed by projection progress, not terminal-evidence grace", async () => {
  const result = await runFixture({ slowTerminalProjection: true });
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.filter(action => action.startsWith("snapshot:")).length).toBeGreaterThanOrEqual(6);
});

test("final retry re-proves the same model and effort after Temporary Chat acquires its conversation URL", async () => {
  const conversationRoute = "https://chatgpt.com/c/local-chatgpt%3Areview?temporary-chat=true";
  const result = await runFixture({ emptyStopped: true, conversationRoute });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
  expect(result.selections).toEqual([
    { url: CHATGPT_TEMPORARY_CHAT_URL, model: "gpt-5.6-sol", effort: "xhigh", family: "5.6" },
    { url: conversationRoute, model: "gpt-5.6-sol", effort: "xhigh", family: "5.6" },
  ]);
});

test("final retry cannot transfer the selected model to a different existing conversation", async () => {
  const initialRoute = "https://chatgpt.com/c/owned?temporary-chat=true";
  const result = await runFixture({
    emptyStopped: true, initialRoute,
    conversationRoute: "https://chatgpt.com/c/unrelated?temporary-chat=true",
  });
  expect(result.error).toMatchObject({ code: "upstream_server_error", retryable: false });
  expect(result.answer).toBeUndefined();
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
  expect(result.selections).toHaveLength(1);
  expect(result.selections[0]?.url).toBe(initialRoute);
});

test("a second empty response escalates without another same-conversation submission", async () => {
  const result = await runFixture({ emptyStopped: true, recoveryFails: true });
  expect(result.error).toMatchObject({ code: "chatgpt_completion_evidence_missing", retryable: false, retireSession: true });
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

test("a late Native final cancels an attached recovery prompt before send and resumes tunnel settlement", async () => {
  const result = await runFixture({ emptyStopped: true, lateFinalBeforeRecoverySend: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).toContain("finalization-only:1");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
  expect(result.actions).toContain("clear");
});

test("a late Native final after finalization CAS is buffered until recovery submission is armed", async () => {
  const result = await runFixture({ emptyStopped: true, lateFinalAfterFinalizationCas: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).toContain("late-final-buffered");
  expect(result.actions).toContain("finalization-output-arm:2");
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
});

test("a user draft at atomic recovery submission is preserved and never sent", async () => {
  const result = await runFixture({ emptyStopped: true, draftAtAtomicRecoverySubmission: true });
  expect(result.error).toMatchObject({ code: "chatgpt_surface_changed", retryable: true });
  expect(result.composerText).toBe("User draft at atomic submission");
  expect(result.actions).toContain("user-draft-at-atomic-submission");
  expect(result.actions).toContain("finalization-cancel:2");
  expect(result.actions.filter(action => action === "clear")).toHaveLength(0);
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
});

test("a DOM final appearing after finalization CAS cancels recovery before atomic Send", async () => {
  const result = await runFixture({ emptyStopped: true, settledPreToolProjection: true, lateDomFinalAfterFinalizationCas: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).toContain("late-dom-final");
  expect(result.actions).toContain("finalization-cancel:2");
  expect(result.actions).not.toContain("finalization-output-arm:2");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
}, 10_000);

test("resumed generation cancels recovery before composer mutation and preserves tool availability", async () => {
  const result = await runFixture({ emptyStopped: true, generationResumesBeforeRecoveryInsertion: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).toContain("generation-resumed");
  expect(result.actions).toContain("generation-settled");
  expect(result.actions).not.toContain("insert");
  expect(result.actions).not.toContain("finalization-only:1");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
});

test("generation resuming at recovery insertion returns to observation without sending", async () => {
  const result = await runFixture({ emptyStopped: true, generationResumesAtRecoveryInsertion: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).toContain("generation-resumed");
  expect(result.actions).not.toContain("insert");
  expect(result.actions).not.toContain("finalization-only:1");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
});

test("a tool batch arriving at recovery insertion is still acknowledged and dispatched", async () => {
  const result = await runFixture({ emptyStopped: true, toolBatchAtRecoveryInsertion: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).toContain("recovery-tool-started");
  expect(result.actions.filter(action => action === "tool-dispatched")).toHaveLength(2);
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
});

test("missing-final recovery has no separate send-activation callback after finalization CAS", async () => {
  const result = await runFixture({ emptyStopped: true, recoverySendActivationCallback: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).not.toContain("recovery-send-activated");
  const finalization = result.actions.indexOf("finalization-only:1");
  const arm = result.actions.indexOf("finalization-output-arm:2");
  const recoverySeal = result.actions.findIndex((action, index) =>
    index > finalization && action === "final-answer-admission-sealed");
  const recoveryReopen = result.actions.findIndex((action, index) =>
    index > arm && action === "final-answer-admission-reopened");
  expect(finalization).toBeLessThan(recoverySeal);
  expect(recoverySeal).toBeLessThan(arm);
  expect(arm).toBeLessThan(recoveryReopen);
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
});

test("a final submitted while the recovery click is being acknowledged is delivered after arming", async () => {
  const result = await runFixture({ emptyStopped: true, finalDuringRecoverySubmission: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.indexOf("send")).toBeLessThan(result.actions.indexOf("finalization-output-arm:2"));
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
});

test("an unknown recovery click receipt keeps finalization closed through bounded submission confirmation", async () => {
  const result = await runFixture({ emptyStopped: true, recoveryReceiptFails: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
  expect(result.actions).not.toContain("finalization-cancel:2");
  expect(result.actions).toContain("finalization-output-arm:2");
  expect(result.actions.indexOf("finalization-output-arm:2")).toBeLessThan(result.actions.lastIndexOf("submission-confirmed"));
});

test("a final accepted before an unknown recovery receipt is published after arming", async () => {
  const result = await runFixture({
    emptyStopped: true,
    finalDuringRecoverySubmission: true,
    recoveryReceiptFails: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).toContain("finalization-output-arm:2");
  expect(result.actions).not.toContain("finalization-cancel:2");
});

test("a user draft entered while finalization CAS is pending is preserved", async () => {
  const result = await runFixture({ emptyStopped: true, draftDuringFinalization: true });
  expect(result.composerText).toBe("User draft during CAS");
  expect(result.actions).toContain("user-draft-during-cas");
  expect(result.actions.filter(action => action === "clear")).toHaveLength(0);
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
});

test("pending steering cancels missing-final recovery and sends only the steering continuation", async () => {
  const result = await runFixture({ emptyStopped: true, steeringBeforeRecoverySend: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.actions).toContain("steering-issued");
  expect(result.actions).not.toContain("finalization-only:1");
  expect(result.actions.filter(action => action === "send")).toHaveLength(2);
});

test("a late DOM final cancels an attached recovery prompt and returns through stable fallback", async () => {
  const result = await runFixture({ emptyStopped: true, settledPreToolProjection: true, lateDomFinalBeforeRecoverySend: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).toContain("late-dom-final");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
  expect(result.actions).toContain("clear");
});

test("an activity revision change cancels recovery without falling through to a fresh-surface retry", async () => {
  const result = await runFixture({ emptyStopped: true, finalizationRevisionChanged: true });
  expect(result.error).toMatchObject({
    code: "chatgpt_completion_evidence_missing", retryable: false, retireSession: true,
  });
  expect(result.actions).toContain("finalization-only:1");
  expect(result.actions.filter(action => action === "send")).toHaveLength(1);
  expect(result.actions).toContain("clear");
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

test("retained conversation reselects its message-scoped connector before native work", async () => {
  const result = await runFixture({ retained: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.filter(a => a === "tool-dispatched")).toHaveLength(1);
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
  expect(result.actions.filter(a => a === "message-connector-selected")).toHaveLength(1);
});

test("DOM fallback still rejects an unchanged pre-tool answer", async () => {
  const result = await runFixture({ stale: true });
  expect((result.error as Error).message).toContain("without producing a final answer after its last Codex tool call");
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("fence-commit");
});

test("a stopped pre-tool projection recovers once through Native final instead of throwing outside recovery", async () => {
  const result = await runFixture({ stale: true, postToolRecovery: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).toContain("recovery:eligible");
  expect(result.actions.filter(a => a === "send")).toHaveLength(2);
  expect(result.actions.filter(a => a === "tool-dispatched")).toHaveLength(1);
  expect(result.actions).not.toContain("output-seal");
});

test("a new DOM final cancels stale-projection recovery before send", async () => {
  const result = await runFixture({ stale: true, postToolRecovery: true, lateDomFinalBeforeRecoverySend: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions).toContain("late-dom-final");
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
});

test("stale-projection recovery preserves an occupied composer", async () => {
  const result = await runFixture({ stale: true, postToolRecovery: true, composerBusy: true });
  expect(result.error).toMatchObject({ code: "chatgpt_surface_changed" });
  expect(result.actions).not.toContain("recovery:eligible");
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
  expect(result.deltas).toEqual([]);
});

test.each([
  "lateFinalBeforeRecoverySend", "lateDomFinalAfterFinalizationCas",
  "generationResumesBeforeRecoveryInsertion", "toolBatchAtRecoveryInsertion",
] as const)("stale-projection recovery is cancelled by %s without sending twice", async race => {
  const result = await runFixture({ stale: true, postToolRecovery: true, [race]: true });
  expect(result.error).toBeUndefined();
  expect(result.answer).toBe(FINAL);
  expect(result.deltas).toEqual([FINAL]);
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
});

test("stale-projection recovery is single-shot when its new response is empty", async () => {
  const result = await runFixture({ stale: true, postToolRecovery: true, recoveryFails: true });
  expect(result.error).toMatchObject({ code: "chatgpt_completion_evidence_missing", retryable: false });
  expect(result.actions).toContain("recovery:already_recovered");
  expect(result.actions.filter(a => a === "send")).toHaveLength(2);
  expect(result.deltas).toEqual([]);
});

test("cancelled stale recovery retains its pre-tool completion baseline", async () => {
  const result = await runFixture({ stale: true, postToolRecovery: true, finalizationRevisionChanged: true });
  expect(result.answer).toBeUndefined();
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("output-seal");
  expect(result.actions.filter(a => a === "send")).toHaveLength(1);
});

test.each(["lateDomFinalBeforeRecoverySend", "lateDomFinalAfterFinalizationCas"] as const)(
  "an unknown pre-tool projection stays untrusted after cancelled recovery at %s", async race => {
    const result = await runFixture({ emptyStopped: true, [race]: true });
    expect(result.error).toMatchObject({ code: "chatgpt_completion_evidence_missing", retryable: false });
    expect(result.answer).toBeUndefined();
    expect(result.deltas).toEqual([]);
    expect(result.actions).not.toContain("output-seal");
    expect(result.actions.filter(a => a === "send")).toHaveLength(1);
  },
);

test.each(["missingBaseline", "missingAssistantTurn", "unsettledBaseline"] as const)(
  "an unknown pre-tool baseline from %s requires recovered Native final", async baseline => {
    const result = await runFixture({ postToolRecovery: true, [baseline]: true });
    expect(result.error).toBeUndefined();
    expect(result.answer).toBe(FINAL);
    expect(result.deltas).toEqual([FINAL]);
    expect(result.actions).toContain("recovery:eligible");
    expect(result.actions.filter(a => a === "send")).toHaveLength(2);
    expect(result.actions).not.toContain("output-seal");
  },
);

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

test("an unavailable pre-tool snapshot cannot authorize DOM fallback", async () => {
  const result = await runFixture({ missingBaseline: true });
  expect((result.error as Error).message).toContain("without producing a final answer after its last Codex tool call");
  expect(result.actions).toContain("tool-dispatched");
  expect(result.actions).not.toContain("output-seal");
  expect(result.deltas).toEqual([]);
});

test("a native tool can start before the current assistant turn is projected without trusting a late DOM final", async () => {
  const result = await runFixture({ missingAssistantTurn: true });
  expect((result.error as Error).message).toContain("without producing a final answer after its last Codex tool call");
  expect(result.actions).toContain("tool-dispatched");
  expect(result.actions).not.toContain("output-seal");
  expect(result.deltas).toEqual([]);
});

test("a late pre-tool assistant DOM cannot become the fallback final without native output", async () => {
  const result = await runFixture({ missingAssistantTurn: true, stale: true });
  expect(result.answer).toBeUndefined();
  expect(result.actions).not.toContain("output-seal");
  expect(result.deltas).toEqual([]);
});

test("an unsettled pre-tool assistant projection cannot become the fallback final", async () => {
  const result = await runFixture({ unsettledBaseline: true });
  expect(result.answer).toBeUndefined();
  expect(result.actions).toContain("tool-dispatched");
  expect(result.actions).not.toContain("output-seal");
  expect(result.deltas).toEqual([]);
});

test("an untunneled tool starts before assistant DOM without trusting its late projection", async () => {
  const result = await runFixture({ untunneled: true, missingAssistantTurn: true });
  expect(result.actions).toContain("tool-dispatched");
  expect((result.error as Error).message).toContain("without producing a final answer after its last Codex tool call");
  expect(result.answer).toBeUndefined();
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("fence-commit");
});

test("an untunneled tool turn cannot finalize a late pre-tool projection", async () => {
  const result = await runFixture({ untunneled: true, unsettledBaseline: true });
  expect(result.answer).toBeUndefined();
  expect(result.actions).toContain("tool-dispatched");
  expect(result.deltas).toEqual([]);
  expect(result.actions).not.toContain("fence-commit");
});

test("an explicit native final completes after its tool settles without an assistant DOM turn", async () => {
  const result = await runFixture({ finalAfterToolWithoutAssistantTurn: true });
  expect(result.error).toBeUndefined();
  expect(result.actions).toContain("tool-settled");
  expect(result.actions.filter(a => a === "fence-commit")).toHaveLength(1);
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

for (const scenario of ["status", "native-tool", "static", "foreign"] as const) {
  test(`tunneled progress observes ${scenario} without treating the stop button as progress`, async () => {
    const result = await runFixture({ progressScenario: scenario });
    expect(result.error).toBeUndefined();
    expect(result.answer).toBe(FINAL);
    expect(result.deltas).toEqual([FINAL]);
    expect(result.commentary).toEqual([]);
    const times = [result.progressStartedAt, ...result.progressTimes];
    const longestSilence = Math.max(...times.slice(1).map((time, index) => time - times[index]!));
    if (scenario === "status" || scenario === "native-tool") {
      expect(result.progressTimes.length).toBeGreaterThan(2);
      expect(longestSilence).toBeLessThan(300_000);
    } else {
      expect(longestSilence).toBeGreaterThan(300_000);
      expect(result.progressTimes.length).toBeLessThanOrEqual(2);
    }
  });
}
