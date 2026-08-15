import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "./markdown";
import {
  ChatGptMarkdownOwnershipTracker,
  type ChatGptMarkdownRootSnapshot,
} from "./markdown-ownership";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import { CHATGPT_MAX_INPUT_IMAGES, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import { ChatGptVisibleTraceTracker, type ChatGptVisibleTraceBlock } from "./visible-trace-tracker";
import { ChatGptCompletionTracker, type ChatGptFinalProjectionState } from "./completion-tracker";
import type { ChatGptRetryPrompt } from "./steering";
import { ChatGptTurnLatencyDiagnostics } from "./turn-latency";
import {
  chatGptAssistantTurnChanged,
  chatGptSubmissionEvidence,
  readChatGptAssistantTurnState,
  type ChatGptAssistantTurnState,
  type ChatGptSubmissionEvidence,
} from "./response-turn-boundary";
export { ChatGptVisibleTraceTracker } from "./visible-trace-tracker";
export { ChatGptMarkdownOwnershipTracker } from "./markdown-ownership";
export type { ChatGptVisibleTraceBlock, ChatGptVisibleTraceEvent } from "./visible-trace-tracker";
export { chatGptSubmissionEvidence } from "./response-turn-boundary";
export type { ChatGptSubmissionEvidence } from "./response-turn-boundary";
export {
  CHATGPT_COMPLETION_PROJECTION_STALL_MS,
  CHATGPT_COMPLETION_SETTLE_MS,
  ChatGptCompletionTracker,
  blockingChatGptProjectionAnimations,
  chatGptTurnIsComplete,
} from "./completion-tracker";
export type {
  ChatGptCompletionDecision,
  ChatGptCompletionState,
  ChatGptFinalProjectionState,
  ChatGptProjectionAnimation,
  ChatGptProjectionStallDiagnostic,
} from "./completion-tracker";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptEffortSliderAdvancedTowardTarget,
  detectChatGptAccountCapabilities,
  isTemporaryChatGptUrl,
  parseChatGptEffortSliderState,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS, ORIGINAL_CHATGPT_BROWSER_TABS, runWithChatGptBrowserSlot } from "./concurrency";
import { ChatGptWebAdapterError, chatGptWebSurfaceError } from "./adapter-error";
import { ChatGptAnswerBuffer } from "./browser-answer-buffer";
import { ChatGptBrowserDiagnostics, redactChatGptUiDiagnostic } from "./browser-diagnostics";
import { reanchorChatGptComposerCaret } from "./prompt-caret";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
export {
  browserDiagnosticCheckpoint,
  browserDiagnosticIncludesScreenshot,
  redactChatGptUiDiagnostic,
} from "./browser-diagnostics";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly visibleRows: string[],
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|太多要求/i })
  .filter({ hasText: /making requests too quickly|要求過於頻繁/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const dialog = chatGptRateLimitDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return;

  const acknowledge = dialog.getByRole("button", { name: /^(?:Got it|知道了)$/i }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate-limit dialog is open, but its acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
      );
    }
  }
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
  );
}

type ChatGptTextScope = Pick<Locator, "getByText">;

const chatGptSessionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (!await chatGptSessionFailureAlert(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

export async function throwIfChatGptTerminalErrorAlert(
  scope: ChatGptTextScope,
  completedAnswerVisible = false,
): Promise<void> {
  if (completedAnswerVisible) return;
  const alert = chatGptTerminalErrorAlert(scope);
  if (!await alert.isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

export function chatGptTerminalErrorRetryPrompt(
  error: Error,
  attempt: number,
  emittedText: string,
): string | undefined {
  if (attempt !== 1
    || emittedText.length > 0
    || !(error instanceof ChatGptWebAdapterError)
    || error.code !== "upstream_server_error") return undefined;
  return "Continue the current response from the completed Codex Native2 tool results above. Do not repeat completed tool calls. Complete only the remaining work, then return the requested answer.";
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  await onVisible?.();

  if (autoApprove) {
    const allowOnce = dialog.getByRole("button", { name: "Allow once", exact: true }).last();
    await allowOnce.waitFor({ state: "visible", timeout: 10_000 });
    await allowOnce.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!await dialog.isVisible().catch(() => false)) return true;
  const deny = dialog.getByRole("button", { name: "Deny", exact: true }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 60_000,
} as const;

/**
 * A six-figure Input.insertText can make current ChatGPT Lexical surfaces rewrite text inside the
 * first edit even when its final UTF-16 length is unchanged. Bound only the native edit operation;
 * the resulting user message remains one exact prompt, and every prefix is still verified before
 * another irreversible edit. This is independent of model context and compaction limits.
 */
export const CHATGPT_PROMPT_INSERT_CHUNK_CHARS = 16_000;
export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function promptInsertChunkEnd(text: string, offset: number): number {
  let end = Math.min(offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS, text.length);
  if (end >= text.length) return end;
  const previousCodeUnit = text.charCodeAt(end - 1);
  const nextCodeUnit = text.charCodeAt(end);
  if (previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
    end -= 1;
  }
  return end;
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  retainConversation?: boolean;
  /** Fail closed unless launcher reused the matching retained conversation. */
  requireRetainedConversation?: boolean;
  conversationKey?: string;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Semantic DOM progress used only to reset the upstream silence timer. */
  onProgress?: () => void;
  /** The current prompt is visible to ChatGPT and must never be replayed on another surface. */
  onSubmitted?: () => void;
  /** Release the unselected full/resume transport after the launcher resolves the retained lease. */
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
  /** Return a corrective follow-up prompt to retry the final answer in the same chat. */
  retryPromptForAnswer?: (answer: string, attempt: number) => string | ChatGptRetryPrompt | undefined | Promise<string | ChatGptRetryPrompt | undefined>;
  /** Return a corrective follow-up prompt after a recoverable response-reading failure. */
  retryPromptForError?: (error: Error, attempt: number) => string | undefined | Promise<string | undefined>;
}

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
  maxBrowserTabs?: number;
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
  }, now = Date.now()): string | undefined {
    if (state.responsePresent) {
      this.sawResponse = true;
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  plainTextFallback: string;
  markdownSegments: ChatGptMarkdownSegment[];
  markdownRoots: ChatGptMarkdownRootSnapshot[];
  completionActionVisible: boolean;
  projection: ChatGptFinalProjectionState;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  plainTextFallback: "",
  markdownSegments: [],
  markdownRoots: [],
  completionActionVisible: false,
  projection: { lastNodePresent: false, animations: [] },
  traceBlocks: [],
});

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
    maxBrowserTabs: configured.useEnhancedWebSessionMode === true
      ? MAX_CHATGPT_BROWSER_TABS
      : ORIGINAL_CHATGPT_BROWSER_TABS,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  return chatGptImageFilePayloads(prompt.images);
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const run = runWithChatGptBrowserSlot(turn.abortSignal, () => (
      useHelper ? this.launcherHelper!.run(turn) : this.runWithSurfaceRetry(turn)
    ), this.config.maxBrowserTabs ?? MAX_CHATGPT_BROWSER_TABS);
    this.activeRuns.set(turn.traceId, run);
    void run.finally(() => {
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  private async runWithSurfaceRetry(turn: BrowserTurn): Promise<string> {
    let submitted = false;
    const submittedTurn: BrowserTurn = {
      ...turn,
      onSubmitted: () => {
        submitted = true;
        turn.onSubmitted?.();
      },
    };
    try {
      return await this.runExclusive(submittedTurn);
    } catch (error) {
      const adapterOwnsRecovery = resolveChatGptWebModelMode(
        turn.modelId,
        turn.reasoning,
        turn.capabilities,
      ).localTools;
      if (!(error instanceof ChatGptWebAdapterError)
        || (error.code !== "chatgpt_surface_changed" && error.code !== "chatgpt_connector_unavailable")
        || !error.retryable
        || (adapterOwnsRecovery && error.code !== "chatgpt_connector_unavailable")
        || submitted
        || turn.abortSignal?.aborted) throw error;
      console.warn(`[chatgpt-web] browser turn ${turn.traceId} retrying once on a fresh surface`);
      return this.runExclusive(submittedTurn);
    }
  }

  verifyConnector(): Promise<string> {
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive());
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    const startedAt = performance.now();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onOwnerAbort: (() => void) | undefined;
    try {
      if (ownerSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
          controller.abort();
        }, timeoutMs);
      });
      const ownerAbort = ownerSignal
        ? new Promise<never>((_, rejectAbort) => {
            onOwnerAbort = () => {
              rejectAbort(new DOMException("ChatGPT web turn aborted", "AbortError"));
              controller.abort();
            };
            ownerSignal.addEventListener("abort", onOwnerAbort, { once: true });
          })
        : undefined;
      const value = await Promise.race([action(controller.signal), timeout, ...(ownerAbort ? [ownerAbort] : [])]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (ownerSignal && onOwnerAbort) ownerSignal.removeEventListener("abort", onOwnerAbort);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
        throw new Error(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      await captureDiagnostic?.("luna-default-confirmed");
      return mode;
    }
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
    try {
      await currentEffort.waitFor({ state: "visible", timeout: 70_000 });
    } catch {
      throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    const effortMenu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
    const menuVisible = await effortMenu.isVisible().catch(() => false);
    const menuExpanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
    if (!menuVisible && menuExpanded !== "true") {
      await throwIfChatGptRateLimitDialog(page);
      await currentEffort.press("Enter");
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortChoices = effortMenu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const effortChoice = effortChoices.nth(uiEffortIndex);
    const effortSlider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).last();
    const waitAbort = new AbortController();
    let ready: "effort" | "slider" | "rate-limit";
    try {
      ready = await Promise.race([
        effortChoice.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "effort" as const),
        effortSlider.waitFor({ state: "attached", timeout: 70_000, signal: waitAbort.signal }).then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      await captureDiagnostic?.(ready === "slider" ? "effort-slider-visible" : "effort-choice-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      const effortChoiceCount = await effortChoices.count().catch(() => 0);
      throw new ChatGptWebAdapterError(
        `ChatGPT effort menu did not expose item index ${uiEffortIndex}`
        + `; item count: ${effortChoiceCount}`,
        {
          status: 502,
          errorType: "server_error",
          code: "upstream_server_error",
          retryable: effortChoiceCount === 0,
        },
      );
    } finally {
      waitAbort.abort();
    }
    if (ready === "slider") {
      let sliderState = parseChatGptEffortSliderState(
        await effortSlider.getAttribute("aria-valuemin"),
        await effortSlider.getAttribute("aria-valuemax"),
        await effortSlider.getAttribute("aria-valuenow"),
      );
      if (!sliderState) {
        throw new ChatGptWebAdapterError(
          "ChatGPT effort slider exposed an invalid ARIA range",
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const targetValue = sliderState.min + uiEffortIndex;
      if (targetValue > sliderState.max) {
        throw new ChatGptWebAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex}`
          + ` (min=${sliderState.min}; max=${sliderState.max})`,
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
      while (sliderState.value !== targetValue) {
        await throwIfChatGptRateLimitDialog(page);
        const direction = targetValue > sliderState.value ? 1 : -1;
        const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
        const previousValue = sliderState.value;
        await sliderControl.press(key);
        const changeDeadline = Date.now() + 5_000;
        do {
          sliderState = parseChatGptEffortSliderState(
            await effortSlider.getAttribute("aria-valuemin"),
            await effortSlider.getAttribute("aria-valuemax"),
            await effortSlider.getAttribute("aria-valuenow"),
          );
          if (!sliderState) throw new Error("ChatGPT effort slider lost its semantic ARIA state");
          if (sliderState.value !== previousValue) break;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
        } while (Date.now() < changeDeadline);
        if (!chatGptEffortSliderAdvancedTowardTarget(previousValue, sliderState.value, targetValue)) {
          throw new Error(
            `ChatGPT effort slider did not advance toward the target with ${key}`
            + ` (before=${previousValue}; after=${sliderState.value}; target=${targetValue})`,
          );
        }
      }
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    const selected = await effortChoice.getAttribute("aria-checked");
    if (selected !== "true" && selected !== "false") {
      throw new Error(`ChatGPT effort item index ${uiEffortIndex} has no semantic checked state`);
    }
    if (selected === "true") {
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    await throwIfChatGptRateLimitDialog(page);
    await effortChoice.press("Enter");
    await captureDiagnostic?.("effort-choice-activated");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      if (!await effortMenu.isVisible().catch(() => false)) {
        const expanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
        if (expanded !== "true") {
          await throwIfChatGptRateLimitDialog(page);
          await currentEffort.press("Enter");
        }
        await effortChoice.waitFor({
          state: "visible",
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
      }
      confirmed = await effortChoice.getAttribute("aria-checked");
      if (confirmed === "true") {
        await captureDiagnostic?.("effort-selected");
        await page.keyboard.press("Escape");
        return mode;
      }
      if (confirmed !== "false") {
        throw new Error(`ChatGPT effort item index ${uiEffortIndex} lost its semantic checked state`);
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(
      `ChatGPT did not confirm effort item index ${uiEffortIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed)})`,
    );
  }

  private async activeComposer(page: Page, timeoutMs = 30_000): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      count = await composers.count();
      if (count === 1) return composers.first();
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throw new Error(`ChatGPT did not expose exactly one visible composer (visibleComposers=${count})`);
  }

  /** Put every browser operation on one fully hydrated Temporary Chat document. */
  private async prepareTemporaryChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.("temporary-chat-navigation-complete");
    }
    let composer: Locator;
    try {
      composer = await this.activeComposer(page);
    } catch {
      throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    await captureDiagnostic?.("session-verified");
    return composer;
  }

  private async waitForSubmissionAccepted(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    responseTurn: Locator,
    initialUserTurnCount: number,
    initialResponseTurn: ChatGptAssistantTurnState,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const visibleStopButtons = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true });
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn);
      const [userTurnCount, assistantTurn, visibleStopButtonCount] = await Promise.all([
        userTurns.count(),
        readChatGptAssistantTurnState(responseTurns),
        visibleStopButtons.count(),
      ]);
      const evidence = chatGptSubmissionEvidence({
        initialUserTurnCount,
        userTurnCount,
        initialAssistantTurnCount: initialResponseTurn.count,
        assistantTurnCount: assistantTurn.count,
        ...(initialResponseTurn.lastId ? { initialAssistantTurnId: initialResponseTurn.lastId } : {}),
        ...(assistantTurn.lastId ? { assistantTurnId: assistantTurn.lastId } : {}),
        generationRunning: visibleStopButtonCount > 0,
      });
      if (evidence) return evidence;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  }

  private async attachedPromptText(page: Page): Promise<string> {
    const composer = await this.activeComposer(page);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
      )
        .forEach(part => part.remove());
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 20_000 });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page);
      throwIfPromptAttachmentAborted(abortSignal);
      if (observed === prompt) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throwIfPromptAttachmentAborted(abortSignal);
    let commonPrefix = 0;
    while (commonPrefix < prompt.length && prompt[commonPrefix] === observed[commonPrefix]) commonPrefix += 1;
    throw new Error(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator("xpath=ancestor::form[1]")
      .locator('[data-id^="plugin:"][data-keyword]')
      .filter({ hasText: this.config.appName, visible: true });
  }

  private async connectorIsSelected(composer: Locator): Promise<boolean> {
    const selected = this.selectedConnectorControl(composer);
    const keywords = await selected.evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-keyword"))
    ));
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private async connectorMentionRowTitles(menuRows: Locator): Promise<string[]> {
    const texts = await menuRows.filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(menuRows: Locator, triggerAttempts: number): Promise<string> {
    const titles = await this.connectorMentionRowTitles(menuRows);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + "; create a connector with that exact name before retrying";
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
  ): Promise<Locator> {
    let composer = await this.activeComposer(page);
    await composer.fill("");
    if (await this.connectorIsSelected(composer)) {
      await captureDiagnostic?.("connector-already-selected");
      return composer;
    }

    const menuRows = page.locator('.__menu-item[tabindex="0"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const menuDeadline = Date.now() + 20_000;
    let triggerAttempts = 0;
    let firstMenuCaptured = false;
    for (;;) {
      triggerAttempts += 1;
      composer = await this.activeComposer(page);
      await composer.fill("");
      await composer.focus();
      await composer.press("Escape");
      await settleChatGptUi();
      await composer.pressSequentially("@c", { delay: 25 });
      if (!firstMenuCaptured) {
        firstMenuCaptured = true;
        await captureDiagnostic?.("connector-mention-triggered");
      }
      try {
        await appResult.waitFor({
          state: "visible",
          timeout: Math.min(2_500, Math.max(1, menuDeadline - Date.now())),
        });
        await captureDiagnostic?.("connector-menu-visible");
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        if (Date.now() >= menuDeadline) {
          const visibleRows = await this.connectorMentionRowTitles(menuRows);
          if (catalogRefreshAvailable && visibleRows.length > 0) {
            const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => visibleRows.includes(name));
            if (!legacyName && !visibleRows.includes(this.config.appName)) {
              throw new ChatGptConnectorCatalogStaleError(
                this.config.appName,
                visibleRows,
                triggerAttempts,
              );
            }
          }
          await captureDiagnostic?.("connector-menu-missing");
          throw new Error(await this.connectorMentionFailure(menuRows, triggerAttempts));
        }
      }
    }
    if (await appResult.count() !== 1) {
      throw new Error(
        `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
        + `; visible rows: ${(await this.connectorMentionRowTitles(menuRows)).map(title => JSON.stringify(title)).join(", ")}`,
      );
    }
    // The popup's keyboard highlight belongs to the whole attachment menu, not to the exact row
    // resolved above. Composer-level ArrowDown/Enter can therefore select "Add photos & files" or
    // another sibling group. Activate only the uniquely resolved connector row and then require the
    // exact selected-connector marker as evidence before continuing.
    // Use Playwright's real pointer activation. A DOM `dispatchEvent("click")` only fires an
    // untrusted synthetic event; ChatGPT can update the visible badge while never committing the
    // connector to the turn that is sent. Force the click only to bypass the popup's transient
    // layout movement — the event itself remains a trusted browser input event.
    await appResult.click({ force: true, timeout: 10_000 });
    // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
    // again instead of returning the pre-selection locator, otherwise the real turn can focus a
    // detached/hidden editor even though verification just succeeded.
    const selectedComposer = await this.activeComposer(page);
    const selectedConnector = this.selectedConnectorControl(selectedComposer);
    await selectedConnector.waitFor({ state: "visible", timeout: 10_000 });
    if (!await this.connectorIsSelected(selectedComposer)) {
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
    }
    await captureDiagnostic?.("connector-selected");
    return selectedComposer;
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    reuseConnector = false,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    if (!localTools || reuseConnector) {
      const composer = await this.activeComposer(page);
      // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
      // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
      // then transport the complete text through verified CDP edits.
      await composer.fill("");
      await composer.focus();
      await this.insertPromptText(page, prompt, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
      return;
    }
    const selectedComposer = await this.selectConnector(
      page,
      captureDiagnostic,
      catalogRefreshAvailable,
    );
    await selectedComposer.focus();
    await page.keyboard.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY);
    await this.insertPromptText(page, ` ${prompt}`, abortSignal);
    await this.assertPromptAttached(page, prompt, abortSignal);
  }

  private async reanchorPromptCaret(page: Page, abortSignal?: AbortSignal): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = await this.activeComposer(page);
    let anchored = false;
    try {
      anchored = await reanchorChatGptComposerCaret(composer);
    } catch (error) {
      throwIfPromptAttachmentAborted(abortSignal);
      const detail = error instanceof Error ? error.message : String(error);
      throw chatGptWebSurfaceError(`ChatGPT composer caret re-anchor failed: ${detail}`, false);
    }
    throwIfPromptAttachmentAborted(abortSignal);
    if (!anchored) {
      throw chatGptWebSurfaceError(
        "ChatGPT composer could not re-anchor the prompt caret at the logical document end",
        false,
      );
    }
  }

  private async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < text.length;) {
      throwIfPromptAttachmentAborted(abortSignal);
      const end = promptInsertChunkEnd(text, offset);
      await page.keyboard.insertText(text.slice(offset, end));
      throwIfPromptAttachmentAborted(abortSignal);
      if (end < text.length) {
        // Lexical can rebuild the active block after an exact commit and move its native selection.
        // Re-anchor only after the verified prefix is stable, before the next irreversible edit.
        const expectedPrefix = text.slice(0, end).trimStart();
        await this.waitForPromptChunkAttached(page, expectedPrefix, abortSignal);
        await this.reanchorPromptCaret(page, abortSignal);
      }
      offset = end;
    }
  }

  private async waitForPromptChunkAttached(
    page: Page,
    expected: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    let observed = "";
    do {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page);
      throwIfPromptAttachmentAborted(abortSignal);
      if (observed === expected) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    } while (Date.now() < deadline);
    throwIfPromptAttachmentAborted(abortSignal);
    let commonPrefix = 0;
    while (commonPrefix < expected.length && expected[commonPrefix] === observed[commonPrefix]) commonPrefix += 1;
    throw new Error(
      `ChatGPT composer did not commit a complete prompt insertion chunk`
      + ` (expectedChars=${expected.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private async verifyConnectorExclusive(): Promise<string> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    try {
      await this.selectConnector(page, undefined, true);
    } catch (error) {
      if (!(error instanceof ChatGptConnectorCatalogStaleError)) throw error;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.prepareTemporaryChatSurface(page);
      await this.selectConnector(page);
    }
    return this.config.appName;
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .waitFor({ state: "visible", timeout: 60_000 })
      )));
    } catch {
      const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
        .map(text => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments`
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    }
    const send = composerForm.getByTestId("send-button");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    ownership?: ChatGptMarkdownOwnershipTracker,
    running = false,
  ): Promise<ChatGptResponseDomSnapshot> {
    const snapshot = await responseTurn.evaluate((element, completionActionSelector) => {
      const root = element as HTMLElement;
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        return candidate.isConnected
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };

      // ChatGPT uses the same Markdown renderer for intermediate commentary and for the final
      // answer. The stable semantic boundary is the public streaming-status container: Markdown
      // inside it is commentary; top-level Markdown outside it is the final answer stream.
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(renderedInDom);
      const commentaryRoots = allMarkdownRoots.filter(candidate => (
        candidate.closest("[data-streaming-response-status]") !== null
      ));
      const renderedRoots = allMarkdownRoots.filter(candidate => (
        candidate.closest("[data-streaming-response-status]") === null
      ));
      const runtimeWindow = window as typeof window & {
        __codexMarkdownRootIds?: WeakMap<HTMLElement, string>;
        __codexMarkdownRootSequence?: number;
        __codexFinalProjectionStates?: WeakMap<HTMLElement, {
          lastMutationAt: number;
          observer: MutationObserver;
        }>;
      };
      runtimeWindow.__codexMarkdownRootIds ??= new WeakMap<HTMLElement, string>();
      runtimeWindow.__codexMarkdownRootSequence ??= 0;
      runtimeWindow.__codexFinalProjectionStates ??= new WeakMap();
      const nodeId = (markdownRoot: HTMLElement): string => {
        const existing = runtimeWindow.__codexMarkdownRootIds!.get(markdownRoot);
        if (existing) return existing;
        const created = `dom-${runtimeWindow.__codexMarkdownRootSequence!++}`;
        runtimeWindow.__codexMarkdownRootIds!.set(markdownRoot, created);
        return created;
      };
      const segmentsFor = (markdownRoot: HTMLElement, rootIsComplete: boolean) => {
        const hasDirectText = [...markdownRoot.childNodes].some(node => (
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
        ));
        const children = [...markdownRoot.children] as HTMLElement[];
        if (hasDirectText || children.length === 0) {
          return markdownRoot.innerHTML.trim() ? [{
            key: "root",
            html: markdownRoot.innerHTML,
            text: markdownRoot.innerText.trim(),
            streamable: rootIsComplete,
          }] : [];
        }

        return children.flatMap((child, childIndex) => {
          const tag = child.tagName.toLowerCase();
          const childIsComplete = rootIsComplete || childIndex < children.length - 1;
          const listItems = tag === "ol" || tag === "ul"
            ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
            : [];
          if (listItems.length === 0) {
            return [{
              key: `${childIndex}:${tag}`,
              html: child.outerHTML,
              text: child.innerText.trim(),
              streamable: childIsComplete,
            }];
          }

          const group = `${childIndex}:${tag}`;
          const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
          return listItems.map((item, itemIndex) => {
            const shell = child.cloneNode(false) as HTMLElement;
            shell.removeAttribute("data-is-last-node");
            if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
              shell.setAttribute("start", String(orderedStart + itemIndex));
            }
            shell.append(item.cloneNode(true));
            return {
              key: `${childIndex}:${tag}:${itemIndex}`,
              html: shell.outerHTML,
              text: item.innerText.trim(),
              group,
              streamable: childIsComplete || itemIndex < listItems.length - 1,
            };
          });
        });
      };
      const markdownRoots = allMarkdownRoots.map(markdownRoot => {
        const renderedIndex = renderedRoots.indexOf(markdownRoot);
        const rootIsComplete = renderedIndex >= 0 && renderedIndex < renderedRoots.length - 1;
        return {
          nodeId: nodeId(markdownRoot),
          ownership: commentaryRoots.includes(markdownRoot) ? "commentary" as const : "final" as const,
          toolEpoch: root.querySelectorAll("[data-item-anchor]").length,
          text: markdownRoot.innerText.trim(),
          html: markdownRoot.innerHTML,
          segments: segmentsFor(markdownRoot, rootIsComplete),
        };
      });
      const markdownSegments = markdownRoots
        .filter(markdownRoot => markdownRoot.ownership === "final")
        .flatMap(markdownRoot => markdownRoot.segments);
      const rendered = renderedRoots.at(-1);
      const projection = rendered ? (() => {
        let state = runtimeWindow.__codexFinalProjectionStates!.get(rendered);
        if (!state) {
          const created = {
            lastMutationAt: Date.now(),
            observer: undefined as unknown as MutationObserver,
          };
          created.observer = new MutationObserver(() => { created.lastMutationAt = Date.now(); });
          created.observer.observe(rendered, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["data-start", "data-end", "data-is-last-node"],
          });
          runtimeWindow.__codexFinalProjectionStates!.set(rendered, created);
          state = created;
        }
        const lastNodes = [
          ...(rendered.matches("[data-is-last-node]") ? [rendered] : []),
          ...rendered.querySelectorAll<HTMLElement>("[data-is-last-node]"),
        ];
        const lastNode = lastNodes.at(-1);
        const animations = typeof rendered.getAnimations === "function"
          ? rendered.getAnimations({ subtree: true }).map(animation => {
            const timing = animation.effect?.getTiming();
            const computed = animation.effect?.getComputedTiming();
            const rawEndTime = computed?.endTime;
            const endTime = typeof rawEndTime === "number" && Number.isFinite(rawEndTime)
              ? rawEndTime
              : null;
            return {
              playState: animation.playState,
              currentTime: typeof animation.currentTime === "number" && Number.isFinite(animation.currentTime)
                ? animation.currentTime
                : null,
              endTime,
              infinite: timing?.iterations === Infinity || rawEndTime === Infinity,
            };
          })
          : [];
        return {
          rootId: nodeId(rendered),
          lastNodePresent: lastNode !== undefined,
          boundaryStart: lastNode?.getAttribute("data-start") ?? undefined,
          boundaryEnd: lastNode?.getAttribute("data-end") ?? undefined,
          lastMutationAt: state.lastMutationAt,
          animations,
        };
      })() : { lastNodePresent: false, animations: [] };
      const completionActions = [...root.querySelectorAll<HTMLElement>(completionActionSelector)]
        .filter(renderedInDom);
      const completionAction = rendered
        ? completionActions.find(candidate => !rendered.contains(candidate)
          && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : completionActions.at(-1);
      const plainTextFallback = renderedRoots.length === 0 && completionAction ? (() => {
        const blocks = new Set(["ADDRESS", "ARTICLE", "BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "P", "PRE", "TR"]);
        const collect = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          if (!(node instanceof HTMLElement)
            || node.matches('button, script, style, [aria-hidden="true"], [data-streaming-response-status]')) return "";
          const text = [...node.childNodes].map(collect).join("");
          return blocks.has(node.tagName) ? `${text}\n` : text;
        };
        return collect(root)
          .split("\n")
          .map(line => line.replace(/[\t ]+/g, " ").trim())
          .filter(Boolean)
          .join("\n")
          .trim();
      })() : "";
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      renderedRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        return candidate.closest<HTMLElement>("button") ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => renderedInDom(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null,
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...(block.kind === "commentary" ? { complete: index < blocks.length - 1 } : {}),
      }));
      return {
        responsePresent: true,
        visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n") || plainTextFallback,
        fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join("") || plainTextFallback,
        plainTextFallback,
        markdownSegments,
        markdownRoots,
        completionActionVisible: completionAction !== undefined,
        projection,
        traceBlocks,
      };
    }, CHATGPT_COMPLETION_ACTION_SELECTOR, { timeout: 2_000 }).catch(() => {
      if (responseTurn.page().isClosed()) {
        throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
      }
      return absentResponseDomSnapshot();
    });
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
    if (ownership) {
      snapshot.markdownRoots = snapshot.markdownRoots.map(root => (
        running && root.ownership === "final" ? { ...root, ownership: "provisional" } : root
      ));
      const owned = ownership.observe(snapshot.markdownRoots);
      snapshot.markdownSegments = owned.markdownSegments;
      snapshot.visibleText = owned.finalText || (owned.commentaryBlocks.length > 0 ? "" : snapshot.plainTextFallback);
      snapshot.fullHtml = owned.finalHtml || snapshot.visibleText;
      if (owned.commentaryBlocks.length > 0) snapshot.plainTextFallback = "";
      snapshot.traceBlocks = [
        ...snapshot.traceBlocks.filter(block => block.kind !== "commentary"),
        ...owned.commentaryBlocks,
      ];
    }
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          }));
        return {
          textChars: (root.innerText ?? root.textContent ?? "").trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (this.config.browserHost !== "launcher") return this.runBrowserTurn(turn);
    const localTools = resolveChatGptWebModelMode(
      turn.modelId,
      turn.reasoning,
      turn.capabilities,
    ).localTools;

    const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
      ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
      ...(localTools ? { connectorIdentity: this.config.appName } : {}),
      ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    });
    const surfaceId = lease.surfaceId;
    if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };
    try {
      if (turn.requireRetainedConversation && lease.reused !== true) {
        throw new Error("The retained ChatGPT conversation is no longer available");
      }
      const reuseConversation = lease.reused === true && (!localTools || lease.connectorBound === true);
      await turn.onPreparedSelected?.(reuseConversation && turn.prepareResume !== undefined);
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      return await this.runBrowserTurn(
        turn,
        surfaceId,
        undefined,
        reuseConversation,
      );
    } catch (error) {
      originalError = error;
      terminal = error instanceof DOMException && error.name === "AbortError" ? "aborted" : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminal === "completed" && turn.retainConversation ? { retain: true } : {}),
          ...(terminal === "completed" && localTools ? { connectorBound: true } : {}),
          ...(terminalMessage ? { message: terminalMessage } : {}),
        });
      } catch (controlError) {
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  }

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation = false,
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, turn.capabilities);
    const prepared = reuseConversation && turn.prepareResume
      ? await turn.prepareResume()
      : await turn.prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(turn.traceId);
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(
        prepared.modelInputText ? { ...prepared, text: prepared.modelInputText } : prepared,
        turn.modelId,
      );
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      assertChatGptWebInputWithinLimits(
        estimatedInputTokens,
        estimatedMessageTokens,
        turn.modelId,
        requestedMode.effort,
        turn.capabilities,
        prepared.text.length,
      );
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      const page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (maintenancePage) return maintenancePage;
        if (!launcherSurfaceId) {
          const managed = await this.pageForNewTurn();
          if (abortSignal.aborted) {
            await managed.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          return managed;
        }
        const connection = await connectLauncherBrowserHost(
          this.config.browserHostDescriptorPath!,
          browserStageTimeouts.browserPage,
          launcherSurfaceId,
          abortSignal,
        );
        if (abortSignal.aborted) {
          await connection.browser.close().catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        return connection.page;
      });
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      await diagnostics.capture(page, "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${prepared.transport ?? "inline"},`
        + ` inlineChars=${prepared.inlineChars ?? prepared.text.length}, archiveChars=${prepared.archiveChars ?? 0},`
        + ` archiveSha256=${prepared.archiveSha256 ?? "none"},`
        + ` estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length},`
        + ` compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () => this.prepareTemporaryChatSurface(
            page,
            checkpoint => diagnostics.capture(page, checkpoint),
          ),
        );
      }
      let mode = reuseConversation
        ? requestedMode
        : await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
          this.selectModelAndEffort(
            page,
            turn.modelId,
            turn.reasoning,
            turn.capabilities,
            checkpoint => diagnostics.capture(page, checkpoint),
          )
        ));
      let catalogRefreshAvailable = !reuseConversation && mode.localTools;
      await diagnostics.capture(page, "effort-selection-complete");
      let finalText = "";
      const answerBuffer = new ChatGptAnswerBuffer();
      let responsePrompt = prepared.text;
      let retrySubmitted: (() => void) | undefined;
      for (let responseAttempt = 1; ; responseAttempt += 1) {
        try {
        for (;;) {
          try {
            await this.runStage(
              turn.traceId,
              "prompt_attachment",
              browserStageTimeouts.promptAttachment,
              stageSignal => this.attachPrompt(
                page,
                responsePrompt,
                mode.localTools,
                checkpoint => diagnostics.capture(page, checkpoint),
                reuseConversation || responseAttempt > 1,
                stageSignal,
                catalogRefreshAvailable,
              ),
              turn.abortSignal,
            );
            break;
          } catch (error) {
            if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
            catalogRefreshAvailable = false;
            await diagnostics.capture(page, "connector-catalog-stale");
            await this.runStage(
              turn.traceId,
              "connector_catalog_refresh",
              browserStageTimeouts.temporaryChatPreparation,
              async () => {
                await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
                await this.prepareTemporaryChatSurface(
                  page,
                  checkpoint => diagnostics.capture(page, checkpoint),
                );
              },
              turn.abortSignal,
            );
            mode = await this.runStage(
              turn.traceId,
              "effort_selection",
              browserStageTimeouts.effortSelection,
              () => this.selectModelAndEffort(
                page,
                turn.modelId,
                turn.reasoning,
                turn.capabilities,
                checkpoint => diagnostics.capture(page, checkpoint),
              ),
              turn.abortSignal,
            );
            await diagnostics.capture(page, "connector-catalog-refreshed");
          }
        }
        await diagnostics.capture(page, "prompt-attachment-complete");
        if (responseAttempt === 1) {
          await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
            this.attachFiles(page, prepared)
          ));
          await diagnostics.capture(page, "file-attachment-complete");
        }
        const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
        const initialResponseTurn = await readChatGptAssistantTurnState(responseTurns);
        let responseTurn = responseTurns.nth(initialResponseTurn.count);
        const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
        const initialUserTurnCount = await userTurns.count();
        await this.runStage(turn.traceId, "send", browserStageTimeouts.send, async (stageSignal) => {
        const composer = await this.activeComposer(page);
        const sendButton = composer
          .locator("xpath=ancestor::form[1]")
          .getByTestId("send-button");
        await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
        if (!await sendButton.isEnabled()) {
          throw new Error("ChatGPT send button is disabled after the complete prompt was attached");
        }
        await settleChatGptUi();
        await diagnostics.capture(page, "send-ready");
        await throwIfChatGptSessionFailureAlert(page);
        await sendButton.click({ force: true });
        const evidence = await this.waitForSubmissionAccepted(
          page,
          userTurns,
          responseTurns,
          responseTurn,
          initialUserTurnCount,
          initialResponseTurn,
          stageSignal,
        );
        console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${evidence}`);
        turn.onSubmitted?.();
        retrySubmitted?.();
        retrySubmitted = undefined;
        });
        await diagnostics.capture(page, "send-accepted");

        let lastHeartbeat = 0;
        let sawRunning = false;
        let loggedCompletionWait = false;
        let capturedResponse = false;
        let sentAt = Date.now();
        const latency = new ChatGptTurnLatencyDiagnostics(turn.traceId, sentAt);
        const visibleTrace = new ChatGptVisibleTraceTracker();
        const markdownOwnership = new ChatGptMarkdownOwnershipTracker();
        const markdownBuffer = new ChatGptMarkdownBuffer();
        let progressChars = 0;
        let progressToolEpoch = -1;
        const progressStatuses = new Set<string>();
        const checkpointStream = turn.captureLunaCheckpoint
          ? new ChatGptLunaCheckpointStream()
          : undefined;
        const emitMarkdownDelta = (delta: string): void => {
          const visible = checkpointStream ? checkpointStream.push(delta) : delta;
          if (visible) {
            answerBuffer.append(visible);
            const deliverable = answerBuffer.takeDeliverable(!turn.retryPromptForAnswer);
            if (deliverable) turn.onTextDelta(deliverable);
          }
        };
        const completionTracker = new ChatGptCompletionTracker();
        const domHealthTracker = new ChatGptTurnDomHealthTracker();
        for (;;) {
        if (page.isClosed()) {
          throw chatGptWebSurfaceError("ChatGPT browser tab was closed while the turn was active", answerBuffer.value().length > 0);
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        if (!isTemporaryChatGptUrl(page.url())) {
          throw chatGptWebSurfaceError(
            `ChatGPT left the isolated Temporary Chat surface while the turn was active (${page.url()})`,
            answerBuffer.value().length > 0,
          );
        }

        const currentResponseTurn = await readChatGptAssistantTurnState(responseTurns);
        const firstResponseAppeared = !capturedResponse
          && chatGptAssistantTurnChanged(initialResponseTurn, currentResponseTurn);
        if (firstResponseAppeared || (capturedResponse && await responseTurn.count().catch(() => 0) === 0)) {
          const rebound = responseTurns.last();
          if (await rebound.count().catch(() => 0) > 0) {
            responseTurn = rebound;
            await diagnostics.capture(page, "response-dom-rebound");
          }
        }

        await throwIfChatGptSessionFailureAlert(page);
        if (mode.localTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
        )) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        const snapshot = await this.responseDomSnapshot(responseTurn, markdownOwnership, running);
        await throwIfChatGptTerminalErrorAlert(
          responseTurn,
          snapshot.completionActionVisible && snapshot.visibleText.length > 0,
        );
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          const currentProgressChars = snapshot.markdownRoots.reduce(
            (total, root) => total + root.text.length,
            0,
          ) + snapshot.traceBlocks
            .filter(block => block.kind === "commentary")
            .reduce((total, block) => total + block.text.length, 0);
          const currentToolEpoch = snapshot.markdownRoots.reduce(
            (latest, root) => Math.max(latest, root.toolEpoch),
            -1,
          );
          const newStatus = snapshot.traceBlocks
            .filter(block => block.kind === "status")
            .map(block => `${block.key ?? ""}:${block.text}`)
            .find(status => !progressStatuses.has(status));
          if (currentProgressChars > progressChars || currentToolEpoch > progressToolEpoch || newStatus) {
            progressChars = Math.max(progressChars, currentProgressChars);
            progressToolEpoch = Math.max(progressToolEpoch, currentToolEpoch);
            if (newStatus) {
              progressStatuses.add(newStatus);
              if (progressStatuses.size > 512) progressStatuses.delete(progressStatuses.values().next().value!);
            }
            turn.onProgress?.();
          }
          if (!capturedResponse) {
            capturedResponse = true;
            latency.responseVisible();
            await diagnostics.capture(page, "response-visible");
          }
          latency.observe(snapshot.traceBlocks);
          const textDelta = markdownBuffer.observe(snapshot.markdownSegments);
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") { latency.commentaryEmitted(); turn.onCommentary?.(trace.text, trace.continuation === true); }
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
          });
          if (domError) throw chatGptWebSurfaceError(domError, answerBuffer.value().length > 0);
          const completion = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            projection: snapshot.projection,
          });
          if (completion.status === "stalled") {
            throw new ChatGptWebAdapterError(
              `ChatGPT final Markdown projection stopped before completion (${JSON.stringify(completion.diagnostic)})`,
              {
                status: 502,
                errorType: "server_error",
                code: "chatgpt_final_projection_stalled",
                retryable: false,
                retireSession: true,
              },
            );
          }
          if (completion.status === "complete") {
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new ChatGptWebAdapterError(
                "ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)",
                {
                  status: 502,
                  errorType: "server_error",
                  code: "chatgpt_connector_unavailable",
                  retryable: true,
                  retireSession: true,
                },
              );
            }
            const final = markdownBuffer.finish();
            if (!final.markdown && snapshot.plainTextFallback) {
              emitMarkdownDelta(snapshot.plainTextFallback);
            } else if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown || snapshot.plainTextFallback;
            }
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-30s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionVisible: false,
          });
          if (domError) throw chatGptWebSurfaceError(domError, answerBuffer.value().length > 0);
        }
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
        }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (failure instanceof ChatGptWebAdapterError && failure.retireSession) throw failure;
          const retryPrompt = chatGptTerminalErrorRetryPrompt(failure, responseAttempt, answerBuffer.value())
            ?? await turn.retryPromptForError?.(failure, responseAttempt);
          if (!retryPrompt) throw error;
          if (turn.captureLunaCheckpoint) throw new Error("ChatGPT Luna checkpoint turns cannot retry browser failures");
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          responsePrompt = retryPrompt;
          answerBuffer.continueAfterError();
          retrySubmitted = undefined;
          const reason = failure instanceof ChatGptWebAdapterError
            ? `${failure.name}:${failure.code}`
            : failure.name;
          console.warn(`[chatgpt-web] browser turn ${turn.traceId} retrying response failure attempt=${responseAttempt + 1} reason=${reason}`);
          continue;
        }
        const retryPrompt = await turn.retryPromptForAnswer?.(finalText, responseAttempt);
        if (!retryPrompt) {
          const deliverable = answerBuffer.takeDeliverable(true);
          if (deliverable) turn.onTextDelta(deliverable);
          break;
        }
        if (turn.captureLunaCheckpoint) throw new Error("ChatGPT Luna checkpoint turns cannot retry their final answer");
        const retry = typeof retryPrompt === "string" ? { text: retryPrompt } : retryPrompt;
        responsePrompt = retry.text;
        answerBuffer.retryReplacement();
        retrySubmitted = retry.onSubmitted;
        console.warn(`[chatgpt-web] browser turn ${turn.traceId} retrying final answer attempt=${responseAttempt + 1}`);
      }

      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      const answer = answerBuffer.value();
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${answer.length})`);
      return answer;
    } catch (error) {
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      prepared.release();
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
