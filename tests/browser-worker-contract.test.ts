import * as accountSession from "../src/chatgpt-session";
import { recordConnectorContractProbeQuery } from "../src/adapters/chatgpt-web/connector-contract";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateTokens } from "../src/lib/token-estimate";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

function personalizedTemporaryChatRole(
  _role: string,
  options: { name: string | RegExp },
) {
  const locator = {
    filter: (_filter: { visible: boolean }) => ({
      count: async () => (typeof options.name === "string"
        ? options.name === "Personalized"
        : options.name.test("Personalized")) ? 1 : 0,
    }),
  };
  return locator;
}
import { ChatGptSubmissionRejectionObserver, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptSameSurfaceReadiness } from "../src/adapters/chatgpt-web/same-surface-readiness";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import type { Page } from "playwright-core";
import {
  CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
  ChatGptBrowserObservationTimeoutError,
  MAX_CHATGPT_BROWSER_PAGE_REBINDS,
  withChatGptBrowserObservationTimeout,
} from "../src/adapters/chatgpt-web/browser-observation";
import { CHATGPT_COMPOSER_DOCUMENT_END_KEY, CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS, CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS, CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS, CHATGPT_RESPONSE_DOM_GRACE_MS, ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptPromptAttachmentIntegrityError, ChatGptSuspensionClock, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS, MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS, assertChatGptWebInputWithinLimits, assertChatGptWebMultipartInputWithinLimits, browserDiagnosticCheckpoint, browserDiagnosticIncludesScreenshot, browserStageTimeouts, chatGptExternalProgressSuppressesDomHealth, chatGptSubmissionEvidence, connectAfterClosingBrowserConnection, dismissChatGptTemporaryChatOnboarding, isChatGptTraceControl, redactChatGptUiDiagnostic, remainingStageBudgetMs, resolveBrowserConfig, resolveChatGptToolConfirmation, resolveChatGptWebMultipartStagingMode, setChatGptThinkMode, stripChatGptTraceControlSuffix, throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError, chatGptStoppedThinkingError } from "../src/adapters/chatgpt-web/adapter-error";
import { CHATGPT_CONNECTOR_NAME, DEV_CHATGPT_CONNECTOR_NAME, defaultChromeExecutable, legacyChatGptConnectorMigrationMessage } from "../src/config";
import { chatGptEffortSliderAdvancedTowardTarget, parseChatGptEffortSliderState } from "../src/chatgpt-session";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { chatGptUnavailableProDetail } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_STOPPED_THINKING_LABELS } from "../src/adapters/chatgpt-web/ui-labels";
import type { CodexProviderConfig } from "../src/types";

test("unavailable Pro detail reads only its linked tooltip in any language", async () => {
  const { createWindow } = require("@mixmark-io/domino");
  const details = [
    "Limit reached. Try again after Sep 18, 2026.",
    "上限に達しました。明日の14:30以降にお試しください。",
    "已達上限，請於9月18日後再試。",
    "한도에 도달했습니다. 내일 다시 시도하세요.",
    "Лимит достигнут. Повторите завтра.",
  ];
  const observe = async (detail: string, kind = "owned") => {
    const window = createWindow('<div id="other" role="tooltip">Unrelated old limit</div><div id="menu"><div role="menuitemradio" aria-disabled="true">Pro</div></div>');
    const menu = window.document.getElementById("menu");
    const row = menu.firstElementChild;
    const tooltip = window.document.createElement("div");
    tooltip.id = "owned";
    tooltip.setAttribute("role", kind === "quote" ? "paragraph" : "tooltip");
    tooltip.textContent = detail;
    tooltip.hidden = kind === "hidden";
    window.document.body.appendChild(tooltip);
    if (kind === "enabled") row.removeAttribute("aria-disabled");
    let clock = 0;
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement,
      Date: { now: () => { clock += 1_001; return clock; } },
      setTimeout: (callback: () => void) => { callback(); return 0; },
      getComputedStyle: (element: HTMLElement) => element.style,
    });
    const locator = {
      filter() { return this; },
      count: async () => kind === "ambiguous" ? 2 : 1,
      getAttribute: async (name: string) => row.getAttribute(name),
      hover: async () => { if (kind !== "unlinked") row.setAttribute("aria-describedby", "owned"); },
      evaluate: async (callback: Function) => runInContext(`(${callback.toString()})`, context)(row),
    };
    return chatGptUnavailableProDetail({ getByRole: () => locator } as never);
  };
  for (const detail of details) expect(await observe(detail)).toBe(detail);
  for (const kind of ["quote", "hidden", "enabled", "ambiguous", "unlinked"]) {
    expect(await observe(details[0]!, kind)).toBeUndefined();
  }
  expect(await observe("x".repeat(513))).toBeUndefined();
});

test("browser turns run six at once and queue the seventh in FIFO order", async () => {
  expect(MAX_CHATGPT_BROWSER_TABS).toBe(6);
  const releases = new Map<string, () => void>();
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      releases.set(turn.traceId, () => resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  const browserTurn = (traceId: string) => ({
    traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
  });

  const active = Array.from({ length: 6 }, (_unused, index) => worker.run(browserTurn(`trace_${index + 1}`)));
  await Promise.resolve();
  expect(releases.size).toBe(6);
  const seventh = worker.run(browserTurn("trace_7"));
  const eighth = worker.run(browserTurn("trace_8"));
  await Promise.resolve();
  expect(releases.has("trace_7")).toBeFalse();
  expect(releases.has("trace_8")).toBeFalse();

  releases.get("trace_1")?.();
  await active[0];
  await Promise.resolve();
  expect(releases.has("trace_7")).toBeTrue();
  expect(releases.has("trace_8")).toBeFalse();
  releases.get("trace_2")?.();
  await active[1];
  await Promise.resolve();
  expect(releases.has("trace_8")).toBeTrue();
  for (const traceId of ["trace_3", "trace_4", "trace_5", "trace_6", "trace_7", "trace_8"]) {
    releases.get(traceId)?.();
  }
  await Promise.all([...active.slice(2), seventh, eighth]);
});

test("browser turn orchestration retains owned prompt insertion and semantic submission", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const runBrowserTurn = workerSource.slice(workerSource.indexOf("  private async runBrowserTurn("));
  expect(runBrowserTurn).toContain("this.attachPromptWithCompactionRetry(");
  expect(runBrowserTurn).toContain('.locator("xpath=ancestor::form[1]")');
  expect(runBrowserTurn).toContain('.getByTestId("send-button")');
  expect(runBrowserTurn).toContain("await activateChatGptSendControl(sendButton, stageSignal)");
  expect(runBrowserTurn.indexOf("turn.onSendActivated?.()"))
    .toBeGreaterThanOrEqual(0);
  expect(runBrowserTurn.indexOf("turn.onSendActivated?.()"))
    .toBeLessThan(runBrowserTurn.indexOf("await activateChatGptSendControl(sendButton, stageSignal)"));
  expect(runBrowserTurn).toContain("await this.waitForSubmissionAccepted(");
  expect(workerSource).not.toMatch(/\bclipboard\b|pbcopy|pbpaste/i);
});

test("browser completion settles final projection before fail-closed Markdown finalization", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const gateSource = readFileSync(new URL("../src/adapters/chatgpt-web/final-answer-gate.ts", import.meta.url), "utf8");
  const completion = workerSource.slice(workerSource.indexOf("const completion = completionTracker.update"));
  expect(workerSource).not.toContain("markdownBuffer.currentSnapshotIsConsistent()");
  expect(completion.indexOf("completionTracker.update"))
    .toBeLessThan(completion.indexOf("prepareChatGptFinalAnswer"));
  expect(completion).toContain("throwMarkdownConsistencyError(error)");
  expect(completion).toContain("onTextDelta: emitVisibleAnswerDelta");
  expect(gateSource.indexOf("completionFence.commit(revision)"))
    .toBeLessThan(gateSource.indexOf("options.finalizeAnswer?.()"));
});

test("Stopped thinking fails the current turn immediately", () => {
  const worker = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(worker.match(/if \(snapshot\.stoppedThinkingVisible\) throw chatGptStoppedThinkingError\(\);/g) ?? [])
    .toHaveLength(2);
});

test("stopped-thinking detection recognizes localized UI without matching response content", () => {
  const { createWindow } = require("@mixmark-io/domino") as {
    createWindow(html: string): { document: Document; NodeFilter: typeof NodeFilter };
  };
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("const stoppedThinkingVisible = (() => {")[1]?.split("})();")[0];
  if (!source) throw new Error("Stopped-thinking predicate is missing");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `function detect(root, options, document, NodeFilter, renderedInDom, overlapsRenderedAnswer, overlapsCommentary) { ${source} }`,
  );
  const detect = new Function(`${javascript}; return detect;`)();
  const stopped = (html: string): boolean => {
    const window = createWindow(`<article id="old"><button>已停止思考</button></article><article id="current">${html}</article>`);
    const root = window.document.getElementById("current")!;
    const overlaps = (selector: string) => (candidate: HTMLElement) => Array.from(root.querySelectorAll(selector))
      .some(content => content.contains(candidate) || candidate.contains(content));
    return detect(root, { stoppedThinkingLabels: CHATGPT_STOPPED_THINKING_LABELS }, window.document,
      window.NodeFilter, (element: HTMLElement) => element.style.display !== "none"
        && element.style.visibility !== "hidden" && element.style.opacity !== "0",
      overlaps(".answer"), overlaps(".commentary"));
  };
  for (const label of ["已停止思考", "已中斷思考", "思考を停止しました", "Stopped thinking",
    "Рассуждение остановлено", "توقّف التفكير", "Réflexion interrompue", "생각 중지됨"]) {
    expect(stopped(`<div data-streaming-response-status><button>${label}</button></div>`)).toBeTrue();
    expect(stopped(`<button aria-label="  ${label}  ">Status</button>`)).toBeTrue();
    for (const html of [
      `<div class="answer"><p>${label}</p></div>`,
      `<div class="commentary"><p>${label}</p></div>`,
      `<pre><code>${label}</code></pre>`,
      `<blockquote>${label}</blockquote>`,
      `<div class="answer"><button aria-label="${label}">quoted</button></div>`,
      `<div style="display:none"><button aria-label="${label}">${label}</button></div>`,
      `<button style="visibility:hidden">${label}</button>`,
      `<div style="opacity:0"><button>${label}</button></div>`,
      `<button>"${label}"</button>`,
    ]) expect(stopped(html)).toBeFalse();
  }
  expect(stopped('<button>Stopped\n  thinking</button>')).toBeTrue();
  expect(stopped('<div class="answer">Current answer</div>')).toBeFalse();
  expect(stopped('<button>Thinking</button>')).toBeFalse();
  expect(stopped('<button>Stop thinking</button>')).toBeFalse();
});

test("aborting a queued seventh browser turn removes it without consuming a slot", async () => {
  const releases: Array<() => void> = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    runExclusive: () => new Promise<string>(resolve => { releases.push(() => resolve("done")); }),
  }) as ChatGptBrowserWorker;
  const turn = (traceId: string, abortSignal?: AbortSignal) => ({
    traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    ...(abortSignal ? { abortSignal } : {}),
    onTextDelta() {},
  });
  const active = Array.from({ length: 6 }, (_unused, index) => worker.run(turn(`abort_active_${index}`)));
  await Promise.resolve();
  const controller = new AbortController();
  const queued = worker.run(turn("abort_queued", controller.signal));
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  expect(releases).toHaveLength(6);
  releases.forEach(release => release());
  await Promise.all(active);
});

test("browser diagnostics distinguish composer pills from connector menu rows", () => {
  const diagnosticSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-diagnostics.ts", import.meta.url), "utf8");
  expect(diagnosticSource).toContain("composerSelectedConnectors:");
  expect(diagnosticSource).toContain("mentionMenuConnectors:");
  expect(diagnosticSource).not.toContain("selectedConnectors: rows(");
});

test("browser turns have no absolute deadline unless one is explicitly configured", () => {
  const provider = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).turnTimeoutMs).toBeUndefined();
  expect(resolveBrowserConfig({
    ...provider,
    chatgptWeb: { turnTimeoutMs: 123_000 },
  }).turnTimeoutMs).toBe(123_000);
  expect(() => resolveBrowserConfig({
    ...provider,
    chatgptWeb: { turnTimeoutMs: 0 },
  })).toThrow("turnTimeoutMs must be a positive finite number");
});

test("managed Chrome defaults follow the host platform", () => {
  expect(defaultChromeExecutable("darwin")).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  expect(defaultChromeExecutable("linux")).toBe("/usr/bin/google-chrome");
  expect(defaultChromeExecutable("win32", "D:\\Program Files")).toBe(
    "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
  const provider = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).chromeExecutablePath).toBe(defaultChromeExecutable());
  expect(resolveBrowserConfig(provider).appName).toBe(CHATGPT_CONNECTOR_NAME);
});

test("browser configuration rejects the retired connector identity before opening a turn", () => {
  expect(() => resolveBrowserConfig({
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt",
    chatgptWeb: { appName: "Codex Native" },
  })).toThrow(/requires a newly created connector named "Codex Native2".*do not rename or refresh/s);
});

test("connector verification reports a legacy-only ChatGPT menu as a migration error", async () => {
  const connectorMentionFailure = (ChatGptBrowserWorker.prototype as unknown as {
    connectorMentionFailure(menuRows: unknown, triggerAttempts: number): Promise<string>;
  }).connectorMentionFailure;
  const message = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => ["Codex Native", "Another connector"],
  }, {}, 4);

  expect(message).toContain('Legacy ChatGPT connector "Codex Native" was found');
  expect(message).toContain('newly created connector named "Codex Native2"');
  expect(message).toContain('do not rename or refresh "Codex Native"');
  expect(message).not.toContain("Another connector");

  const mixedMessage = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => ["Codex Native", "Codex Native2"],
  }, {}, 4);
  expect(mixedMessage).not.toContain("Legacy ChatGPT connector");
  expect(mixedMessage).toContain('no row named "Codex Native2"');

  const unrelatedMessage = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => ["新增相片與檔案", "Private project title"],
  }, {}, 7);
  expect(unrelatedMessage).toContain('no row named "Codex Native2"');
  expect(unrelatedMessage).not.toContain("新增相片與檔案");
  expect(unrelatedMessage).not.toContain("Private project title");
});

test("browser stage timeout aborts late page acquisition", async () => {
  let acquisitionAborted = false;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call(
    {},
    "trace_timeout",
    "browser_page",
    10,
    async (signal) => await new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => {
        acquisitionAborted = true;
        resolve("late page");
      }, { once: true });
    }),
  );

  await expect(result).rejects.toThrow("ChatGPT browser stage timed out: browser_page");
  expect(acquisitionAborted).toBeTrue();
});

test("prompt attachment timeout retires the unsubmitted surface for canonical recovery", async () => {
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call(
    {},
    "trace_prompt_timeout",
    "prompt_attachment",
    10,
    async (signal) => await new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => resolve("late prompt"), { once: true });
    }),
  );

  await expect(result).rejects.toMatchObject({
    code: "chatgpt_surface_changed",
    retryable: true,
    retireSession: true,
  });
});

test("browser send stage allows slow retained composers to settle", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("send: 60_000");
});

test("Luna turns without a retained conversation never send connector identity alone", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const runExclusive = workerSource.slice(workerSource.indexOf("  private async runExclusive("));
  const connectorIdentity = runExclusive.indexOf("connectorIdentity: this.config.appName");
  expect(connectorIdentity).toBeGreaterThan(-1);
  expect(runExclusive.slice(connectorIdentity - 260, connectorIdentity)).toContain("turn.conversationKey");
  expect(runExclusive.slice(connectorIdentity - 420, connectorIdentity)).toContain("const nativeConnector = turn.nativeConnector === true || localTools");
});

test("connector verification proves the current schema with an actual connector tool call", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const verifier = workerSource.slice(
    workerSource.indexOf("private async verifyConnectorExclusive"),
    workerSource.indexOf("private async inspectSessionExclusive"),
  );
  expect(verifier).toContain("verifyCurrentConnectorContract(");
  expect(verifier).toContain("broker.register(");
  expect(verifier).toContain("broker.registerSafe(");
  expect(verifier).toContain("broker.revoke(");
  expect(verifier).toContain("nativeConnector: true");
  expect(verifier).not.toContain("connectorContractVerification: true");
  expect(workerSource).not.toContain("turn.connectorContractVerification");
});

test("launcher prompt attachment timeout retries once after rebinding the same surface", async () => {
  const retryPromptAttachment = (ChatGptBrowserWorker.prototype as unknown as {
    retryPromptAttachmentAfterRebind(
      action: () => Promise<void>,
      rebind?: (cause: Error) => Promise<void>,
    ): Promise<void>;
  }).retryPromptAttachmentAfterRebind;
  const events: string[] = [];
  let attempts = 0;

  await retryPromptAttachment.call({}, async () => {
    events.push(`attach:${++attempts}`);
    if (attempts === 1) {
      throw new ChatGptWebAdapterError("ChatGPT browser stage timed out: prompt_attachment", {
        status: 502,
        errorType: "server_error",
        code: "chatgpt_surface_changed",
        retryable: true,
        retireSession: true,
      });
    }
  }, async () => { events.push("rebind"); });

  expect(events).toEqual(["attach:1", "rebind", "attach:2"]);
});

test("launcher prompt attachment recovery does not replay other failures or loop", async () => {
  const retryPromptAttachment = (ChatGptBrowserWorker.prototype as unknown as {
    retryPromptAttachmentAfterRebind(
      action: () => Promise<void>,
      rebind?: (cause: Error) => Promise<void>,
    ): Promise<void>;
  }).retryPromptAttachmentAfterRebind;
  const timeout = () => new ChatGptWebAdapterError("ChatGPT browser stage timed out: prompt_attachment", {
    status: 502,
    errorType: "server_error",
    code: "chatgpt_surface_changed",
    retryable: true,
    retireSession: true,
  });
  let attempts = 0;
  let rebinds = 0;

  await expect(retryPromptAttachment.call({}, async () => {
    attempts += 1;
    throw timeout();
  }, async () => { rebinds += 1; })).rejects.toThrow("prompt_attachment");
  expect({ attempts, rebinds }).toEqual({ attempts: 2, rebinds: 1 });

  const unrelated = new Error("composer rejected input");
  await expect(retryPromptAttachment.call({}, async () => { throw unrelated; }, async () => {
    rebinds += 1;
  })).rejects.toBe(unrelated);
  expect(rebinds).toBe(1);
});

test("a stalled post-submit DOM probe is bounded before same-page launcher recovery", async () => {
  expect(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS).toBe(5_000);
  expect(MAX_CHATGPT_BROWSER_PAGE_REBINDS).toBe(2);
  await expect(withChatGptBrowserObservationTimeout(
    new Promise<never>(() => {}),
    5,
  )).rejects.toBeInstanceOf(ChatGptBrowserObservationTimeoutError);

  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const runBrowserTurn = workerSource.slice(workerSource.indexOf("  private async runBrowserTurn("));
  const submissionAccepted = runBrowserTurn.indexOf("submission accepted evidence=");
  const recovery = runBrowserTurn.indexOf("await tunneledObservationRecovery.recover(", submissionAccepted);
  const duplicateSend = runBrowserTurn.indexOf("sendAttachedPrompt(", recovery);

  const rebindDefinition = runBrowserTurn.indexOf("const rebindLauncherPage");
  const previousConnection = runBrowserTurn.indexOf(
    "const previousConnection = turnConnection;",
    rebindDefinition,
  );
  const failClosedDisconnect = runBrowserTurn.indexOf(
    "connectAfterClosingBrowserConnection(",
    previousConnection,
  );
  const detachClosedConnection = runBrowserTurn.indexOf(
    "turnConnection = undefined;",
    failClosedDisconnect,
  );
  const reconnectStage = runBrowserTurn.indexOf(
    "await this.runStage(turn.traceId, `response_page_rebind_${attempt}`",
    rebindDefinition,
  );
  const reconnectTransport = runBrowserTurn.indexOf(
    "const rebound = await connectLauncherBrowserHost(",
    reconnectStage,
  );

  expect(recovery).toBeGreaterThan(submissionAccepted);
  expect(duplicateSend).toBe(-1);
  expect(rebindDefinition).toBeGreaterThan(-1);
  expect(previousConnection).toBeGreaterThan(rebindDefinition);
  expect(failClosedDisconnect).toBeGreaterThan(previousConnection);
  expect(detachClosedConnection).toBeGreaterThan(failClosedDisconnect);
  expect(reconnectStage).toBeGreaterThan(rebindDefinition);
  expect(reconnectStage).toBeLessThan(previousConnection);
  expect(reconnectTransport).toBeGreaterThan(reconnectStage);
  expect(runBrowserTurn).not.toContain(
    "previous browser observation connection did not close after rebind",
  );
  expect(runBrowserTurn).toContain(
    "if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause",
  );
  expect(runBrowserTurn.slice(recovery)).toContain("responseTurnBinding");
});

test("browser stage aborts immediately when the owning turn is cancelled", async () => {
  const owner = new AbortController();
  let stageAborted = false;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      ownerSignal?: AbortSignal,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call(
    {},
    "trace_abort",
    "prompt_attachment",
    60_000,
    async (signal) => await new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => {
        stageAborted = true;
        resolve("late prompt");
      }, { once: true });
    }),
    owner.signal,
  );
  owner.abort();

  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(stageAborted).toBeTrue();
});

test("a failed stale-browser disconnect prevents the replacement connection", async () => {
  let replacementAttempts = 0;
  const disconnectFailure = new Error("stale CDP transport did not close");

  await expect(connectAfterClosingBrowserConnection(
    { close: async () => { throw disconnectFailure; } },
    async () => {
      replacementAttempts += 1;
      return "replacement";
    },
  )).rejects.toBe(disconnectFailure);

  expect(replacementAttempts).toBe(0);
});

test("closing the launcher page is an immediate terminal turn error", async () => {
  const responseDomSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    responseDomSnapshot(responseTurn: unknown): Promise<unknown>;
  }).responseDomSnapshot;
  const responseTurn = {
    evaluate: async () => { throw new Error("Target page has been closed"); },
    page: () => ({ isClosed: () => true }),
  };

  const error = await responseDomSnapshot.call({}, responseTurn).catch(cause => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    status: 499,
    errorType: "client_closed_request",
    code: "client_cancelled",
    retryable: false,
  });
  expect((error as Error).message).toContain("turn was cancelled");
});

test("new ChatGPT chats select the requested effort and submit the first real turn directly", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const requestedSelection = workerSource.indexOf('"effort_selection"');
  const promptAttachment = workerSource.indexOf('"prompt_attachment"', requestedSelection);
  expect(workerSource).not.toContain("CHATGPT_WARMUP_PROMPT");
  expect(workerSource).not.toContain('"warmup_effort_selection"');
  expect(workerSource).not.toContain('"chat_warmup"');
  expect(workerSource).toMatch(/turn\.modelId,\s+turn\.reasoning/);
  expect(requestedSelection).toBeGreaterThan(-1);
  expect(promptAttachment).toBeGreaterThan(requestedSelection);
});

test("enhanced Web session mode alone raises browser concurrency from five to six", () => {
  const provider = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).maxBrowserTabs).toBe(5);
  expect(resolveBrowserConfig({
    ...provider,
    chatgptWeb: { useEnhancedWebSessionMode: true },
  }).maxBrowserTabs).toBe(6);
});

test("configured Automatic Web concurrency respects Standard and Enhanced ceilings", () => {
  const provider = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig({ ...provider, chatgptWeb: { maxBrowserTabs: 3 } }).maxBrowserTabs).toBe(3);
  expect(resolveBrowserConfig({ ...provider, chatgptWeb: { maxBrowserTabs: 6 } }).maxBrowserTabs).toBe(5);
  expect(resolveBrowserConfig({
    ...provider,
    chatgptWeb: { maxBrowserTabs: 6, useEnhancedWebSessionMode: true },
  }).maxBrowserTabs).toBe(6);
});

test("active composer resolution waits for exactly one visible editor", async () => {
  const composer = { id: "active" };
  const counts = [2, 1];
  const visibleComposers = {
    count: async () => counts.shift() ?? 1,
    first: () => composer,
  };
  const page = {
    locator: () => ({
      filter: (options: { visible: boolean }) => {
        expect(options).toEqual({ visible: true });
        return visibleComposers;
      },
    }),
  };
  const activeComposer = (ChatGptBrowserWorker.prototype as unknown as {
    activeComposer(page: unknown, timeoutMs?: number): Promise<unknown>;
  }).activeComposer;

  expect(await activeComposer.call({}, page, 500)).toBe(composer);
});

test("prompt verification accepts Lexical NBSP preservation without weakening other mismatches", async () => {
  // This reproduces a live macOS compaction failure where a 16k prompt prefix retained the same
  // UTF-16 length but Lexical exposed alternating NBSP/ASCII spaces inside a long indentation run.
  const expected = `prefix C\\n${" ".repeat(24)}suffix`;
  const observed = `prefix C\\n${"\u00A0 ".repeat(12)}suffix`;

  expect(observed.length).toBe(expected.length);
  expect(observed).not.toBe(expected);

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async () => observed,
  }) as ChatGptBrowserWorker;

  const promptTextEquivalent = (ChatGptBrowserWorker.prototype as unknown as {
    promptTextEquivalent(expected: string, observed: string): boolean;
  }).promptTextEquivalent;

  expect(promptTextEquivalent.call(worker, expected, observed)).toBeTrue();

  // The allowance is intentionally directional and restricted to repeated ASCII-space runs.
  expect(promptTextEquivalent.call(worker, "a  b", "a\u00A0 b")).toBeTrue();
  expect(promptTextEquivalent.call(worker, "a b", "a\u00A0b")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "a\u00A0b", "a b")).toBeFalse();

  // Other whitespace and same-length text mutations must remain fail closed.
  expect(promptTextEquivalent.call(worker, "a b", "a\tb")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "a\nb", "a b")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "abc", "abd")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "abc", "ab")).toBeFalse();

  const waitForPromptChunkAttached = (ChatGptBrowserWorker.prototype as unknown as {
    waitForPromptChunkAttached(
      page: Page,
      expected: string,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).waitForPromptChunkAttached;

  const assertPromptAttached = (ChatGptBrowserWorker.prototype as unknown as {
    assertPromptAttached(
      page: Page,
      prompt: string,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).assertPromptAttached;

  // Exercise both verification stages so this is not only a unit test of the comparator.
  await expect(
    waitForPromptChunkAttached.call(worker, {} as Page, expected),
  ).resolves.toBeUndefined();

  await expect(
    assertPromptAttached.call(worker, {} as Page, expected),
  ).resolves.toBeUndefined();
});

test("pre-wrapped prompt verification carries exact leading text through both checkpoints", async () => {
  const observed: boolean[] = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async (_page: Page, _signal: unknown, _operation: unknown, preserveLeading: boolean) => {
      observed.push(preserveLeading);
      return " \u2028exact prompt";
    },
  }) as ChatGptBrowserWorker;
  const methods = ChatGptBrowserWorker.prototype as unknown as {
    waitForPromptChunkAttached(page: Page, text: string, signal?: AbortSignal,
      operation?: unknown, preserveLeading?: boolean): Promise<void>;
    assertPromptAttached(page: Page, text: string, signal?: AbortSignal,
      operation?: unknown, preserveLeading?: boolean): Promise<void>;
  };
  await methods.waitForPromptChunkAttached.call(worker, {} as Page, " \u2028exact prompt", undefined, undefined, true);
  await methods.assertPromptAttached.call(worker, {} as Page, " \u2028exact prompt", undefined, undefined, true);
  expect(observed).toEqual([true, true]);
});

test("compaction prompt attachment retries once only before submission evidence", async () => {
  const attachWithRetry = (ChatGptBrowserWorker.prototype as unknown as {
    attachPromptWithCompactionRetry(
      page: unknown,
      prompt: string,
      localTools: boolean,
      compaction: boolean,
      baseline: unknown,
      captureDiagnostic?: (checkpoint: string) => Promise<void>,
    ): Promise<void>;
  }).attachPromptWithCompactionRetry;
  const baseline = {
    userTurns: {},
    responseTurns: {},
    initialUserTurnCount: 0,
    initialResponseTurnCount: 0,
  };
  let attempts = 0;
  let resets = 0;
  const checkpoints: string[] = [];

  await attachWithRetry.call({
    attachPrompt: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ChatGptPromptAttachmentIntegrityError(
          "ChatGPT composer did not commit a complete prompt insertion chunk (expectedChars=16000, actualChars=0, commonPrefixChars=0)",
        );
      }
    },
    currentSubmissionEvidence: async () => undefined,
    resetCompactionComposerForRetry: async () => { resets += 1; },
  }, {}, "compact prompt", false, true, baseline, async checkpoint => { checkpoints.push(checkpoint); });

  expect(attempts).toBe(2);
  expect(resets).toBe(1);
  expect(checkpoints).toEqual(["prompt-attachment-integrity-retry"]);

  let duplicateAttempts = 0;
  await expect(attachWithRetry.call({
    attachPrompt: async () => {
      duplicateAttempts += 1;
      throw new ChatGptPromptAttachmentIntegrityError("composer cleared");
    },
    currentSubmissionEvidence: async () => "user_turn",
    resetCompactionComposerForRetry: async () => { throw new Error("must not reset"); },
  }, {}, "compact prompt", false, true, baseline)).rejects.toThrow("refused to insert or send");
  expect(duplicateAttempts).toBe(1);

  let normalAttempts = 0;
  await expect(attachWithRetry.call({
    attachPrompt: async () => {
      normalAttempts += 1;
      throw new ChatGptPromptAttachmentIntegrityError("composer cleared");
    },
  }, {}, "normal prompt", false, false, baseline)).rejects.toThrow("composer cleared");
  expect(normalAttempts).toBe(1);
});

test("caret re-anchor fails closed when the live composer cannot be anchored", async () => {
  const reanchorPromptCaret = (ChatGptBrowserWorker.prototype as unknown as {
    reanchorPromptCaret(page: unknown): Promise<void>;
  }).reanchorPromptCaret;
  const evaluateOptions: unknown[] = [];
  let focusCalls = 0;
  const composer = {
    focus: async () => { focusCalls += 1; },
    evaluate: async (_fn: unknown, _arg: unknown, options: unknown) => {
      evaluateOptions.push(options);
      return {
        collapsed: true,
        anchorInsideComposer: true,
        focusInsideComposer: true,
        trailingEditableText: "remaining",
      };
    },
  };

  const failure = reanchorPromptCaret.call({
    activeComposer: async () => composer,
  }, {});
  await expect(failure).rejects.toBeInstanceOf(ChatGptWebAdapterError);
  await expect(failure).rejects.toMatchObject({
    code: "chatgpt_surface_changed",
    retryable: true,
    retireSession: true,
  });
  expect(focusCalls).toBe(2);
  expect(evaluateOptions).toEqual([
    { timeout: 20_000 },
    { timeout: 20_000 },
  ]);
});

test("caret re-anchor retries against the latest Lexical DOM before failing the surface", async () => {
  const reanchorPromptCaret = (ChatGptBrowserWorker.prototype as unknown as {
    reanchorPromptCaret(page: unknown): Promise<void>;
  }).reanchorPromptCaret;
  let evaluations = 0;
  const composer = {
    focus: async () => {},
    evaluate: async () => {
      evaluations += 1;
      return {
        collapsed: true,
        anchorInsideComposer: true,
        focusInsideComposer: true,
        trailingEditableText: evaluations === 2 ? "" : "remaining",
      };
    },
  };

  await reanchorPromptCaret.call({
    activeComposer: async () => composer,
  }, {});
  expect(evaluations).toBe(2);
});

test("selected connector identity does not depend on its visible pill text", async () => {
  const { createDocument } = require("@mixmark-io/domino");
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  worker.config = { appName: "Codex Native2" };
  const selected = async (html: string) => {
    const document = createDocument(`<form id="owner"><div id="composer"></div>${html}</form><form><span data-id="plugin:other" data-keyword="Codex Native2">Other form</span></form>`);
    const composer = {
      locator: (ancestor: string) => {
        expect(ancestor).toBe("xpath=ancestor::form[1]");
        return {
          locator: (selector: string) => ({
            filter: (options: { visible?: boolean }) => ({
              evaluateAll: async (read: (elements: Element[]) => unknown) => read(
                Array.from(document.querySelectorAll(`#owner ${selector}`) as NodeListOf<Element>)
                  .filter(element => !options.visible || !element.hasAttribute("hidden")),
              ),
            }),
          }),
        };
      },
    };
    return worker.connectorIsSelected(composer);
  };
  const pill = '<span data-id="plugin:configured" data-keyword="Codex Native2">表示名</span>';
  expect(await selected(pill)).toBeTrue();
  expect(await selected('<span data-id="plugin:other" data-keyword="Other">Codex Native2</span>')).toBeFalse();
  expect(await selected('<span data-id="unrelated" data-keyword="Codex Native2">Codex Native2</span>')).toBeFalse();
  expect(await selected(pill.replace('<span ', '<span hidden '))).toBeFalse();
  await expect(selected(pill + pill)).rejects.toThrow("duplicate");
});

test("connector selection re-resolves the active composer after ChatGPT replaces it", async () => {
  const calls: Array<[string, string?]> = [];
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const selectedConnector = {
    waitFor: async () => {
      expect(connectorSelected).toBeTrue();
      calls.push(["waitForSelectedConnector"]);
    },
    count: async () => 1,
  };
  const selectedComposer = {
    locator: (selector: string) => {
      expect(selector).toBe('[data-id^="plugin:"][data-keyword]');
      return {
        filter: (options: { hasText: string; visible: boolean }) => {
          expect(options).toEqual({ hasText: "Codex Native2", visible: true });
          return selectedConnector;
        },
      };
    },
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    pressSequentially: async (value: string, options: { delay: number; signal?: AbortSignal; timeout: number }) => {
      expect(options).toEqual({ delay: 25, signal: undefined, timeout: 10_000 });
      calls.push(["pressSequentially", value]);
    },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      connectorSelected = true;
      calls.push(["press"]);
    },
  };
  const page = {
    getByTestId: () => { throw new Error("connector selection opened the plus menu before trying @codex"); },
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
    getByText: (text: string, options: { exact: boolean }) => {
      expect(text).toBe("Codex Native2");
      expect(options).toEqual({ exact: true });
      return { exactConnectorLabel: true };
    },
    locator: (selector: string) => {
      if (selector.includes("__menu-item")) {
        return {
          evaluateAll: async () => [],
          filter: (options: { has: unknown }) => {
            expect(options).toEqual({ has: { exactConnectorLabel: true } });
            return appResult;
          },
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
    keyboard: { press: async () => {} },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  const resolved = await selectConnector.call({
    config: { appName: "Codex Native2" },
    ensureConnectorSurface: async () => {},
    connectorIsSelected: async () => connectorSelected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return connectorSelected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(resolved).toBe(selectedComposer);
  expect(activeComposerCalls).toBe(3);
  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["pressSequentially", "@codex"],
    ["waitForResult"],
    ["press"],
    ["waitForSelectedConnector"],
  ]);
});

test("connector selection resolves a selected pill from the owning composer form", () => {
  const selectedConnector = {};
  const composerForm = {
    locator: (selector: string) => {
      expect(selector).toBe('[data-id^="plugin:"][data-keyword="Codex Native2"]');
      return {
        filter: (options: { visible: boolean }) => {
          expect(options).toEqual({ visible: true });
          return selectedConnector;
        },
      };
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::form[1]");
      return composerForm;
    },
  };
  const selectedConnectorControl = (ChatGptBrowserWorker.prototype as unknown as {
    selectedConnectorControl(composer: unknown): unknown;
  }).selectedConnectorControl;
  const resolved = selectedConnectorControl.call({ config: { appName: "Codex Native2" } }, composer);

  expect(resolved).toBe(selectedConnector);
});

test("connector selection moves highlight to the exact hidden-viewport row before Enter", async () => {
  const keys: string[] = [];
  let arrowCount = 0;
  let selected = false;
  const selectedConnector = { waitFor: async () => {} };
  const appResult = {
    waitFor: async () => {},
    count: async () => 1,
    getAttribute: async () => arrowCount >= 2 ? "" : null,
  };
  const menuRows = {
    evaluateAll: async () => [],
    filter: (options: { visible?: boolean }) => options.visible
      ? { count: async () => 3 }
      : appResult,
  };
  const initialComposer = {
    fill: async () => {},
    focus: async () => {},
    press: async (key: string) => {
      keys.push(key);
      if (key === "ArrowDown") arrowCount += 1;
      if (key === "Enter") selected = true;
    },
    pressSequentially: async () => {},
  };
  const selectedComposer = { selected: true };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => menuRows,
    keyboard: { press: async () => {} },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  await expect(selectConnector.call({
    config: { appName: "Codex Native2 DEV" },
    ensureConnectorSurface: async () => {},
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => selected ? selectedComposer : initialComposer,
  }, page)).resolves.toBe(selectedComposer);
  expect(keys).toEqual(["ArrowDown", "ArrowDown", "Enter"]);
});

test("repeated connector verification reuses its selected pill before clearing the composer", async () => {
  let fillCalls = 0;
  const selectedComposer = {
    fill: async () => { fillCalls += 1; },
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => ({ filter: () => ({}) }),
  };
  const checkpoints: string[] = [];
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: (checkpoint: string) => Promise<void>): Promise<unknown>;
  }).selectConnector;

  await expect(selectConnector.call({
    config: { appName: "Codex Native2 DEV" },
    activeComposer: async () => selectedComposer,
    connectorIsSelected: async () => true,
    ensureConnectorSurface: (ChatGptBrowserWorker.prototype as any).ensureConnectorSurface,
  }, page, async checkpoint => { checkpoints.push(checkpoint); })).resolves.toBe(selectedComposer);

  expect(fillCalls).toBe(0);
  expect(checkpoints).toEqual(["personalization-already-enabled", "connector-already-selected"]);
});

test("connector selection retriggers the complete mention after a fresh-page hydration miss", async () => {
  const calls: string[] = [];
  let menuAttempt = 0;
  let selected = false;
  const timeout = new Error("menu not hydrated");
  timeout.name = "TimeoutError";
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push("selected");
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async () => {
      menuAttempt += 1;
      calls.push(`menu:${menuAttempt}`);
      if (menuAttempt === 1) throw timeout;
    },
    count: async () => 1,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const selectedComposer = {
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async () => { calls.push("clear"); },
    focus: async () => { calls.push("focus"); },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      selected = true;
      calls.push("activate");
    },
    pressSequentially: async (value: string) => {
      expect(value).toBe("@codex");
      calls.push("type");
    },
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => appResult, evaluateAll: async () => [] }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: { press: async () => {} },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  await selectConnector.call({
    config: { appName: "Codex Native2" },
    ensureConnectorSurface: async () => {},
    connectorIsSelected: async () => selected,
    connectorMentionRowTitles: async () => [],
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(calls).toEqual([
    "clear",
    "clear", "focus", "type", "menu:1",
    "clear", "focus", "type", "menu:2",
    "activate", "selected",
  ]);
});

test("connector verification preserves the host-refreshed catalog evidence", async () => {
  const calls: string[] = [];
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-catalog-verification-"));
  const catalogFresh = false;
  let selected = false;
  let now = Date.now();
  const realDateNow = Date.now;
  const timeout = new Error("stale catalog");
  timeout.name = "TimeoutError";
  const selectedConnector = {
    waitFor: async () => { calls.push("selected"); },
  };
  const appResult = {
    waitFor: async () => {
      calls.push(`menu:${catalogFresh ? "fresh" : "stale"}`);
      if (!catalogFresh) {
        now += 2_501;
        throw timeout;
      }
    },
    count: async () => catalogFresh ? 1 : 0,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const visibleRows = {
    allInnerTexts: async () => catalogFresh ? ["Codex Native2"] : ["Another connector"],
  };
  const menuRows = {
    filter: (options: { has?: unknown; visible?: boolean }) => options.visible ? visibleRows : appResult,
  };
  const initialComposer = {
    fill: async () => { calls.push("clear"); },
    focus: async () => { calls.push("focus"); },
    press: async () => { calls.push("dismiss"); },
    pressSequentially: async () => { calls.push("type"); },
  };
  const selectedComposer = { selected: true };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
    reload: async () => { calls.push("reload"); },
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => menuRows,
    evaluate: async () => ({
      url: "https://chatgpt.com/?temporary-chat=true",
      title: "ChatGPT",
      viewport: { width: 800, height: 600 },
      surfaceId: null,
      bodyTextChars: 0,
      composer: { visibleCount: 1, textChars: [0], selectedConnectors: [] },
      effortControls: [],
      effortItems: [],
      menus: [],
      connectorRows: [],
      overlays: [],
      turns: { user: 0, assistant: [] },
    }),
    keyboard: {
      press: async (key: string) => {
        expect(key).toBe("Enter");
        selected = true;
        calls.push("activate");
      },
    },
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    connectorMentionFailure(menuRows: unknown, triggerAttempts: number): Promise<string>;
    connectorMentionRowTitles(menuRows: unknown): Promise<string[]>;
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean): Promise<unknown>;
    verifyConnectorExclusive(): Promise<string>;
  };
  let prepared = 0;
  const fixture = {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnosticsRoot },
    ensurePage: async () => page,
    prepareChatSurface: async () => {
      prepared += 1;
      calls.push(`prepare:${prepared}`);
    },
    activeComposer: async () => selected ? selectedComposer : initialComposer,
    ensureConnectorSurface: async () => {},
    clearChatGptComposerState: async () => {},
    connectorIsSelected: async () => selected,
    connectorMentionFailure: prototype.connectorMentionFailure,
    connectorMentionRowTitles: prototype.connectorMentionRowTitles,
    selectedConnectorControl: () => selectedConnector,
    selectConnector: prototype.selectConnector,
  };

  Date.now = () => now;
  try {
    await expect(prototype.verifyConnectorExclusive.call(fixture)).rejects.toThrow(
      'connector menu opened but exposed no row named "Codex Native2"',
    );
    expect(prepared).toBe(1);
    expect(calls.filter(call => call === "reload")).toEqual([]);
    expect(calls.filter(call => call === "menu:stale")).toHaveLength(MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS);
    expect(calls).not.toContain("menu:fresh");
  } finally {
    Date.now = realDateNow;
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
});

test("connector verification persists ordered browser checkpoints when selection fails", async () => {
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-connector-verification-"));
  const page = {
    evaluate: async () => ({
      composerVisible: true,
      connectorSelected: false,
      mentionMenuVisible: false,
      effortControlVisible: false,
      effortItemsVisible: false,
      menuVisible: false,
      connectorRowsVisible: false,
      overlayVisible: false,
    }),
  };
  const failure = new Error("connector proof failed");
  const verifyConnectorExclusive = (ChatGptBrowserWorker.prototype as unknown as {
    verifyConnectorExclusive(traceId: string): Promise<string>;
  }).verifyConnectorExclusive;

  try {
    await expect(verifyConnectorExclusive.call({
      config: { appName: "Codex Native2", browserDiagnosticsPath: diagnosticsRoot },
      ensurePage: async () => page,
      prepareChatSurface: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        await capture("composer-ready");
      },
      selectConnector: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        await capture("connector-mention-triggered");
        throw failure;
      },
    }, "verify_contract_trace")).rejects.toBe(failure);

    const [traceDirectory] = readdirSync(diagnosticsRoot);
    expect(traceDirectory).toStartWith("verify_contract_trace-");
    const checkpoints = readdirSync(join(diagnosticsRoot, traceDirectory!))
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => JSON.parse(readFileSync(join(diagnosticsRoot, traceDirectory!, name), "utf8")));
    expect(checkpoints.map(checkpoint => checkpoint.checkpoint)).toEqual([
      "connector-verification-started",
      "composer-ready",
      "connector-mention-triggered",
      "connector-verification-failed",
    ]);
    expect(checkpoints.at(-1)).toMatchObject({
      traceId: "verify_contract_trace",
      error: "verification_failed",
      state: { composerVisible: true },
    });
    expect(JSON.stringify(checkpoints)).not.toContain("private");
  } finally {
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
});

test("successful connector verification clears the proven selection before releasing the page", async () => {
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-connector-verification-success-"));
  const socket = defaultBrokerEndpoint(diagnosticsRoot);
  const broker = TurnBroker.forSocket(socket);
  await broker.listen();
  const account = spyOn(accountSession, "detectChatGptAccountCapabilities")
    .mockResolvedValue({ solAvailable: true, proAvailable: true, extraHighAvailable: true });
  const calls: string[] = [];
  const page = {
    evaluate: async () => ({
      location: { origin: "https://chatgpt.com", pathSegments: 0, temporaryChat: true },
      surfaceBound: true,
      composer: { visibleCount: 1, textChars: [0], selectedConnectorCount: 0 },
    }),
  };
  const verifyConnectorExclusive = (ChatGptBrowserWorker.prototype as unknown as {
    verifyConnectorExclusive(traceId: string): Promise<string>;
  }).verifyConnectorExclusive;

  try {
    const result = await verifyConnectorExclusive.call({
      config: { appName: "Codex Native2 DEV", browserDiagnosticsPath: diagnosticsRoot, brokerSocketPath: socket },
      ensurePage: async () => page,
      prepareChatSurface: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        calls.push("prepare");
        await capture("composer-ready");
      },
      selectConnector: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        calls.push("select");
        await capture("connector-selected");
      },
      runBrowserTurn: async (turn: any) => {
        const prompt = (await turn.prepare()).text;
        const query = /__codex_contract_probe__:[^:"\s]+:[a-f0-9]{32}/.exec(prompt)?.[0];
        expect(query).toBeDefined();
        expect(recordConnectorContractProbeQuery(query!, "native")).toBeTrue();
        calls.push("contract");
      },
      clearChatGptComposerState: async () => { calls.push("clear"); },
    }, "verify_success_contract");

    expect(result).toBe("Codex Native2 DEV");
    expect(calls).toEqual(["prepare", "select", "contract", "clear"]);
    const traceDirectory = readdirSync(diagnosticsRoot).find(name => name.startsWith("verify_success_contract-"));
    expect(traceDirectory).toBeDefined();
    const checkpoints = readdirSync(join(diagnosticsRoot, traceDirectory!))
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => JSON.parse(readFileSync(join(diagnosticsRoot, traceDirectory!, name), "utf8")))
      .map(checkpoint => checkpoint.checkpoint);
    expect(checkpoints).toEqual([
      "connector-verification-started",
      "composer-ready",
      "connector-selected",
      "connector-contract-verified",
      "connector-verification-cleared",
      "connector-verification-succeeded",
    ]);
  } finally {
    account.mockRestore();
    await broker.close();
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
});

test("production connector diagnostics distinguish an existing DEV connector", async () => {
  const connectorMentionFailure = (ChatGptBrowserWorker.prototype as unknown as {
    connectorMentionFailure(menuRows: unknown, attempts: number): Promise<string>;
  }).connectorMentionFailure;
  const message = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => [DEV_CHATGPT_CONNECTOR_NAME],
  }, {}, 1);

  expect(message).toContain(`isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)}`);
  expect(message).toContain(`separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}`);
});

test("connector catalog refresh stays fail-closed for absent, legacy, and exact menu evidence", async () => {
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean): Promise<unknown>;
  }).selectConnector;
  const timeout = new Error("menu timeout");
  timeout.name = "TimeoutError";
  const realDateNow = Date.now;
  const run = async (visibleRows: string[]) => {
    let now = realDateNow();
    const page = {
      url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
      getByText: () => ({ exactConnectorLabel: true }),
      locator: () => ({
        filter: (options: { has?: unknown; visible?: boolean }) => options.visible
          ? { allInnerTexts: async () => visibleRows }
          : {
              waitFor: async () => {
                now += 20_001;
                throw timeout;
              },
            },
      }),
    };
    Date.now = () => now;
    try {
      return await selectConnector.call({
        config: { appName: CHATGPT_CONNECTOR_NAME },
        ensureConnectorSurface: async () => {},
        clearChatGptComposerState: async () => {},
        activeComposer: async () => ({
          fill: async () => {},
          focus: async () => {},
          press: async () => {},
          pressSequentially: async () => {},
        }),
        connectorIsSelected: async () => false,
        connectorMentionRowTitles: async () => visibleRows,
        connectorMentionFailure: async (_rows: unknown, attempts: number) => (
          visibleRows.length === 0
            ? `menu absent after ${attempts}`
            : visibleRows.includes("Codex Native")
              ? legacyChatGptConnectorMigrationMessage("Codex Native")
              : `exact row was not visible after ${attempts}`
        ),
      }, page, undefined, true);
    } finally {
      Date.now = realDateNow;
    }
  };

  await expect(run([])).rejects.toThrow("menu absent");
  await expect(run(["Codex Native"])).rejects.toThrow("Legacy ChatGPT connector");
  await expect(run([CHATGPT_CONNECTOR_NAME])).rejects.toThrow("exact row was not visible");
});

test("tool-capable prompts use the shared Playwright connector selection before inserting context", async () => {
  const calls: Array<[string, string?]> = [];
  let selected = false;
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push(["selectedConnector"]);
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async () => { calls.push(["connectorMenu"]); },
    count: async () => 1,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const selectedComposer = {
    focus: async () => { calls.push(["selectedFocus"]); },
    locator: () => ({ filter: () => selectedConnector }),
    evaluate: async (_callback: unknown, value: string) => {
      calls.push(["insertText", value]);
      return true;
    },
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    press: async (value: string) => {
      expect(value).toBe("Enter");
      selected = true;
      calls.push(["selectConnector"]);
    },
    pressSequentially: async (value: string) => { calls.push(["type", value]); },
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector === '[role="dialog"]' ? dialogPage("").page.locator(selector) : selector.includes("__menu-item")
      ? { filter: () => appResult, evaluateAll: async () => [] }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: {
      press: async (value: string) => { calls.push(["press", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;
  let activeComposerCalls = 0;
  await attachPrompt.call({
    config: { appName: "Codex Native2" },
    ensureConnectorSurface: async () => {},
    selectConnector,
    insertPromptText: async (_page: unknown, text: string) => { calls.push(["insertText", text]); },
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
    reanchorPromptCaret: async () => { calls.push(["reanchor"]); },
    assertPromptAttached: async () => { calls.push(["assertPrompt"]); },
  }, page, "context", true);

  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["type", "@codex"],
    ["connectorMenu"],
    ["selectConnector"],
    ["selectedConnector"],
    ["selectedFocus"],
    ["press", CHATGPT_COMPOSER_DOCUMENT_END_KEY],
    ["insertText", " context"],
    ["assertPrompt"],
  ]);
});

test("image attachment readiness uses exact file tiles and not localized remove-button text", async () => {
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const calls: Array<[string, string?]> = [];
  const send = {
    isEnabled: async () => {
      calls.push(["sendEnabled"]);
      return true;
    },
  };
  const composerForm = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("group");
      expect(options).toEqual({ name: "codex-input-image-1.png", exact: true });
      return {
        waitFor: async (state: { state: string; timeout: number }) => {
          expect(state).toEqual({ state: "visible", timeout: 60_000 });
          calls.push(["fileTile", options.name]);
        },
      };
    },
    getByTestId: (testId: string) => {
      expect(testId).toBe("send-button");
      return send;
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::form[1]");
      return composerForm;
    },
  };
  const input = {
    waitFor: async (state: { state: string; timeout: number }) => {
      expect(state).toEqual({ state: "attached", timeout: 20_000 });
      calls.push(["inputReady"]);
    },
    setInputFiles: async (files: Array<{ name: string }>) => {
      calls.push(["setFiles", files.map(file => file.name).join(",")]);
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === 'input[data-testid="upload-photos-input"]') return input;
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => [] };
      }
      return { last: () => composer };
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await attachFiles.call({ activeComposer: async () => composer }, page, {
    images: [{ ref: "codex-input-image-1", imageUrl }],
  });

  expect(calls).toEqual([
    ["inputReady"],
    ["setFiles", "codex-input-image-1.png"],
    ["fileTile", "codex-input-image-1.png"],
    ["sendEnabled"],
  ]);
});

test("effort slider ARIA state fails closed on malformed and unsupported ranges", () => {
  expect(parseChatGptEffortSliderState("0", "4", "3")).toEqual({ min: 0, max: 4, value: 3 });
  for (const attributes of [
    [null, "4", "3"],
    ["", "4", "3"],
    ["0", "4", null],
    ["0", "4", "9"],
    ["0", "5", "3"],
    ["9007199254740992", "9007199254740993", "9007199254740992"],
  ] as const) {
    expect(parseChatGptEffortSliderState(attributes[0], attributes[1], attributes[2])).toBeUndefined();
  }
});

test("Luna-only browser turns verify selector absence instead of opening an effort menu", async () => {
  const checkpoints: string[] = [];
  const hiddenDialog = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const visibleControls = { count: async () => 0 };
  const composerForm = {
    locator: () => ({ filter: () => visibleControls }),
    getByRole: () => ({ filter: () => ({ count: async () => 0 }) }),
  };
  const composer = { locator: () => composerForm };
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
      captureDiagnostic: (checkpoint: string) => Promise<void>,
    ): Promise<{ displayLabel: string; uiEffortIndex: number | null }>;
  }).selectModelAndEffort;

  const mode = await selectModelAndEffort.call({
    activeComposer: async () => composer,
  }, {
    getByText: () => hiddenDialog,
    locator: () => hiddenDialog,
  }, "gpt-5.6-luna", "low", {
    localToolsEnabled: true,
    solAvailable: false,
    proAvailable: false,
  }, async checkpoint => { checkpoints.push(checkpoint); });

  expect(mode).toMatchObject({ displayLabel: "Luna", uiEffortIndex: null });
  expect(checkpoints).toEqual(["luna-default-confirmed"]);
});

function dialogPage(text: string, buttonText = "Got it", errorActionVisible = false): { page: Page; pressed: string[] } {
  const pressed: string[] = [];
  const createDialog = () => {
    let matches = true;
    let buttonMatches = true;
    const button = {
      last: () => button,
      isVisible: async () => matches && buttonMatches,
      press: async (key: string) => { pressed.push(key); },
    };
    const dialog = {
      filter: ({ hasText }: { hasText: string | RegExp }) => {
        matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
        return dialog;
      },
      last: () => dialog,
      isVisible: async () => matches,
      getByRole: (_role: string, options?: { name?: string | RegExp }) => {
        const name = options?.name;
        buttonMatches = name === undefined
          || (typeof name === "string" ? buttonText === name : name.test(buttonText));
        return button;
      },
    };
    return dialog;
  };
  return {
    page: {
      locator: () => createDialog(),
      getByText: (hasText: string | RegExp) => createDialog().filter({ hasText }),
      getByTestId: (testId: string) => {
        const action = {
          last: () => action,
          isVisible: async () => errorActionVisible && testId === "regenerate-thread-error-button",
        };
        return action;
      },
    } as unknown as Page,
    pressed,
  };
}

test.each([
  ["Too many requests. You're making requests too quickly.", "Got it"],
  ["요청을 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도해 주세요.", "알겠습니다"],
])("rate-limit dialog stops automatic resubmission: %s", async (message, button) => {
  const fixture = dialogPage(message, button);

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retireSession: true,
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("a suspicious-activity protection dialog returns a structured hard stop", async () => {
  const fixture = dialogPage("Suspicious activity detected. Please try again later.");

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 403,
    code: "chatgpt_account_safety_stop",
    retryable: false,
    retireSession: true,
  });
});

test("localized suspicious-activity protection dialogs return the same hard stop", async () => {
  for (const text of [
    "偵測到可疑活動。請稍後再試。",
    "检测到可疑活动。请稍后再试。",
    "不審なアクティビティが検出されました。しばらくしてからもう一度お試しください。",
    "의심스러운 활동이 감지되었습니다. 나중에 다시 시도해 주세요.",
  ]) {
    const fixture = dialogPage(text);
    await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
      status: 403,
      code: "chatgpt_account_safety_stop",
      retryable: false,
      retireSession: true,
    });
  }
});

test("the Traditional Chinese ChatGPT rate-limit dialog returns the same structured 429", async () => {
  const fixture = dialogPage(
    "太多要求。你的要求過於頻繁。為了保護你的資料，我們已暫時限制了你的對話存取權限。請稍等幾分鐘後再試一次。",
  );

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retireSession: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("the Simplified Chinese ChatGPT rate-limit dialog returns the same structured 429", async () => {
  const fixture = dialogPage("太多请求。你提出请求的频率过于频繁。", "知道了");

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
    retireSession: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("unrelated ChatGPT dialogs are left untouched", async () => {
  const fixture = dialogPage("Confirm another action");

  await throwIfChatGptRateLimitDialog(fixture.page);
  expect(fixture.pressed).toEqual([]);
});

test("the known terminal ChatGPT error alert returns a structured retryable failure", async () => {
  const fixture = dialogPage(
    "Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
  );

  await expect(throwIfChatGptTerminalErrorAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });
  expect(fixture.pressed).toEqual([]);
});

test("only a size rejection of the current owned browser submission is non-retryable", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
  const observer = new ChatGptSubmissionRejectionObserver();
  const makeRequest = (url = "https://chatgpt.com/backend-api/f/conversation", owner = frame) => ({
    method: () => "POST", url: () => url, frame: () => owner,
  });
  let bodyReads = 0;
  const respond = (request: ReturnType<typeof makeRequest>, code = "message_length_exceeds_limit", status = 413) => {
    page.emit("response", {
      request: () => request, status: () => status, headers: () => ({ "content-type": "application/json" }),
      json: async () => { bodyReads += 1; return { detail: { code } }; },
    });
  };
  const old = makeRequest();
  page.emit("request", old);
  observer.begin(page as unknown as Page);
  respond(old);
  for (const request of [makeRequest("https://other.example/backend-api/f/conversation"),
    makeRequest("https://chatgpt.com/backend-api/sentinel"), makeRequest(undefined, {})]) {
    page.emit("request", request); respond(request);
  }
  expect(bodyReads).toBe(0);
  const successful = makeRequest(); page.emit("request", successful); respond(successful, "message_length_exceeds_limit", 200);
  const unfamiliar = makeRequest(); page.emit("request", unfamiliar); respond(unfamiliar, "unknown_error");
  expect(await observer.failure()).toBeUndefined();
  const current = makeRequest(); page.emit("request", current); respond(current);
  expect(await observer.failure()).toMatchObject({
    status: 400, code: "context_length_exceeded", errorType: "invalid_request_error", retryable: false,
  });
  observer.begin(page as unknown as Page);
  expect(await observer.failure()).toBeUndefined();
  respond(current);
  expect(await observer.failure()).toBeUndefined();
  observer.dispose();
  expect(page.listenerCount("request")).toBe(0);
  expect(page.listenerCount("response")).toBe(0);
});

test("retained response ignores older completion actions but detects a later conflicting turn", async () => {
  const { createWindow } = require("@mixmark-io/domino");
  const snapshotFor = async (later: boolean, bound: boolean) => {
    const button = '<button data-testid="copy-turn-action-button"></button>';
    const window = createWindow(`<div data-turn-id="old">${button}</div><div data-turn-id="current">${bound ? button : ""}</div>${later ? `<div data-turn-id="later">${button}</div>` : ""}`);
    const root = window.document.querySelector('[data-turn-id="current"]');
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    });
    const responseTurn = {
      evaluate: async (callback: Function, options: unknown) => runInContext(`(${callback.toString()})`, context)(root, options),
      page: () => ({ isClosed: () => false }),
    };
    return (ChatGptBrowserWorker.prototype as any).responseDomSnapshot.call({}, responseTurn);
  };
  const retained = await snapshotFor(false, false);
  expect(retained).toMatchObject({ completionActionVisible: false, globalCompletionActionVisible: false });
  expect(chatGptSameSurfaceReadiness({
    responsePresent: true, bindingPresent: true, ...retained,
    composerVisibleCount: 1, composerTextChars: [0], running: false, aborted: false,
  })).toMatchObject({ eligible: true });
  expect(await snapshotFor(false, true)).toMatchObject({ completionActionVisible: true, globalCompletionActionVisible: true });
  const conflict = await snapshotFor(true, false);
  expect(conflict).toMatchObject({ completionActionVisible: false, globalCompletionActionVisible: true });
  expect(chatGptSameSurfaceReadiness({
    responsePresent: true, bindingPresent: true, ...conflict,
    composerVisibleCount: 1, composerTextChars: [0], running: false, aborted: false,
  })).toMatchObject({ eligible: false, reason: "completion_action_conflict" });
});

test("upstream failure diagnostics retain only owned request statuses and failure counts", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame });
  const observer = new ChatGptSubmissionRejectionObserver();
  const request = (url: string, owner = frame) => ({
    method: () => "POST", url: () => url, frame: () => owner,
  });
  observer.begin(page as unknown as Page);
  const foreign = request("https://other.example/backend-api/f/conversation");
  page.emit("request", foreign);
  page.emit("response", { request: () => foreign, status: () => 500 });
  const owned = { ...request("https://chatgpt.com/backend-api/f/conversation"), failure: () => ({ errorText: "net::ERR_HTTP2_PROTOCOL_ERROR https://private.example/path" }) };
  page.emit("request", owned);
  page.emit("response", { request: () => owned, status: () => 502 });
  expect(observer.diagnosticSummary()).toMatchObject({ statuses: [502], pendingRequests: 1 });
  page.emit("requestfailed", owned);
  const completed = request("https://chatgpt.com/backend-api/f/conversation");
  page.emit("request", completed);
  page.emit("response", { request: () => completed, status: () => 200 });
  page.emit("requestfinished", completed);
  expect(observer.diagnosticSummary()).toMatchObject({
    ownedRequests: 2, statuses: [502, 200], requestFailures: 1, failureCodes: ["ERR_HTTP2_PROTOCOL_ERROR"], pendingRequests: 0,
    networkObservationContinuous: true, rebinds: 0,
  });
  expect(JSON.stringify(observer.diagnosticSummary())).not.toContain("private.example");
  observer.noteRebind();
  expect(observer.diagnosticSummary()).toMatchObject({ networkObservationContinuous: false, rebinds: 1 });
  observer.dispose();
  expect(page.listenerCount("requestfailed")).toBe(0);
  expect(page.listenerCount("requestfinished")).toBe(0);
});

test("browser failure path logs bounded upstream evidence and preserves the original error", async () => {
  const root = mkdtempSync(join(tmpdir(), "upstream-failure-log-"));
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const failure = new ChatGptWebAdapterError("ChatGPT displayed an error for this response.", {
    status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
  });
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const prepared = { ...compileChatGptWebPrompt({
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "low" },
    context: { systemPrompt: [], messages: [{ role: "user", content: "private prompt", timestamp: 1 }] },
  }, capabilities), release() {} };
  const worker: any = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: `browser://${root}`,
    chatgptWeb: { browserDiagnosticsPath: root },
  });
  worker.prepareChatSurface = async () => { throw failure; };
  const page = {
    isClosed: () => false,
    evaluate: async () => ({}),
    locator: (selector: string) => ({ filter: () => ({ count: async () => selector.includes("regenerate") ? 1 : 0 }) }),
  } as unknown as Page;
  try {
    await expect(worker.runBrowserTurn({
      traceId: "upstream_log_test", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities,
      prepare: async () => prepared, onTextDelta() {}, onReasoningSummary() {},
    }, undefined, page)).rejects.toBe(failure);
    const line = warning.mock.calls.map(call => String(call[0])).find(value => value.includes("upstream_failure"));
    expect(line).toBeDefined();
    expect(line).not.toContain("private prompt");
    expect(JSON.parse(line!.split(" upstream_failure ")[1]!)).toEqual({
      submission: { ownedRequests: 0, statuses: [], requestFailures: 0, failureCodes: [], pendingRequests: 0,
        networkObservationContinuous: true, rebinds: 0 },
      ui: { globalErrorActions: 1, assistantTurns: 0, stopButtons: 0, globalAlerts: 0 },
    });
    (page as any).locator = () => ({ filter: () => ({ count: () => new Promise(() => {}) }) });
    await expect(worker.runBrowserTurn({
      traceId: "upstream_log_stalled", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities,
      prepare: async () => prepared, onTextDelta() {}, onReasoningSummary() {},
    }, undefined, page)).rejects.toBe(failure);
    const stalled = warning.mock.calls.map(call => String(call[0])).find(value => value.includes("upstream_log_stalled upstream_failure"));
    expect(stalled).toBeDefined();
    expect(JSON.parse(stalled!.split(" upstream_failure ")[1]!).ui).toBeNull();
  } finally { warning.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("effort readback rejects a changed selection or surface before activating Send", async () => {
  const selection = { url: "https://chatgpt.com/?temporary-chat=true", label: "Alto" };
  const state = { url: selection.url, label: "Alto", expanded: "false", editable: true, count: 1 };
  const control = { innerText: async () => state.label, getAttribute: async () => state.expanded };
  const controls = { filter() { return this; }, count: async () => state.count, first: () => control };
  const composer = { locator: () => ({ locator: () => controls }), isEditable: async () => state.editable };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { activeComposer: async () => composer }) as {
    assertSelectedEffort(page: unknown, mode: unknown): Promise<void>;
  };
  const page = { url: () => state.url };
  const mode = { selection };
  await worker.assertSelectedEffort(page, mode);
  for (const change of [{ label: "Medio" }, { url: "https://chatgpt.com/" }, { expanded: "true" },
    { editable: false }, { count: 2 }]) {
    Object.assign(state, { url: selection.url, label: "Alto", expanded: "false", editable: true, count: 1 }, change);
    await expect(worker.assertSelectedEffort(page, mode)).rejects.toMatchObject({
      code: "upstream_server_error", retryable: false,
    });
  }
});

test("the current response error action identifies short and localized failures without clicking Retry", async () => {
  for (const text of [
    "An error occurred while generating the response.",
    "При создании ответа произошла ошибка.",
  ]) {
    const fixture = dialogPage(text, "Retry", true);
    await expect(throwIfChatGptTerminalErrorAlert(fixture.page)).rejects.toMatchObject({
      name: "ChatGptWebAdapterError",
      code: "upstream_server_error",
    });
    expect(fixture.pressed).toEqual([]);
    await throwIfChatGptTerminalErrorAlert(dialogPage(text, "Retry", false).page);
  }
});

test("a previous response error cannot reject a newly accepted user submission", async () => {
  const fixture = dialogPage("Something went wrong. Please see help.openai.com.", "Retry", true);
  const userTurns = { evaluateAll: async () => ["new-user"] };
  const responses = { evaluateAll: async () => ({ count: 0, identities: [], knownTurnIdentities: ["new-user"] }) };
  const newResponse = dialogPage("", "", false).page;
  const originalLocator = fixture.page.locator.bind(fixture.page);
  const page = Object.assign(fixture.page, {
    locator: (selector: string) => selector.includes("stop-button")
      ? { filter() { return this; }, count: async (): Promise<number> => 0 } : originalLocator(selector),
  });
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  const evidence = await worker.waitForSubmissionAccepted(page, userTurns, responses, newResponse, 0,
    { count: 0, identities: [] }, []);
  expect(evidence).toBe("user_turn");
  expect(fixture.pressed).toEqual([]);
});

test("a failed subscription fetch is retryable and does not falsely invalidate ChatGPT login", async () => {
  const fixture = dialogPage(
    "Failed to load subscription: Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
  );

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 503,
    errorType: "server_error",
    code: "chatgpt_subscription_unavailable",
    retryable: true,
  });
});

test.each([
  "Your session has expired. Please log in again to continue using the app. Log in",
  "你的工作階段已過期 請重新登入以繼續使用應用程式。 登入",
  "您的会话已过期 请重新登录以继续使用该应用。 登录",
])("an expired ChatGPT session returns a non-retryable authentication failure: %s", async alertText => {
  const fixture = dialogPage(alertText);

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    errorType: "authentication_error",
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

test("effort selection stops as soon as ChatGPT reports an expired session", async () => {
  const neverVisible = new Promise<void>(() => {});
  const effortControl = {
    last() { return this; },
    waitFor: async () => await neverVisible,
  };
  const composerForm = { locator: () => effortControl };
  const composer = { locator: () => composerForm };
  const sessionAlert = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => {},
    isVisible: async () => true,
  };
  const hiddenDialog = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => await neverVisible,
    isVisible: async () => false,
  };
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
    ): Promise<unknown>;
  }).selectModelAndEffort;

  const selection = selectModelAndEffort.call({
    activeComposer: async () => composer,
  }, {
    locator: (selector: string) => selector.includes('[role="alert"]') ? sessionAlert : hiddenDialog,
  }, "gpt-5.6-sol", "high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });
  const result = await Promise.race([
    selection.catch(error => error),
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 100)),
  ]);

  expect(result).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

test("effort menu waiting stops when ChatGPT reports an expired session", async () => {
  const neverVisible = new Promise<void>(() => {});
  const effortControl = {
    last() { return this; },
    waitFor: async () => {},
    getAttribute: async () => "true",
    press: async () => {},
  };
  const composerForm = { locator: () => effortControl };
  const composer = { locator: () => composerForm };
  const effortChoice = { waitFor: async () => await neverVisible };
  const effortChoices = { nth: () => effortChoice, count: async () => 3 };
  const effortMenu = {
    last() { return this; },
    isVisible: async () => true,
    locator: () => effortChoices,
  };
  const effortSlider = {
    last() { return this; },
    waitFor: async () => await neverVisible,
  };
  const sessionAlert = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => {},
    isVisible: async () => true,
  };
  const hiddenDialog = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => await neverVisible,
    isVisible: async () => false,
  };
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
    ): Promise<unknown>;
  }).selectModelAndEffort;

  const selection = selectModelAndEffort.call({
    activeComposer: async () => composer,
  }, {
    getByText: () => hiddenDialog,
    locator: (selector: string) => {
      if (selector.includes('[role="alert"]')) return sessionAlert;
      if (selector.includes('[role="menu"]') || selector.includes("composer-intelligence-picker-content")) return effortMenu;
      if (selector.includes("data-model-reasoning-effort-slider")) return effortSlider;
      if (selector.includes('[role="dialog"]')) return hiddenDialog;
      return effortMenu;
    },
  }, "gpt-5.6-sol", "high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });
  const result = await Promise.race([
    selection.catch(error => error),
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 400)),
  ]);

  expect(result).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

test("terminal model errors are scoped to the new assistant turn instead of global page alerts", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("throwIfChatGptTerminalErrorAlert(responseTurn)");
  expect(workerSource).not.toContain("throwIfChatGptTerminalErrorAlert(page)");
});

test("submission acceptance stops when its stage is aborted", async () => {
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      page: Page,
      userTurns: unknown,
      responseTurns: unknown,
      responseTurn: unknown,
      initialUserTurnCount: number,
      initialResponseTurn: { count: number; lastId?: string },
      initialTurnIdentities: readonly string[],
      signal: AbortSignal,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const controller = new AbortController();
  controller.abort();

  await expect(waitForSubmissionAccepted.call(
    {},
    {} as Page,
    {},
    {},
    {},
    0,
    { count: 0 },
    [],
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

test("unrelated ChatGPT alerts are not terminal", async () => {
  const fixture = dialogPage("Your file was uploaded successfully");

  await throwIfChatGptTerminalErrorAlert(fixture.page);
  expect(fixture.pressed).toEqual([]);
});

function toolConfirmationPage(options: {
  disappearAfterReads?: number;
  surface?: "dialog" | "card";
  allowLabel?: "Allow once" | "Allow";
} = {}): {
  page: Page;
  pressed: string[];
} {
  let reads = 0;
  let visible = true;
  const pressed: string[] = [];
  const availableButtons = [options.allowLabel ?? "Allow once", "Deny"] as const;
  const button = (name: string | RegExp) => {
    const actualName = availableButtons.find(candidate => (
      typeof name === "string" ? candidate === name : name.test(candidate)
    ));
    return {
      last: () => button(name),
      waitFor: async () => {
        if (!actualName) throw new Error(`Approval button not found: ${String(name)}`);
      },
      press: async (key: string) => {
        if (!actualName) throw new Error(`Approval button not found: ${String(name)}`);
        pressed.push(`${actualName}:${key}`);
        visible = false;
      },
    };
  };
  const dialog = {
    filter: ({ hasText }: { hasText: string }) => {
      expect(hasText).toBe("Allow ChatGPT to use Codex Native?");
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => {
      reads += 1;
      if (options.disappearAfterReads !== undefined && reads >= options.disappearAfterReads) visible = false;
      return visible;
    },
    getByRole: (_role: string, input: { name: string | RegExp }) => button(input.name),
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(visible).toBeFalse();
    },
  };
  const surfaceSelector = options.surface === "card"
    ? '[data-testid="tool-approval-card"]'
    : '[role="dialog"]';
  const hiddenDialog = {
    filter: () => hiddenDialog,
    last: () => hiddenDialog,
    isVisible: async () => false,
  };
  return {
    page: {
      locator: (selector: string) => selector.includes(surfaceSelector)
        ? dialog
        : hiddenDialog,
    } as unknown as Page,
    pressed,
  };
}

test("manual ChatGPT connector approval pauses and resumes the same browser turn", async () => {
  const fixture = toolConfirmationPage({ disappearAfterReads: 3 });

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", false, undefined, 100)).toBeTrue();
  expect(fixture.pressed).toEqual([]);
});

test("an unanswered ChatGPT connector approval is denied instead of aborting the turn", async () => {
  const fixture = toolConfirmationPage();

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", false, undefined, 2)).toBeTrue();
  expect(fixture.pressed).toEqual(["Deny:Enter"]);
});

test("explicit connector auto-approval still selects Allow once", async () => {
  const fixture = toolConfirmationPage();

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow once:Enter"]);
});

test("connector auto-approval accepts the current shortened Allow action", async () => {
  const fixture = toolConfirmationPage({ allowLabel: "Allow" });

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow:Enter"]);
});

test("auto-approval recognizes the observed non-dialog approval card", async () => {
  const fixture = toolConfirmationPage({ surface: "card" });

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow once:Enter"]);
});

test("browser preflight separates model context from one-message transport limits", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  const luna = { localToolsEnabled: false, solAvailable: false, proAvailable: false };

  try {
    assertChatGptWebInputWithinLimits(90_000, 81_808, "gpt-5.6-sol", "medium", plus);
    throw new Error("expected context-window preflight to fail");
  } catch (error) {
    expect(error).toMatchObject({
      name: "ChatGptWebAdapterError",
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    });
    expect(String(error)).toContain("/compact");
  }

  expect(() => assertChatGptWebInputWithinLimits(40_999, 32_807, "gpt-5.6-sol", "low", plus)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(41_000, 32_808, "gpt-5.6-sol", "low", plus)).toThrow(
    "41,000-token context window",
  );
  expect(() => assertChatGptWebInputWithinLimits(89_999, 81_807, "gpt-5.6-sol", "medium", plus)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(89_999, 81_807, "gpt-5.6-sol", "high", plus)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(90_000, 81_808, "gpt-5.6-sol", "high", plus)).toThrow(
    "90,000-token context window",
  );
  expect(() => assertChatGptWebInputWithinLimits(100_000, 100_000, "gpt-5.6-sol", "xhigh", pro)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(100_000, 100_000, "gpt-5.6-sol", "max", pro)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    136_999,
    100_000,
    "gpt-5.6-sol",
    "low",
    pro,
    500_000,
    true,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    137_000,
    100_000,
    "gpt-5.6-sol",
    "low",
    pro,
    500_000,
    true,
  )).toThrow("137,000-token context window");
  expect(() => assertChatGptWebInputWithinLimits(28_000, 19_808, "gpt-5.6-luna", "low", luna)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(28_001, 19_809, "gpt-5.6-luna", "low", luna)).toThrow(
    "ChatGPT Free browser transport budget",
  );

  expect(() => assertChatGptWebInputWithinLimits(
    1,
    1,
    "gpt-5.6-sol",
    "low",
    plus,
    211_256,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    1,
    1,
    "gpt-5.6-sol",
    "low",
    plus,
    211_257,
  )).toThrow("211,256-character ChatGPT composer boundary");
  for (const effort of ["medium", "high"] as const) {
    expect(() => assertChatGptWebInputWithinLimits(
      1,
      1,
      "gpt-5.6-sol",
      effort,
      plus,
      1_048_572,
    )).not.toThrow();
    expect(() => assertChatGptWebInputWithinLimits(
      1,
      1,
      "gpt-5.6-sol",
      effort,
      plus,
      1_048_573,
    )).toThrow("1,048,572-character ChatGPT composer boundary");
  }

  expect(() => assertChatGptWebInputWithinLimits(
    111_192,
    103_000,
    "gpt-5.6-sol",
    "medium",
    pro,
    500_000,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    111_193,
    103_001,
    "gpt-5.6-sol",
    "medium",
    pro,
    500_000,
  )).toThrow("103,000-token ChatGPT browser message boundary");
  expect(() => assertChatGptWebInputWithinLimits(
    112_192,
    104_000,
    "gpt-5.6-sol",
    "max",
    pro,
    520_000,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    112_193,
    104_001,
    "gpt-5.6-sol",
    "max",
    pro,
    520_001,
  )).toThrow("104,000-token ChatGPT browser message boundary");
  // Live reasoning-mode HTTP 413 failures occur even below the token budget.
  for (const effort of ["medium", "high", "xhigh"] as const) {
    expect(() => assertChatGptWebInputWithinLimits(
      75_000 + 8_192, 75_000, "gpt-5.6-sol", effort, pro, 500_000,
    )).not.toThrow();
    expect(() => assertChatGptWebInputWithinLimits(
      75_000 + 8_192, 75_000, "gpt-5.6-sol", effort, pro, 520_000,
    )).toThrow("500,000-character ChatGPT composer boundary");
  }
});

test("Bigger Context fits mixed-density whole records within both token and composer limits", () => {
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false, experimentalBiggerContext: true };
  const dense = "a!b@c#d$e%f^g&h*".repeat(3_750);
  const sparse = "x".repeat(dense.length);
  const whitespace = " ".repeat(450_000);
  // Equal byte sizes must not pack two dense records into one oversized stage. Conversely,
  // token-only balancing must not leave all the low-token whitespace in one oversized composer.
  for (const contents of [
    [dense, dense, sparse, sparse, dense, sparse],
    [dense, dense, whitespace, whitespace, whitespace, whitespace],
  ]) {
    const compiled = compileChatGptWebPrompt({
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      options: { reasoning: "high" },
      _compactionRequest: true,
      context: {
        systemPrompt: [],
        messages: contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 })),
      },
    }, capabilities, undefined, { experimentalMultipartParts: 6 });
    const multipart = compiled.multipart!;
    const records = multipart.parts.flatMap(part => JSON.parse(part).records);
    expect(records).toEqual(contents.map((content, message_index) => ({
      kind: "message", message_index, message: { role: "user", content },
    })));
    expect(compiled.trimmedCompactionMessages).toBeUndefined();

    const transaction = "ctx_0123456789abcdef0123456789abcdef";
    const stages = multipart.parts.slice(0, -1).map((payload, index) => (
      formatChatGptWebMultipartStage(payload, transaction, index + 1, 6).text
    ));
    const final = formatChatGptWebMultipartCommit(multipart, transaction);
    const maxStageMessageTokens = Math.max(...stages.map(text => estimateTokens(text)));
    const maxStageChars = Math.max(...stages.map(text => text.length));
    const stagingMode = resolveChatGptWebMultipartStagingMode(
      CHATGPT_WEB_MODEL_ID, capabilities, maxStageMessageTokens, maxStageChars,
    );
    const finalMessageTokens = estimateTokens(final);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, CHATGPT_WEB_MODEL_ID),
      Math.max(maxStageMessageTokens, finalMessageTokens),
      CHATGPT_WEB_MODEL_ID, "high", capabilities,
      Math.max(maxStageChars, final.length), 6,
      { stagingEffort: stagingMode.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens, finalMessageChars: final.length },
    )).not.toThrow();
  }
}, 90_000);

test("Bigger Context preflight expands only the total context ceiling and keeps each message boundary", () => {
  const plus = {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
    experimentalBiggerContext: true,
  };
  const pro = {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
    experimentalBiggerContext: true,
  };
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_578,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    500_000,
    6,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_579,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    500_000,
    6,
  )).toThrow("six-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_385,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    500_000,
    2,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_386,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    500_000,
    2,
  )).toThrow("two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    269_999,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    6,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    270_000,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    6,
  )).toThrow("270,000-token six-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    180_000,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    2,
  )).toThrow("180,000-token two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    280_000,
    103_001,
    "gpt-5.6-sol",
    "high",
    pro,
    500_000,
    6,
  )).toThrow("ChatGPT message boundary");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    20_000,
    10_000,
    "gpt-5.6-luna",
    "low",
    { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false },
    40_000,
    2,
  )).toThrow("unavailable for Luna");
});

test("Bigger Context stages use the lowest account mode that can carry the stage", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const pro = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, 30_000, 200_000).effort).toBe("low");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, 30_000, 300_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, 80_000, 300_000).effort).toBe("medium");
  // The same text must have the same available input budget inline, staged or in the final part.
  // 80k is the early compaction trigger; the remaining input budget includes an 8192-token reserve.
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, 80_169, 276_680).effort).toBe("medium");
  for (const tokens of [81_807, 81_808]) {
    const inline = () => assertChatGptWebInputWithinLimits(tokens + 8_192, tokens, "gpt-5.6-sol", "high", plus, 300_000);
    const stage = () => resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, tokens, 300_000);
    const final = () => assertChatGptWebMultipartInputWithinLimits(
      tokens + 10_000, tokens, "gpt-5.6-sol", "high", plus, 300_000, 6,
      { stagingEffort: "medium", maxStageMessageTokens: 500, maxStageChars: 2_000, finalMessageTokens: tokens, finalMessageChars: 300_000 },
    );
    for (const preflight of [inline, stage, final]) {
      if (tokens === 81_807) expect(preflight).not.toThrow();
      else expect(preflight).toThrow();
    }
  }
  expect(() => resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol",
    plus,
    81_808,
    300_000,
  )).toThrow("No ChatGPT effort");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, 100_000, 500_000).effort).toBe("low");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, 100_000, 600_000).effort).toBe("max");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, 104_000, 1_200_000).effort).toBe("max");
  expect(() => resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-luna",
    { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false },
    10_000,
    20_000,
  )).toThrow("Luna-only");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    100_000,
    30_000,
    "gpt-5.6-sol",
    "low",
    plus,
    300_000,
    6,
    {
      stagingEffort: "medium",
      maxStageMessageTokens: 30_000,
      maxStageChars: 300_000,
      finalMessageTokens: 1_000,
      finalMessageChars: 4_000,
    },
  )).not.toThrow();
});

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("browser stage diagnostics use safe bounded artifact names", () => {
  expect(browserDiagnosticCheckpoint("effort menu / before click")).toBe("effort-menu-before-click");
  expect(browserDiagnosticCheckpoint("../turn_token secret")).toBe("turn_token-secret");
  expect(browserDiagnosticCheckpoint("x".repeat(200))).toHaveLength(80);
});

test("browser diagnostics avoid screenshots at every checkpoint unless full capture is requested", () => {
  expect(browserDiagnosticIncludesScreenshot("send-ready", false)).toBeFalse();
  expect(browserDiagnosticIncludesScreenshot("response-visible", false)).toBeFalse();
  expect(browserDiagnosticIncludesScreenshot("response-stalled-30s", false)).toBeFalse();
  expect(browserDiagnosticIncludesScreenshot("turn-failed", false)).toBeFalse();
  expect(browserDiagnosticIncludesScreenshot("send-ready", true)).toBeTrue();
});

test("visible DOM trace interleaves statuses and explicit intermediate commentary", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initialBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "answer", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...initialBlocks], false, 1_000)).toEqual([]);
  expect(tracker.observe([...initialBlocks], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
  ]);
  const commentaryBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "commentary", text: "The browser DOM confirms the boundary." },
    { kind: "answer", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...commentaryBlocks], false, 1_200)).toEqual([]);
  expect(tracker.observe([...commentaryBlocks], false, 1_300)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime evidence" },
    { kind: "commentary", text: "The browser DOM confirms the boundary." },
  ]);
  expect(tracker.observe([
    { kind: "answer", text: "Final answer complete" },
  ], true)).toEqual([]);
});

test("visible DOM trace does not duplicate a phase after a transient DOM disappearance", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Thinking" },
  ]);
  expect(tracker.observe([], false, 1_150)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_300)).toEqual([]);
});

test("streaming commentary resumes by delta after a transient DOM disappearance", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([{ kind: "commentary", text: "Checking sources" }], false, 1_000)).toEqual([
    { kind: "commentary", text: "Checking sources" },
  ]);
  expect(tracker.observe([], false, 1_010)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking sources and dates" },
  ], false, 1_020)).toEqual([
    { kind: "commentary", text: " and dates", continuation: true },
  ]);
});

test("visible DOM trace emits a short-lived reasoning label on its first observation", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([
    { kind: "status", text: "Binding Codex turn context" },
  ], false, 1_000)).toEqual([
    { kind: "reasoning", text: "Binding Codex turn context" },
  ]);
});

test("completed-turn evidence flushes a short-lived reasoning label immediately", () => {
  const tracker = new ChatGptVisibleTraceTracker(10_000);
  expect(tracker.observe([
    { kind: "status", text: "Reviewing ChatGPT Web Prompt and State Handling" },
  ], true, 1_000)).toEqual([
    { kind: "reasoning", text: "Reviewing ChatGPT Web Prompt and State Handling" },
  ]);
});

test("effort slider accepts semantic jumps only when they advance to the target", () => {
  expect(chatGptEffortSliderAdvancedTowardTarget(4, 2, 2)).toBe(true);
  expect(chatGptEffortSliderAdvancedTowardTarget(0, 2, 2)).toBe(true);
  expect(chatGptEffortSliderAdvancedTowardTarget(4, 4, 2)).toBe(false);
  expect(chatGptEffortSliderAdvancedTowardTarget(4, 2, 3)).toBe(false);
  expect(chatGptEffortSliderAdvancedTowardTarget(2, 4, 0)).toBe(false);
});

test("a tool boundary flushes short-lived commentary without waiting for the stability timer", () => {
  const tracker = new ChatGptVisibleTraceTracker(10_000);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking the retained session", complete: false },
  ], false, 1_000)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking the retained session", complete: true },
    { kind: "status", text: "Called Codex Native2" },
  ], false, 1_010)).toEqual([{
    kind: "commentary",
    text: "Checking the retained session",
  }]);
});

test("a structurally completed trailing Pro commentary does not wait for another parsed trace block", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const commentary = [{
    kind: "commentary",
    text: "The tracked worktree is clean; I’m preserving the untracked user artifacts.",
    complete: true,
  }] as const;
  expect(tracker.observe([...commentary], false, 1_000)).toEqual([]);
  expect(tracker.observe([...commentary], false, 1_100)).toEqual([{
    kind: "commentary",
    text: "The tracked worktree is clean; I’m preserving the untracked user artifacts.",
  }]);
});

test("visible DOM trace emits one complete commentary paragraph before the next action", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initial = [
    { kind: "commentary", text: "I’m reading", complete: false },
  ] as const;
  expect(tracker.observe([...initial], false, 1_000)).toEqual([]);
  expect(tracker.observe([...initial], false, 1_100)).toEqual([{
    kind: "commentary",
    text: "I’m reading",
  }]);
  const expanded = [
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture", complete: false },
  ] as const;
  expect(tracker.observe([...expanded], false, 1_150)).toEqual([]);
  expect(tracker.observe([...expanded], false, 1_250)).toEqual([{
    kind: "commentary",
    text: " the repository’s mandatory architecture",
    continuation: true,
  }]);
  const completed = [
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture", complete: true },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...completed], false, 1_250)).toEqual([]);
  expect(tracker.observe([...completed], false, 1_350)).toEqual([
    { kind: "reasoning", text: "Read context file contents" },
  ]);
  expect(tracker.observe([...completed], false, 1_450)).toEqual([]);
});

test("response DOM separates streaming commentary from the final Markdown answer", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("const answerRootSelector = '.markdown, [data-message-author-role=\"assistant\"] .puik-root.not-markdown > [class*=\"_DilResponseRoot\"]'");
  expect(workerSource).toContain("const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(answerRootSelector)]");
  expect(workerSource).toContain("const selectChatGptAnswerRoots = (");
  expect(workerSource).toContain('candidate.closest("[data-streaming-response-status]") !== null');
  expect(workerSource).toContain("const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>");
  expect(workerSource).toContain("const firstStatusContainer = statusContainers[0]");
  expect(workerSource).toContain("candidate.compareDocumentPosition(firstStatusContainer)");
  expect(workerSource).toContain("const renderedRoots = classified.answerRoots;");
  expect(workerSource).toContain("markdownRoots.filter(candidate => !commentary.includes(candidate))");
  expect(workerSource).toContain("const markdownSegments = markdownRoots");
  expect(workerSource).toContain("ownership.observe(snapshot.markdownRoots)");
  expect(workerSource).toContain('fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join("")');
  expect(workerSource).toContain("const flattened: Array<{");
  expect(workerSource).toContain("const blockMarkdownTags = new Set([");
  expect(workerSource).toContain("markdownRoot.childNodes.forEach((node) => {");
  expect(workerSource).toContain("flushInlineRun();");
  expect(workerSource).toContain('tag: "inline"');
  expect(workerSource).not.toContain("const hasDirectText =");
  expect(workerSource).toContain("const sourceRange = (candidate: Element)");
  expect(workerSource).toContain('candidate.getAttribute("data-start")');
  expect(workerSource).toContain('candidate.getAttribute("data-end")');
  expect(workerSource).toContain('key: segment.sourceStart !== undefined');
  expect(workerSource).toContain('`${segment.sourceStart}:${segment.tag}`');
  expect(workerSource).toContain("sourceStart: Math.min(...ranges.map");
  expect(workerSource).toContain("sourceEnd: Math.max(...ranges.map");
  expect(workerSource).toContain("streamable: (rootIsComplete || index < segments.length - 1) && !segment.pendingLinks");
  expect(workerSource).toContain("markdownBuffer.observe(snapshot.markdownSegments)");
  expect(workerSource).toContain("const completion = completionTracker.update({");
  expect(workerSource).not.toContain("markdownBuffer.currentSnapshotIsConsistent()");
  expect(workerSource).not.toContain("streamCompletedBlocks");
  expect(workerSource).toContain('code: "multipart_protocol_violation"');
  expect(workerSource).not.toContain("multipartFailed");
  expect(workerSource).toContain('"final_part_effort_selection"');
  expect(workerSource).not.toContain("stableHtml:");
  expect(workerSource).not.toContain("observeStableHtml");
  expect(workerSource).toContain("const overlapsRenderedAnswer = (candidate: HTMLElement)");
  expect(workerSource).toContain("const statusSemantic = (candidate: HTMLElement)");
  expect(workerSource).toContain('candidate.querySelectorAll<HTMLElement>(".sr-only")');
  expect(workerSource).not.toContain("const adjacentCommentary");
  expect(workerSource).toContain('candidate.closest<HTMLElement>("[data-item-anchor]")');
  expect(workerSource).toContain("const hasFollowingRenderedSibling = (candidate: HTMLElement)");
  expect(workerSource).toContain("itemAnchor?.nextElementSibling");
  expect(workerSource).toContain("block.complete === true || index < blocks.length - 1");
  expect(workerSource).toContain("const traceByKey = new Map<string, ChatGptVisibleTraceBlock>()");
  expect(workerSource).toContain('uiControl: candidate.matches("button")');
  expect(workerSource).toContain("!overlapsRenderedAnswer(semantic)");
  expect(workerSource).toContain("!overlapsRenderedAnswer(container)");
  expect(workerSource).not.toContain('fullHtml: rendered?.innerHTML ?? ""');
});
test("visible DOM trace keeps a complete action phrase instead of a nested count", () => {
  expect(new ChatGptVisibleTraceTracker(0).observe([
    { kind: "status", text: "Searched\n5\nsites" },
  ], false)).toEqual([
    { kind: "reasoning", text: "Searched 5 sites" },
  ]);
});

test("visible DOM trace waits out animated Pro fragments and appends genuine growth", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([{ kind: "status", text: "I" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "I’m" }], false, 1_025)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "’m seeking" }], false, 1_050)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "a concrete stack" }], false, 1_075)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity" },
  ], false, 1_100)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity" },
  ], false, 1_200)).toEqual([{
    kind: "reasoning",
    text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity",
  }]);

  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity, including validation" },
  ], false, 1_250)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity, including validation" },
  ], false, 1_350)).toEqual([{
    kind: "reasoning",
    text: ", including validation",
    continuation: true,
  }]);
});

test("trace parsing excludes the Answer now UI control", () => {
  expect(isChatGptTraceControl({ kind: "status", text: "Answer now" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Thinking" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Switch model", uiControl: true })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "More actions", uiControl: true })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Inspecting models", uiControl: false })).toBe(false);
  expect(isChatGptTraceControl({ kind: "status", text: "Reviewing repository invariants" })).toBe(false);
  expect(isChatGptTraceControl({ kind: "answer", text: "Answer now" })).toBe(false);
});

test("trace parsing removes an Answer now control appended to live reasoning", () => {
  expect(stripChatGptTraceControlSuffix({
    kind: "status",
    text: "Pro thinking\nAnswer now",
  })).toEqual({
    kind: "status",
    text: "Pro thinking",
  });
  expect(stripChatGptTraceControlSuffix({
    kind: "status",
    text: "Answer now",
  })).toEqual({
    kind: "status",
    text: "",
  });
  expect(stripChatGptTraceControlSuffix({
    kind: "answer",
    text: "Tell the user to select Answer now",
  })).toEqual({
    kind: "answer",
    text: "Tell the user to select Answer now",
  });
});

test("browser DOM health fails closed on a vanished or empty ChatGPT response", () => {
  const missing = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };
  expect(missing.update(absent, 1_000)).toBeUndefined();
  expect(missing.update(absent, 2_000)).toContain("did not create a response DOM");

  const empty = new ChatGptTurnDomHealthTracker(1_000, 500);
  const terminal = {
    ...absent,
    responsePresent: true,
    running: false,
    completionActionVisible: true,
  };
  expect(empty.update(terminal, 1_000)).toBeUndefined();
  expect(empty.update(terminal, 1_500)).toContain("completed without a final answer");

  const missingCompletionAction = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const completedWithoutMarker = {
    ...terminal,
    currentText: "complete answer",
    completionActionVisible: false,
  };
  expect(missingCompletionAction.update(completedWithoutMarker, 1_000)).toBeUndefined();
  expect(missingCompletionAction.update(completedWithoutMarker, 1_749)).toBeUndefined();
  expect(missingCompletionAction.update(completedWithoutMarker, 1_750)).toBeUndefined();
  expect(missingCompletionAction.update(completedWithoutMarker, 1_751)).toContain("DOM may have changed");
  expect(missingCompletionAction.failureKind()).toBe("completion_evidence");

  const actionAppearsAtBoundary = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  expect(actionAppearsAtBoundary.update(completedWithoutMarker, 1_000)).toBeUndefined();
  expect(actionAppearsAtBoundary.update(completedWithoutMarker, 1_750)).toBeUndefined();
  expect(actionAppearsAtBoundary.update({
    ...completedWithoutMarker,
    completionActionVisible: true,
  }, 1_751)).toBeUndefined();
});

test("stalled-turn diagnostics record DOM metrics without response or overlay content", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = workerSource.indexOf("private async stalledTurnDiagnostic");
  const end = workerSource.indexOf("private async runExclusive", start);
  const diagnosticSource = workerSource.slice(start, end);
  expect(diagnosticSource).toContain("textChars:");
  expect(diagnosticSource).toContain("htmlChars:");
  expect(diagnosticSource).not.toMatch(/\btext:\s*(?:root|candidate)\.innerText/);
  expect(diagnosticSource).not.toMatch(/\bariaLabel:\s*candidate\.getAttribute/);
});

test("browser completion scopes its primary action evidence to ChatGPT's copy control", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(sessionSource).toContain('button[data-testid="copy-turn-action-button"]');
  expect(workerSource).toContain("CHATGPT_COMPLETION_ACTION_SELECTOR");
  expect(workerSource).not.toContain('root.querySelectorAll<HTMLElement>("button")');
});

test("retained-only turns fail before prompt preparation on a fresh launcher surface", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const lease = workerSource.indexOf("const surfaceId = lease.surfaceId");
  const protectedTurn = workerSource.indexOf("    try {", lease);
  const guard = workerSource.indexOf("turn.requireRetainedConversation && lease.reused !== true", lease);
  const run = workerSource.indexOf("return await this.runBrowserTurn", guard);
  expect(lease).toBeGreaterThan(-1);
  expect(protectedTurn).toBeGreaterThan(lease);
  expect(guard).toBeGreaterThan(protectedTurn);
  expect(guard).toBeGreaterThan(lease);
  expect(run).toBeGreaterThan(guard);
});

test("browser completion requires a stable public final projection", () => {
  const tracker = new ChatGptCompletionTracker(2_000);
  const stopped = {
    responsePresent: true,
    running: false,
    currentText: "complete answer",
    currentHtml: '<p data-start="0" data-end="15" data-is-last-node>complete answer</p>',
    completionActionVisible: false,
    projection: {
      rootId: "dom-1",
      lastNodePresent: true,
      boundaryStart: "0",
      boundaryEnd: "15",
      lastMutationAt: 1_000,
      animations: [],
    },
  };
  expect(tracker.update(stopped, 1_000).status).toBe("waiting");
  expect(tracker.update(stopped, 11_000).status).toBe("waiting");

  const completed = { ...stopped, completionActionVisible: true };
  expect(tracker.update(completed, 12_000).status).toBe("waiting");
  expect(tracker.update(completed, 13_999).status).toBe("waiting");
  expect(tracker.update(completed, 14_000).status).toBe("complete");
});

test("a stalled final projection retires the surface before Markdown is finalized", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const decision = source.indexOf("const completion = completionTracker.update");
  const stalled = source.indexOf('completion.status === "stalled"', decision);
  const retirement = source.indexOf("retireSession: true", stalled);
  const completed = source.indexOf('completion.status === "complete"', stalled);
  const prepare = source.indexOf("prepareChatGptFinalAnswer", completed);

  expect(decision).toBeGreaterThan(-1);
  expect(stalled).toBeGreaterThan(decision);
  expect(retirement).toBeGreaterThan(stalled);
  expect(completed).toBeGreaterThan(retirement);
  expect(prepare).toBeGreaterThan(completed);
});

test("browser send accepts only conclusive ChatGPT submission evidence", () => {
  const idle = {
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 2,
    assistantTurnCount: 2,
    generationRunning: false,
  };
  expect(chatGptSubmissionEvidence(idle)).toBeUndefined();
  expect(chatGptSubmissionEvidence({ ...idle, userTurnCount: 2 })).toBe("user_turn");
  expect(chatGptSubmissionEvidence({ ...idle, assistantTurnCount: 3 })).toBe("assistant_turn");
  expect(chatGptSubmissionEvidence({ ...idle, generationRunning: true })).toBe("generation_running");
});

test("visible reasoning keeps the browser turn healthy before final assistant markdown exists", () => {
  const health = new ChatGptTurnDomHealthTracker(1_000, 500);
  const reasoning = {
    responsePresent: true,
    running: false,
    currentText: "",
    completionActionVisible: false,
  };
  expect(health.update(reasoning, 1_000)).toBeUndefined();
  expect(health.update(reasoning, 10_000)).toBeUndefined();
});

test("suspending DOM health for proven MCP progress restarts the missing-response window", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };

  // The response DOM is unavailable from the first observation, so the window opens here.
  expect(tracker.update(absent, 1_000)).toBeUndefined();

  // Proven tool-call activity suspends the check. Charging that suspended stretch against the
  // grace period is what let a live turn be cancelled the moment liveness lapsed.
  tracker.clearMissingResponse();

  expect(tracker.update(absent, 10_000)).toBeUndefined();
  expect(tracker.update(absent, 10_999)).toBeUndefined();
  expect(tracker.update(absent, 11_000)).toContain("did not create a response DOM");
});

test("clearing the missing-response window preserves whether a response was ever observed", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
  const present = {
    responsePresent: true,
    running: true,
    currentText: "partial",
    completionActionVisible: false,
  };
  const absent = { ...present, responsePresent: false, currentText: "" };

  expect(tracker.update(present, 1_000)).toBeUndefined();
  expect(tracker.update(absent, 1_500)).toBeUndefined();
  tracker.clearMissingResponse();
  expect(tracker.update(absent, 5_000)).toBeUndefined();
  expect(tracker.update(absent, 6_000)).toContain("response DOM disappeared");
});

test("the launcher helper transport carries MCP progress into the out-of-process browser worker", () => {
  const client = readFileSync("src/adapters/chatgpt-web/launcher-helper-client.ts", "utf8");
  const forwarding = readFileSync("src/adapters/chatgpt-web/launcher-helper-progress.ts", "utf8");
  const helper = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");
  const fence = readFileSync("src/adapters/chatgpt-web/browser-helper-fence.ts", "utf8");

  // The browser worker runs in the helper process while the Codex MCP broker runs in the daemon.
  // If progress stops crossing that boundary the worker silently observes "never live" and cancels
  // turns whose tool calls are still completing, so both ends of the transport are asserted here.
  expect(client).toContain("forwardLauncherHelperProgress");
  expect(forwarding).toMatch(/type: "progress", id: turn\.traceId, snapshot/);
  expect(helper).toMatch(/message\.type === "progress"/);
  expect(fence).toContain("ChatGptMirroredTurnProgress");
  expect(fence).toMatch(/externalProgress: session\.progress/);
});

test("turn DOM health still defers to proven MCP progress in both wait loops", () => {
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  expect((worker.match(/externalProgressLive,/g) ?? []).length).toBeGreaterThanOrEqual(3);
});

test("proven MCP progress vetoes every terminal DOM conclusion, not just a missing response", () => {
  // Reproduces trace 970896e96e84: the response DOM is present and the renderer never exposes a
  // completed-turn action, yet tool calls keep completing. "Stopped generating" is false there.
  const stalled = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const answeredWithoutCompletionAction = {
    responsePresent: true,
    running: false,
    currentText: "partial answer",
    completionActionVisible: false,
  };

  expect(stalled.update({ ...answeredWithoutCompletionAction, externalProgressLive: true }, 1_000)).toBeUndefined();
  expect(stalled.update({ ...answeredWithoutCompletionAction, externalProgressLive: true }, 10_000)).toBeUndefined();

  // Once the model genuinely stops, the window starts fresh rather than charging the live stretch.
  expect(stalled.update(answeredWithoutCompletionAction, 10_100)).toBeUndefined();
  expect(stalled.update(answeredWithoutCompletionAction, 10_849)).toBeUndefined();
  expect(stalled.update(answeredWithoutCompletionAction, 10_850)).toBeUndefined();
  expect(stalled.update(answeredWithoutCompletionAction, 10_851)).toContain("did not expose its completed-turn action");

  const empty = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const completedEmpty = {
    responsePresent: true,
    running: false,
    currentText: "",
    completionActionVisible: true,
  };
  expect(empty.update({ ...completedEmpty, externalProgressLive: true }, 1_000)).toBeUndefined();
  expect(empty.update({ ...completedEmpty, externalProgressLive: true }, 9_000)).toBeUndefined();
  expect(empty.update(completedEmpty, 9_100)).toBeUndefined();
  expect(empty.update(completedEmpty, 9_600)).toContain("completed without a final answer");
});

test("live external progress still records that a response DOM was observed", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };

  expect(tracker.update({
    responsePresent: true,
    running: true,
    currentText: "",
    completionActionVisible: false,
    externalProgressLive: true,
  }, 1_000)).toBeUndefined();

  // The turn is reported as vanished rather than never created, so `sawResponse` survived.
  expect(tracker.update(absent, 2_000)).toBeUndefined();
  expect(tracker.update(absent, 3_000)).toContain("response DOM disappeared");
});

test("an accepted turn survives internal observation faults instead of being torn down", () => {
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");

  // A TypeError while reading the page is a defect in this worker, not evidence about ChatGPT.
  // Failing the turn on one loses an accepted ChatGPT turn that is never resent.
  expect(MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS).toBeGreaterThan(1);
  expect(worker).toContain("if (!(observationError instanceof TypeError) || observedThisIteration) throw observationError;");
  expect(worker).toContain("internalObservationFaults = 0;");
  expect(worker).toMatch(/internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS/);

  // Liveness may postpone a verdict but never waive it, so a tool call that never returns cannot
  // hold an undeadlined turn open forever.
  expect(CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS).toBeGreaterThan(CHATGPT_RESPONSE_DOM_GRACE_MS);

  // Chain-of-thought containment is commentary regardless of document position.
  expect(worker).toContain('candidate.closest(\'[data-testid^="cot-v5"]\') !== null');
});

test("stale MCP progress stops suppressing DOM health without penalising long active turns", () => {
  const outstanding = { revision: 2, lastToolBatchRevision: 2, activeToolCalls: 1, lastProgressAt: 1_000 };

  // An outstanding call reports liveness regardless of age, so age is bounded separately: a tool
  // that never returns must not hold a turn open forever, since turns carry no deadline by default.
  expect(chatGptExternalProgressSuppressesDomHealth(outstanding, 1_000)).toBeTrue();
  expect(chatGptExternalProgressSuppressesDomHealth(
    outstanding,
    1_000 + CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS - 1,
  )).toBeTrue();
  expect(chatGptExternalProgressSuppressesDomHealth(
    outstanding,
    1_000 + CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  )).toBeFalse();

  // A turn that keeps calling tools stays suppressed no matter how long it has been running, so
  // the bound is silence since the last activity rather than total turn duration.
  const hoursIn = 4 * 60 * 60_000;
  expect(chatGptExternalProgressSuppressesDomHealth(
    { ...outstanding, lastProgressAt: hoursIn },
    hoursIn + 1_000,
  )).toBeTrue();

  // No recorded activity is never evidence.
  expect(chatGptExternalProgressSuppressesDomHealth(undefined, 1_000)).toBeFalse();
  expect(chatGptExternalProgressSuppressesDomHealth(
    { revision: 0, lastToolBatchRevision: 0, activeToolCalls: 0 },
    1_000,
  )).toBeFalse();
});

test("the shipped commentary classifier separates answer Markdown from reasoning in a real DOM", () => {
  // The classifier runs inside page.evaluate, so it cannot be imported. Extract and execute the
  // exact shipped source instead of a copy, which is what lets this test detect a regression in
  // the code that actually runs rather than in a restatement of it.
  // domino ships without module typings; it is already present as a turndown dependency and is
  // the only DOM implementation available to this suite.
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => {
      body: { querySelectorAll: (selector: string) => ArrayLike<HTMLElement> };
    };
  };
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("// CHATGPT_COMMENTARY_CLASSIFIER_BEGIN")[1]?.split("// CHATGPT_COMMENTARY_CLASSIFIER_END")[0];
  if (!source) throw new Error("commentary classifier sentinels are missing from browser-worker.ts");
  const javascript = source
    .replace(/:\s*HTMLElement\[\]/g, "")
    .replace(/\):\s*\{[^}]*\}\s*=>/, ") =>");
  const selectChatGptAnswerRoots = new Function(
    `${javascript}; return selectChatGptAnswerRoots;`,
  )() as (roots: unknown[], statuses: unknown[]) => { answerRoots: Array<{ textContent: string }> };

  const answerFor = (html: string): string => {
    const document = createDocument(`<body>${html}</body>`);
    // domino's NodeList is array-like rather than iterable.
    const roots = Array.from(document.body.querySelectorAll(".markdown"))
      .filter(candidate => !candidate.parentElement?.closest(".markdown"));
    const statuses = Array.from(document.body.querySelectorAll("[data-streaming-response-status]"));
    return selectChatGptAnswerRoots(roots, statuses).answerRoots
      .map(root => (root.textContent ?? "").trim())
      .filter(Boolean)
      .join(" | ");
  };

  // Commentary that precedes the live status, and commentary nested inside one, stay excluded.
  expect(answerFor(
    '<div class="markdown">COMMENTARY</div>'
    + '<div data-streaming-response-status>live</div>'
    + '<div class="markdown">ANSWER</div>',
  )).toBe("ANSWER");
  expect(answerFor(
    '<div data-streaming-response-status><div class="markdown">NESTED</div></div>'
    + '<div class="markdown">ANSWER</div>',
  )).toBe("ANSWER");

  // Reasoning rendered inside a chain-of-thought component is commentary wherever it sits.
  expect(answerFor(
    '<div data-streaming-response-status>s1</div>'
    + '<div data-testid="cot-v5-block"><div class="markdown">THINKING</div></div>'
    + '<div class="markdown">ANSWER</div>',
  )).toBe("ANSWER");

  // The regressions this rule exists for: a second tool call opening a status container below
  // already-emitted answer text used to blank the visible text and drop answer chunks entirely.
  expect(answerFor(
    '<div data-streaming-response-status>s1</div>'
    + '<div class="markdown">ANSWER</div>'
    + '<div data-streaming-response-status>s2</div>',
  )).toBe("ANSWER");
  expect(answerFor(
    '<div data-streaming-response-status>s1</div>'
    + '<div class="markdown">PART ONE</div>'
    + '<div data-streaming-response-status>s2</div>'
    + '<div class="markdown">PART TWO</div>',
  )).toBe("PART ONE | PART TWO");

  // A turn with no status container at all is entirely answer.
  expect(answerFor('<div class="markdown">ONLY ANSWER</div>')).toBe("ONLY ANSWER");
});

test("active MCP calls veto completion while settled progress does not add a success delay", () => {
  const tracker = new ChatGptCompletionTracker(500);
  const finishedLooking = {
    responsePresent: true,
    running: false,
    currentText: "partial answer so far",
    currentHtml: "<p>partial answer so far</p>",
    completionActionVisible: true,
    projection: {
      rootId: "dom-progress",
      lastNodePresent: true,
      boundaryStart: "0",
      boundaryEnd: "21",
      lastMutationAt: 5_100,
      animations: [],
    },
  };

  // Between two tool calls the rendered message can look finished. Completing there returns a
  // truncated answer and retires the turn while its own tool calls are still in flight.
  expect(tracker.update({ ...finishedLooking, externalToolCallsInFlight: true }, 1_000).status).toBe("waiting");
  expect(tracker.update({ ...finishedLooking, externalToolCallsInFlight: true }, 5_000).status).toBe("waiting");

  // Once the model is genuinely idle the settle window starts fresh rather than completing at once.
  expect(tracker.update(finishedLooking, 5_100).status).toBe("waiting");
  expect(tracker.update(finishedLooking, 5_599).status).toBe("waiting");
  expect(tracker.update(finishedLooking, 5_600).status).toBe("complete");
});

test("a future progress timestamp is not treated as liveness", () => {
  const base = { revision: 2, lastToolBatchRevision: 2, activeToolCalls: 1 };

  // "now - lastProgressAt < ceiling" is satisfied by any future timestamp, which would have kept a
  // stuck tool call suppressing DOM health forever.
  expect(chatGptExternalProgressSuppressesDomHealth(
    { ...base, lastProgressAt: 10_000 + CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS * 10 },
    10_000,
  )).toBeFalse();

  // Modest skew between the recording daemon and the observing helper is still accepted.
  expect(chatGptExternalProgressSuppressesDomHealth(
    { ...base, lastProgressAt: 10_000 + CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS - 1 },
    10_000,
  )).toBeTrue();
});

test("the bundled helper is adopted only for the packaged runtime layout", () => {
  const processHelper = readFileSync("src/adapters/chatgpt-web/launcher-helper-process.ts", "utf8");

  // Any daemon launched some other way keeps the launcher-advertised helper rather than adopting
  // an unrelated sibling that merely shares a filename.
  expect(processHelper).toContain('basename(entrypoint) === "cli.js"');

  // Trace ids are derived deterministically and can repeat, so a run must not inherit revisions
  // recorded for an earlier turn that happened to share the id.
  const helper = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");
  const fence = readFileSync("src/adapters/chatgpt-web/browser-helper-fence.ts", "utf8");
  expect(helper).toContain("completionFences.start(message.id");
  expect(fence).toContain("new ChatGptMirroredTurnProgress");

  // A consumer callback must not be retried as though the page could not be read.
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const heartbeat = worker.indexOf("turn.onHeartbeat?.();");
  const tryStart = worker.indexOf("let observedThisIteration = false;");
  expect(heartbeat).toBeGreaterThan(0);
  expect(tryStart).toBeGreaterThan(0);
  expect(heartbeat).toBeLessThan(tryStart);
});

test("Bigger Context stage sends get a budget sized for their payload", () => {
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");

  // The send stage covers ChatGPT accepting the submission, not just the click. A stage posts a
  // payload orders of magnitude larger than an ordinary prompt onto a conversation that already
  // holds the earlier parts, and the ordinary budget expired mid-acceptance and killed the turn.
  expect(worker).toContain("multipartStageSend: 180_000");
  expect(worker).toContain("browserStageTimeouts.multipartStageSend,");

  // The multipart commit lands on a conversation already carrying every staged part.
  expect(worker).toContain("prepared.multipart ? browserStageTimeouts.multipartStageSend : browserStageTimeouts.send,");

  // The ordinary send budget is unchanged for ordinary prompts.
  expect(worker).toContain("send: 60_000,");
});

test("a staged Bigger Context part gets an acknowledgement window sized to its payload", () => {
  // A staged part is two orders of magnitude larger than an ordinary prompt and ChatGPT reads all of
  // it before answering. On this machine the same payload acknowledged at 19s and at 30s, and once
  // took over 72s — which the ordinary grace turned into "ChatGPT accepted the message but did not
  // expose its assistant turn in the DOM", losing an accepted turn that was merely slow.
  expect(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS).toBeGreaterThan(CHATGPT_RESPONSE_DOM_GRACE_MS);

  // No MCP activity exists yet while a part is being ingested, so nothing else can vouch for the
  // turn: this window is the only thing between a slow ingest and a cancellation. Keep a wide margin
  // over the slowest acknowledgement actually observed.
  const slowestObservedAcknowledgementMs = 72_000;
  expect(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS).toBeGreaterThan(slowestObservedAcknowledgementMs * 2);

  // It is the same budget the staged send already gets; the two bound the same oversized exchange.
  expect(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS).toBe(browserStageTimeouts.multipartStageSend);
});

test("the suspension clock charges only tick gaps that mean the process was frozen", () => {
  const clock = new ChatGptSuspensionClock(1_000, 5_000);
  clock.tick(1_000);
  clock.tick(2_000);
  clock.tick(3_100);
  expect(clock.suspendedMs()).toBe(0);

  // Fifteen minutes without a tick is a sleep; the ordinary interval is refunded from the charge.
  clock.tick(3_100 + 15 * 60_000);
  expect(clock.suspendedMs()).toBe(15 * 60_000 - 1_000);
});

test("remaining stage budget refunds slept time and stands once the awake budget is spent", () => {
  expect(remainingStageBudgetMs(120_000, 901_000, 890_000)).toBe(109_000);
  expect(remainingStageBudgetMs(120_000, 120_000, 0)).toBe(0);
  expect(remainingStageBudgetMs(120_000, 901_000, 0)).toBe(0);
  expect(remainingStageBudgetMs(200, 210, 50)).toBe(250);
});

test("a stage that spans a system sleep is not charged for the slept time", async () => {
  // The live failure: effort_selection ran 901s against a 120s budget because the Mac slept
  // 14 minutes of it, and the stage died on DarkWake. Here the fake clock reports a sleep longer
  // than the whole budget, so the first timer firing must re-arm instead of failing.
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://suspension-stage-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      ownerSignal?: AbortSignal,
      clock?: { suspendedMs(): number },
    ): Promise<T>;
  };

  let suspended = 0;
  const clock = { suspendedMs: () => suspended };
  const outcome: string[] = [];
  const stage = worker.runStage(
    "suspension-test",
    "probe",
    200,
    () => new Promise<never>(() => {}),
    undefined,
    clock,
  ).catch(error => { outcome.push((error as Error).message); });

  // The sleep is discovered when the first timer fires: 300ms slept against a 200ms budget.
  suspended = 300;
  await Bun.sleep(320);
  expect(outcome).toEqual([]);

  // No further sleep: the re-armed timer now expires on genuinely awake time.
  await stage;
  expect(outcome).toEqual(["ChatGPT browser stage timed out: probe"]);
}, 10_000);


test("two-part saved chats re-prove unchanged effort after the first message creates the conversation URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "saved-chat-multipart-"));
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const prepared = { ...compileChatGptWebPrompt({
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "low" },
    context: { systemPrompt: ["Keep literal paths."], messages: [
      { role: "user", content: "Read the first file.", timestamp: 1 },
      { role: "user", content: "Compare it with the second file.", timestamp: 2 },
    ] },
  }, capabilities, undefined, { experimentalMultipartParts: 2 }), release() {} };
  const worker: any = ChatGptBrowserWorker.forProvider({
    adapter: "chatgpt-web", baseUrl: `browser://${root}`,
    chatgptWeb: { useSavedChats: true, browserDiagnosticsPath: root },
  });
  let url = "https://chatgpt.com/";
  const savedUrl = "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001";
  const selections: string[] = [];
  const control = { innerText: async () => "Instant", getAttribute: async () => "false" };
  const controls: any = { filter: () => controls, count: async () => 1, first: () => control };
  const sendButton = { waitFor: async () => {}, isEnabled: async () => true,
    press: async () => { sends++; } };
  const composer = { locator: () => ({ locator: () => controls, getByTestId: () => sendButton }),
    isEditable: async () => true };
  const page = Object.assign(new EventEmitter(), {
    url: () => url, isClosed: () => false,
    evaluate: async () => { throw new Error("No real browser in the transport fixture"); },
    locator: () => ({ count: async () => sends, nth() { return this; }, last() { return this; },
      filter() { return this; }, isVisible: async () => false,
      evaluateAll: async () => ({ count: sends, identities: sends ? ["saved_stage"] : [], ambiguous: false }),
    }),
  });
  let sends = 0;
  const finished = new Error("final send reached with a current effort proof");
  Object.assign(worker, {
    prepareChatSurface: async (_page: unknown, _capture: unknown, saved: boolean) => { expect(saved).toBeTrue(); },
    activeComposer: async () => composer,
    selectModelAndEffort: async () => {
      selections.push(url);
      return { ...resolveChatGptWebMultipartStagingMode(CHATGPT_WEB_MODEL_ID, capabilities, 100, 100),
        selection: { url, label: "Instant" } };
    },
    assertPromptAttached: async () => {},
    waitForSubmissionAccepted: async () => { throw finished; },
    attachPrompt: async () => {}, attachPromptWithCompactionRetry: async () => {}, attachFiles: async () => {},
    waitForNewAssistantTurn: async () => ({}), waitForMultipartAcknowledgement: async () => {},
    sendAttachedPrompt: async (_page: unknown, _baseline: unknown, _initial: unknown, _capture: unknown,
      _signal: unknown, onSendActivated: () => Promise<void>) => {
      await onSendActivated();
      sends++;
      url = savedUrl;
      return "user_turn";
    },
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: "saved_multipart", modelId: CHATGPT_WEB_MODEL_ID, reasoning: "low", capabilities,
      prepare: async () => prepared, onTextDelta() {}, onReasoningSummary() {},
    }, undefined, page)).rejects.toBe(finished);
    expect(sends).toBe(2);
    expect(selections).toEqual(["https://chatgpt.com/", savedUrl]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("submission acceptance reports a rate-limit dialog that appears after Enter", async () => {
  const fixture = dialogPage("Too many requests. You're making requests too quickly.");
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(page: Page, baseline: unknown): Promise<unknown>;
  }).waitForSubmissionAccepted;

  await expect(waitForSubmissionAccepted.call(
    {},
    fixture.page,
    {},
  )).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: false,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});


test("prompt attachment reports a rate-limit modal before editing the composer", async () => {
  const fixture = dialogPage("Too many requests. You're making requests too quickly.");
  const attach = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  await expect(attach.call({ activeComposer: async () => { throw new Error("composer was touched"); } },
    fixture.page, "next context part", false)).rejects.toMatchObject({
    status: 429, code: "rate_limit_exceeded", retryable: false,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});


test("embedded chart hydration cannot replace Markdown answer content with renderer UI", () => {
  const { createDocument, createWindow } = require("@mixmark-io/domino") as {
    createDocument(html: string): { body: HTMLElement };
    createWindow(): { HTMLElement: unknown; Node: unknown };
  };
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("// CHATGPT_MARKDOWN_CONTENT_BEGIN")[1]?.split("// CHATGPT_MARKDOWN_CONTENT_END")[0];
  if (!source) throw new Error("Markdown content projection is missing from browser-worker.ts");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const window = createWindow();
  const { contentFor, textFor } = new Function("HTMLElement", "Node",
    `${javascript}; return { contentFor: chatGptMarkdownContent, textFor: markdownText };`,
  )(window.HTMLElement, window.Node) as {
    contentFor(root: HTMLElement): HTMLElement;
    textFor(root: HTMLElement): string;
  };
  const prose = '<p data-start="0" data-end="20">Keep 正在加载图表… literally.</p>';
  const code = '<pre data-start="22" data-end="80"><code class="language-vega-lite">{"mark":"line"}</code></pre>';
  const tail = '<ol start="3"><li><p>Actual answer</p></li></ol><span>Inline tail</span>';
  const expected = chatGptHtmlToMarkdown(prose + code + tail);
  // The chart wrapper, busy state, status row and preview pane are taken from real DEV DOM.
  // Exercise two locales and a terminal preview error without making text a widget selector.
  for (const label of ["Creating chart", "正在加载图表…", "Preview failed"]) {
    const before = createDocument(prose + code + '<button><span class="sr-only">Copy</span></button>'
      + '<span class="contents"><div aria-busy="true" class="chart-widget-container">'
      + `<section><div role="status">${label}</div></section></div></span>`
      + `<div data-start="82" data-end="150"><div data-code-block-preview-pane="vega-lite">${label}</div></div>`
      + tail).body;
    const original = before.innerHTML;
    const projected = contentFor(before);
    const after = createDocument(prose + code + '<button><span class="sr-only">Copied</span></button>'
      + '<span class="contents"><div class="chart-widget-container">'
      + '<button>Chart options</button><svg><text>0369Day 1Day 2</text></svg></div></span>'
      + '<div data-start="82" data-end="150"><div data-code-block-preview-pane="vega-lite"><iframe title="Preview"></iframe></div></div>'
      + tail).body;
    const hydrated = contentFor(after);
    expect(projected.innerHTML).toBe(hydrated.innerHTML);
    expect(projected.textContent).toBe(hydrated.textContent);
    expect(textFor(projected)).toBe(textFor(hydrated));
    expect(chatGptHtmlToMarkdown(projected.innerHTML)).toBe(expected);
    expect(before.innerHTML).toBe(original);
    expect(projected.querySelector("pre")?.getAttribute("data-start")).toBe("22");
  }
  const text = (html: string) => textFor(contentFor(createDocument(html).body));
  expect(text("<p>A<br>B</p>")).not.toBe(text("<p>AB</p>"));
  expect(text("<pre><code>one\n\ntwo</code></pre>"))
    .not.toBe(text("<pre><code>one\ntwo</code></pre>"));
  expect(text("<div>A</div><div>B</div>"))
    .toBe(text("<section><div>A</div><div>B</div></section>"));

  const files = createDocument('<p>Report: <span data-state="closed">'
    + '<button class="behavior-btn entity-underline" href="https://wrong.example/download" aria-label="Download">'
    + '<svg><text>File icon</text></svg>report.pdf<span hidden>Hidden</span></button></span> '
    + '<button class="entity-underline behavior-btn">report.pdf</button>'
    + '<button>Copy</button><button class="entity-underline">Retry</button>'
    + '<button class="behavior-btn entity-underline" hidden>hidden.pdf</button>'
    + '<span aria-hidden="true"><button class="behavior-btn entity-underline">also-hidden.pdf</button></span></p>').body;
  const originalFiles = files.innerHTML;
  const projectedFiles = contentFor(files);
  expect(chatGptHtmlToMarkdown(projectedFiles.innerHTML)).toBe("Report: report.pdf report.pdf");
  expect(textFor(projectedFiles)).toBe("Report: report.pdf report.pdf");
  expect(projectedFiles.querySelectorAll("button, a, svg").length).toBe(0);
  expect(files.innerHTML).toBe(originalFiles);
});
