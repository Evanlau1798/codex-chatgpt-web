import type { ChatGptWebModelCapabilities } from "../../chatgpt-web-models";
import { ChatGptPromptIntegrityMismatchError, isChatGptPromptIntegrityMismatch } from "./adapter-error";
import { ChatGptPromptOperation } from "./prompt-operation";
import { chatGptPromptCodeUnitEquivalent, chatGptPromptTextEquivalent, chatGptPromptEquivalentPrefixLength, readChatGptPromptText } from "./prompt-text";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateSkillFiles } from "./skill-attachments";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request, type Response } from "playwright-core";
import { detectChatGptLimitsPlan, prepareChatGptLimitsSubmission, readChatGptUsageAccount, readChatGptUsageModel, type ChatGptUsageModel } from "./limits";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  DEV_CHATGPT_CONNECTOR_NAME,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
  ZERO_RISK_CHATGPT_CONNECTOR_NAME,
} from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import {
  ChatGptMarkdownBuffer,
  ChatGptMarkdownConsistencyError,
  type ChatGptMarkdownSegment,
} from "./markdown";
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
  formatChatGptNativeToolActivityTelemetry,
  type ChatGptNativeToolCandidate,
} from "./native-tool-activity";
import { ChatGptResponseProgressTracker } from "./response-progress";
import {
  compiledChatGptWebMaxMessageChars,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import { CHATGPT_MAX_INPUT_IMAGES, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import { ChatGptVisibleTraceTracker, type ChatGptVisibleTraceBlock } from "./visible-trace-tracker";
import { CHATGPT_STOPPED_THINKING_LABELS } from "./ui-labels";
import {
  CHATGPT_COMPLETION_SETTLE_MS,
  ChatGptCompletionTracker,
  ChatGptMissingPostToolAnswerError,
  type ChatGptFinalProjectionState,
} from "./completion-tracker";
import type { ChatGptRetryPrompt } from "./steering";
import type { BrokerTurnOutputEvent } from "./turn-broker-protocol";
import { decideTunneledDomFallbackFinal, runChatGptTunneledOutputTurn } from "./tunneled-output-turn";
import {
  ChatGptFinalAnswerDecisionError,
  decideChatGptFinalAnswer,
  prepareChatGptFinalAnswer,
  recoverableFinalAnswerDecisionError,
} from "./final-answer-gate";
import { brokerSocketPath, withAbort as withBrowserTurnAbort } from "./runtime-lifecycle";
import { RemoteTurnBroker } from "./turn-broker";
import { activeCompactionToolResultInstruction } from "./native-compaction-control";
import { ChatGptTurnLatencyDiagnostics } from "./turn-latency";
import {
  advancePreemptiveRetryStop,
  beginPreemptiveRetryStop,
  type PreemptiveRetryStopState,
} from "./preemptive-retry-stop";
import {
  activateChatGptSendControl,
  activateOwnedChatGptSendControl,
  assertChatGptPreSendHistory,
  bindChatGptAssistantTurn,
  ChatGptOwnedSendStateUnknownError,
  ChatGptTurnIdentityAmbiguityError,
  chatGptAssistantTurnChanged,
  chatGptNewTurnIdentity,
  chatGptReboundTurnIdentity,
  chatGptSubmissionEvidence,
  locateChatGptAssistantTurn,
  readChatGptAssistantTurnState,
  readChatGptTurnIdentities,
  clearOwnedChatGptComposerControl,
  type ChatGptOwnedSendGuard,
  type ChatGptAssistantTurnBinding,
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
  assertNewChatPage,
  chatGptNewChatUrl,
  chatGptAssistantTurnSelector,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  activateChatGptEffortMenu,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  chatGptEffortSliderAdvancedTowardTarget,
  detectChatGptAccountCapabilities,
  isTemporaryChatGptUrl,
  isTemporaryChatGptTurnUrl,
  readChatGptEffortSnapshot,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
  type LauncherBrowserConnection,
} from "../../launcher-browser-host";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_ERROR,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebBiggerContext,
  type ChatGptWebModelFamily,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS, ORIGINAL_CHATGPT_BROWSER_TABS, runWithChatGptBrowserSlot } from "./concurrency";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptBrowserTabClosedError, chatGptRetainedSurfaceUnavailableError, chatGptSessionExpiredError, chatGptStoppedThinkingError, chatGptResponseIncompleteError, chatGptWebSurfaceError } from "./adapter-error";
import { ChatGptAnswerBuffer } from "./browser-answer-buffer";
import { ChatGptBrowserDiagnostics, readChatGptUpstreamFailureUiState, redactChatGptUiDiagnostic } from "./browser-diagnostics";
import { CHATGPT_CONNECTOR_MENTION_ROW_SELECTOR, chatGptConnectorMentionRowHighlighted, openChatGptConnectorPlusMenu } from "./connector-plus-menu";
import { assertChatGptModelFamily, chatGptModelFamilyMatches, selectChatGptModelFamily } from "./model-selection";
import {
  ChatGptBrowserObservationTimeoutError,
  ChatGptObservationRecoveryEpisode,
  observeChatGptSubmission,
  observeChatGptTurnIdentityAfterSend,
  withChatGptBrowserObservationTimeout,
  withChatGptPageObservationRecovery,
  type ChatGptObservationRecovery,
} from "./browser-observation";
import {
  chatGptSuspensionClock,
  connectAfterClosingBrowserConnection,
  remainingStageBudgetMs,
  waitForOperationalChatGptViewport,
} from "./browser-stage-lifecycle";
import { setChatGptThinkMode } from "./think-mode";
import { dismissChatGptTemporaryChatOnboarding } from "./temporary-chat-onboarding";
import {
  chatGptPromptAttachmentMismatch,
  clearChatGptComposerInput,
  reanchorChatGptComposerCaret,
} from "./prompt-caret";
import { insertChatGptPromptText } from "./prompt-insertion";
import { chatGptPromptPreservesLeading, planChatGptPromptInsertion, type ChatGptPromptInsertionPlan } from "./prompt-insertion-plan";
import { ChatGptCandidateAttachmentBudget } from "./prompt-candidate-budget";
import { ChatGptStartupPagePool } from "./startup-page-pool";
import { prepareChatGptStartupPage, type PreparedChatGptStartupPage } from "./startup-page-resource";
import { closeLauncherBrowserConnection } from "../../launcher-browser-connection";
import { chatGptStartupHarnessPrefix } from "./startup-harness-prefix";
import { discardLauncherStartupPages } from "./startup-page-control";
import {
  CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS,
  chatGptPromptAttachmentTimeoutMs,
} from "./prompt-attachment-budget";
import { chatGptCompletionEvidenceFailure } from "./same-surface-readiness";
import { chatGptBrowserErrorRetryPrompt } from "./same-surface-recovery";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  assertChatGptWebMultipartInputWithinLimits,
  prepareChatGptWebMultipartTransport,
  resolveChatGptWebMultipartStagingMode,
  type PreparedChatGptWebMultipartTransport,
} from "./multipart-browser-transport";

export {
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "./multipart-browser-transport";
export { CHATGPT_PROMPT_INSERT_CHUNK_CHARS } from "./prompt-attachment-budget";
import {
  chatGptExternalProgressIsLive,
  chatGptExternalToolCallsAreInFlight,
} from "./turn-progress";
import type {
  ChatGptExternalTurnProgressSnapshot,
  ChatGptTurnProgressReader,
} from "./turn-progress";
import {
  ChatGptPersistentBrowserStateError,
  runChatGptMutationCleanup,
  settleAbortedChatGptMutation,
} from "../../browser-mutation";
import { ensureChatGptPersonalizedConnectorAccess } from "./personalization";
import { verifyCurrentConnectorContract } from "./connector-contract";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
export {
  ChatGptSuspensionClock,
  connectAfterClosingBrowserConnection,
  remainingStageBudgetMs,
} from "./browser-stage-lifecycle";
export { setChatGptThinkMode } from "./think-mode";
export { dismissChatGptTemporaryChatOnboarding } from "./temporary-chat-onboarding";
export {
  browserDiagnosticCheckpoint,
  browserDiagnosticIncludesScreenshot,
  sanitizeChatGptBrowserDiagnosticState,
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
export const CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS = 180_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
export const MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS = 3;
const CHATGPT_PREEMPTIVE_RETRY_STOP_TIMEOUT_MS = 15_000;
const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;
const CHATGPT_DOM_REVISION_ATTRIBUTES = [
  "aria-hidden", "aria-label", "aria-busy", "aria-disabled", "aria-expanded", "class",
  "data-item-anchor", "data-is-last-node", "data-message-author-role", "data-state",
  "data-streaming-response-status", "data-testid", "data-turn", "data-turn-id",
  "data-turn-id-container", "data-turn-key", "data-conversation-role",
  "data-chatgpt-agent-turn-start", "data-content-search-unit-key",
  "data-user-message-bubble", "data-markdown-text-style", "data-markdown-text-tone", "disabled", "hidden",
  "inert", "open", "role", "start", "style",
] as const;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

interface ChatGptConnectorAttemptBudget {
  triggerAttempts: number;
}

function chatGptConnectorUnavailableError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
}

export class ChatGptPromptAttachmentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptPromptAttachmentIntegrityError";
  }
}

const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|Trop de requêtes|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i })
  .filter({ hasText: /making requests too quickly|Vous envoyez des demandes trop rapidement|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const accountSafetyAlert = page.locator('[role="dialog"]')
    .filter({
      hasText: /Suspicious activity detected|Nous détectons une activité suspecte|Activité inhabituelle détectée|偵測到可疑活動|检测到可疑活动|不審なアクティビティが検出されました|의심스러운 활동이 감지되었습니다/i,
    })
    .last();
  const dialog = chatGptRateLimitDialog(page);
  const accountSafetyVisible = accountSafetyAlert.isVisible().catch(() => false);
  const rateLimitVisible = dialog.isVisible().catch(() => false);
  if (await accountSafetyVisible) {
    throw new ChatGptWebAdapterError(
      "ChatGPT reported suspicious activity. Automatic Web is stopped until you acknowledge the account-safety warning.",
      {
        status: 403,
        errorType: "authentication_error",
        code: "chatgpt_account_safety_stop",
        retryable: false,
        retireSession: true,
      },
    );
  }
  if (!await rateLimitVisible) return;

  const acknowledge = dialog.getByRole("button", { name: /^(?:Got it|J[’']ai compris|Compris|知道了|了解|알겠습니다|확인)$/i }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate-limit dialog is open, but its acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          status: 429,
          errorType: "rate_limit_error",
          code: "rate_limit_exceeded",
          retryable: false,
          retireSession: true,
        },
      );
    }
  }
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    {
      status: 429,
      errorType: "rate_limit_error",
      code: "rate_limit_exceeded",
      retryable: false,
      retireSession: true,
    },
  );
}

type ChatGptTextScope = Pick<Locator, "getByText" | "getByTestId">;

const chatGptSubscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription|Échec du chargement de l[’']abonnement/i })
  .last();

const chatGptExpiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText: /Your session has expired|Votre session a expiré|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i })
  .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  const expired = chatGptExpiredSessionAlert(page).isVisible().catch(() => false);
  const subscriptionUnavailable = chatGptSubscriptionFailureAlert(page).isVisible().catch(() => false);
  if (await expired) {
    throw chatGptSessionExpiredError();
  }
  if (!await subscriptionUnavailable) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/(?:Something went wrong|Une erreur s[’']est produite)[\s\S]*help\.openai\.com/i)
  .last();

export async function throwIfChatGptTerminalErrorAlert(
  scope: ChatGptTextScope,
  completedAnswerVisible = false,
): Promise<void> {
  if (completedAnswerVisible) return;
  const regenerateError = scope.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false);
  const terminalError = chatGptTerminalErrorAlert(scope).isVisible().catch(() => false);
  if (await regenerateError) {
    throw new ChatGptWebAdapterError(
      "ChatGPT displayed an error for this response. Check the ChatGPT tab for the exact error, then retry the turn.",
      { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
    );
  }
  if (!await terminalError) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

const CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE = "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";

function chatGptModelControlUnavailableError(diagnostic: string): Error {
  return new Error(CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE, { cause: new Error(diagnostic) });
}

function chatGptModelControlUnavailableAdapterError(diagnostic: string, detail?: string, retryable = false): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    detail ? `${CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE} ChatGPT: ${detail}` : CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE,
    {
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable,
      cause: new Error(diagnostic),
    },
  );
}

async function chatGptEffortMenuReadinessError(page: Page, diagnostic: string): Promise<ChatGptWebAdapterError> {
  const choices = await page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last()
    .locator(CHATGPT_EFFORT_ITEM_SELECTOR).count().catch(() => 0);
  return chatGptModelControlUnavailableAdapterError(diagnostic, undefined, choices === 0);
}

export async function chatGptUnavailableProDetail(menu: Locator): Promise<string | undefined> {
  const rows = menu.getByRole("menuitemradio", { name: "Pro", exact: true }).filter({ visible: true });
  try {
    if (await rows.count() !== 1 || await rows.getAttribute("aria-disabled") !== "true") return undefined;
    await rows.hover({ timeout: 1_500 });
    return await rows.evaluate(async element => {
      const deadline = Date.now() + 1_000;
      do {
        const ids = element.getAttribute("aria-describedby")?.trim().split(/\s+/).filter(Boolean) ?? [];
        const tooltips = ids.map(id => document.getElementById(id))
          .filter((node): node is HTMLElement => node instanceof HTMLElement && node.getAttribute("role") === "tooltip");
        const visible = tooltips.filter(node => {
          for (let current: HTMLElement | null = node; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (!current.isConnected || current.hidden || current.getAttribute("aria-hidden") === "true"
              || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          }
          return true;
        });
        if (visible.length === 1) {
          const text = visible[0]!.textContent?.replace(/\s+/g, " ").trim();
          if (text && text.length <= 512) return text;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return undefined;
    }, undefined, { timeout: 1_500 });
  } catch {
    return undefined;
  }
}

// The current UI renders message_length_exceeds_limit as an ordinary response error.
// Observe only browser-issued submissions from this owned page after Send is activated;
// an old response, another tab, or a background endpoint cannot classify this turn.
export class ChatGptSubmissionRejectionObserver {
  private page?: Page;
  private generation = 0;
  private readonly requests = new Set<Request>();
  private readonly streams = new Map<Request, Response>();
  private checks: Array<Promise<ChatGptWebAdapterError | undefined>> = [];
  private ownedRequests = 0;
  private statuses: number[] = [];
  private requestFailures = 0;
  private failureCodes: string[] = [];
  private rebinds = 0;
  private activated = false;

  constructor(private readonly onRejected?: (error: ChatGptWebAdapterError) => void) {}

  private readonly onRequest = (request: Request): void => {
    if (!this.page || !this.activated || request.method() !== "POST"
      || request.url() !== "https://chatgpt.com/backend-api/f/conversation"
      || request.frame() !== this.page.mainFrame()) return;
    this.requests.add(request);
    this.ownedRequests++;
  };

  private readonly onResponse = (response: Response): void => {
    if (!this.requests.has(response.request())) return;
    this.statuses.push(response.status());
    if (this.statuses.length > 8) this.statuses.shift();
    const contentType = response.headers()["content-type"];
    if (response.status() === 200 && contentType?.includes("text/event-stream")) {
      this.streams.set(response.request(), response);
      return;
    }
    if (response.status() !== 413
      || !contentType?.includes("application/json")) return;
    this.observeRejection(response.json().then(body => body?.detail?.code === "message_length_exceeds_limit"));
  };

  private observeRejection(check: Promise<boolean>): void {
    const generation = this.generation;
    this.checks.push(withChatGptBrowserObservationTimeout(check, 3_000)
      .then(rejected => {
        if (generation !== this.generation || !rejected) return undefined;
        const error = new ChatGptWebAdapterError(
          "ChatGPT rejected this message because it exceeds the selected mode's input-size limit. Compact the task before retrying.",
          { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
        );
        this.onRejected?.(error);
        return error;
      })
      // Unreadable or unfamiliar responses do not establish a size rejection. The normal
      // bound-response DOM error remains authoritative in that case.
      .catch(() => undefined));
  }

  private readonly onRequestFailed = (request: Request): void => {
    this.streams.delete(request);
    if (!this.requests.delete(request)) return;
    this.requestFailures++;
    this.failureCodes.push(request.failure()?.errorText.match(/\bERR_[A-Z0-9_]+\b/)?.[0] ?? "unknown");
    if (this.failureCodes.length > 8) this.failureCodes.shift();
  };

  private readonly onRequestFinished = (request: Request): void => {
    this.requests.delete(request);
    const response = this.streams.get(request);
    this.streams.delete(request);
    if (!response) return;
    this.observeRejection(response.text().then(body => body.split(/\r?\n\r?\n/).some(block => {
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data === "[DONE]") return false;
      try {
        const event = JSON.parse(data);
        return event?.error_code === "input_too_large" && event?.error_reason === "last_user_message"
          && typeof event?.error === "string" && event.error.length > 0;
      } catch { return false; }
    })));
  };

  ownedSubmissionRequestObserved(): boolean { return this.ownedRequests > 0; }

  activate(): void {
    if (!this.page) throw new Error("ChatGPT submission observer is not attached");
    this.ownedRequests = 0;
    this.activated = true;
  }

  begin(page: Page): void {
    this.dispose();
    this.checks = [];
    this.ownedRequests = 0;
    this.statuses = [];
    this.requestFailures = 0;
    this.failureCodes = [];
    this.rebinds = 0;
    this.activated = false;
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
    page.on("requestfinished", this.onRequestFinished);
  }

  noteRebind(): void { if (this.page) this.rebinds++; }

  diagnosticSummary(): { ownedRequests: number; statuses: number[]; requestFailures: number; failureCodes: string[];
    pendingRequests: number; networkObservationContinuous: boolean; rebinds: number } {
    return { ownedRequests: this.ownedRequests, statuses: [...this.statuses],
      requestFailures: this.requestFailures, failureCodes: [...this.failureCodes], pendingRequests: this.requests.size,
      networkObservationContinuous: this.rebinds === 0, rebinds: this.rebinds };
  }

  async failure(): Promise<ChatGptWebAdapterError | undefined> {
    return (await Promise.all(this.checks)).find(error => error !== undefined);
  }

  dispose(): void {
    this.generation += 1;
    this.page?.off("request", this.onRequest);
    this.page?.off("response", this.onResponse);
    this.page?.off("requestfailed", this.onRequestFailed);
    this.page?.off("requestfinished", this.onRequestFinished);
    this.page = undefined;
    this.activated = false;
    this.requests.clear();
    this.streams.clear();
  }
}

type SelectedChatGptWebModelMode = ChatGptWebModelMode & {
  modelFamily?: "5.6" | "6";
  selection?: { url: string; label: string };
  usageModel?: ChatGptUsageModel;
};

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
  onApprovalPending?: (pending: boolean) => Promise<void>,
): Promise<boolean> {
  const escapedAppName = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dialogs = page.locator('[role="dialog"], [data-testid="tool-approval-card"], [data-codex-approval-surface="true"]')
    .filter({ has: page.getByText(new RegExp(`^(?:Allow ChatGPT to use|Autoriser ChatGPT à utiliser) ${escapedAppName}\\s*\\?$`)) })
    .filter({ visible: true });
  const count = await dialogs.count();
  if (count === 0) return false;
  if (count !== 1) throw new Error("ChatGPT exposed multiple approvals for the selected connector");
  const dialog = dialogs.first();
  await onVisible?.();
  if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");

  if (autoApprove) {
    // ChatGPT exposes either "Allow once" or the shorter "Allow" for the
    // current one-shot approval. Keep the matcher anchored so persistent
    // actions such as "Always allow" cannot match.
    const allowCurrentAction = dialog
      .getByRole("button", { name: /^(?:Allow(?: once)?|Autoriser(?: une fois)?)$/ })
      .filter({ visible: true });
    const deny = dialog.getByRole("button", { name: /^(?:Deny|Refuser)$/, exact: true }).filter({ visible: true });
    await allowCurrentAction.waitFor({ state: "visible", timeout: 10_000, signal });
    await deny.waitFor({ state: "visible", timeout: 10_000, signal });
    if (await allowCurrentAction.count() !== 1 || await deny.count() !== 1) {
      throw new Error("ChatGPT approval does not expose a unique one-time Allow and Deny action");
    }
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    await allowCurrentAction.click({ timeout: 10_000, signal });
    await dialog.waitFor({ state: "hidden", timeout: 10_000, signal });
    return true;
  }

  let approvalError: unknown;
  try {
    await onApprovalPending?.(true);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (!await dialog.isVisible().catch(() => false)) return true;
      await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
    }

    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    const deny = dialog.getByRole("button", { name: /^(?:Deny|Refuser)$/, exact: true }).filter({ visible: true });
    if (await deny.count() !== 1) throw new Error("ChatGPT approval does not expose a unique Deny action");
    await deny.waitFor({ state: "visible", timeout: 5_000 });
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    await deny.click({ timeout: 5_000, signal });
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    return true;
  } catch (error) {
    approvalError = error;
    throw error;
  } finally {
    try {
      await onApprovalPending?.(false);
    } catch (error) {
      if (approvalError === undefined) throw error;
      // A closed tab can reject the final update. Preserve the original failure;
      // releasing the turn also removes its pending-approval state.
      console.warn(`[chatgpt-web] could not clear tool approval status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
  useEnhancedWebSessionMode = false,
  modelFamily?: ChatGptWebModelFamily,
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
  const { contextWindow } = resolveChatGptWebContextLimits(
    modelId,
    effort,
    capabilities,
    useEnhancedWebSessionMode,
    modelFamily,
  );
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

export const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: CHATGPT_PROMPT_ATTACHMENT_TIMEOUT_MS,
  fileAttachment: 120_000,
  send: 60_000,
  multipartStageSend: 180_000,
  multipartStageAcknowledgement: CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
} as const;

/**
 * A six-figure Input.insertText can make current ChatGPT Lexical surfaces rewrite text inside the
 * first edit even when its final UTF-16 length is unchanged. Bound only the native edit operation;
 * the resulting user message remains one exact prompt, and every prefix is still verified before
 * another irreversible edit. This is independent of model context and compaction limits.
 */
export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  modelFamily?: "5.6" | "6";
  capabilities: ChatGptWebCapabilities;
  /** Attach the Native2 connector for bridge control without granting outer Codex work capability. */
  nativeConnector?: boolean;
  /** Parent admission permits an unsent speculative page; never enables it for compaction. */
  allowStartupPreparation?: boolean;
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
  /** Send activation is an irreversible ambiguity boundary: never replay on a fresh surface. */
  onSendActivated?: () => void | Promise<void>;
  /** The current prompt is visible to ChatGPT and must never be replayed on another surface. */
  onSubmitted?: () => void | Promise<void>;
  onMultipartStageAcknowledged?: (stageIndex: number) => void | Promise<void>;
  /** Release the unselected full/resume transport after the launcher resolves the retained lease. */
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Preserve visible JSON text without Markdown presentation escaping. */
  outputFormat?: "visible-text";
  /** Proven current-turn MCP activity; liveness only, never response content or completion. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Atomically fences browser completion against concurrent MCP work accepted by the broker. */
  completionFence?: {
    begin(): Promise<number | undefined>;
    commit(revision: number): Promise<boolean>;
  };
  /** Atomically close work tools immediately before a missing-final recovery is submitted. */
  beginFinalizationOnly?: (expectedActivityRevision: number) => boolean | Promise<boolean>;
  /** Reopen work tools when a final-only recovery was proven not to have been submitted. */
  cancelFinalizationOnly?: (expectedActivityRevision: number) => boolean | Promise<boolean>;
  /** Admit final output only after the recovery prompt was atomically submitted in the browser. */
  armFinalizationOutput?: (expectedActivityRevision: number) => boolean | Promise<boolean>;
  /** Ordered assistant output delivered by the private Native2 control wire. */
  tunneledOutput?: {
    next(afterSequence: number, signal?: AbortSignal): Promise<BrokerTurnOutputEvent>;
    reset(finalSequence: number): Promise<void>;
    seal(afterSequence: number, expectedRevision: number): Promise<boolean>;
  };
  finalAnswerAdmission?: {
    seal(): boolean;
    reopen(): void;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
  /** Return a corrective follow-up prompt to retry the final answer in the same chat. */
  retryPromptForAnswer?: (answer: string, attempt: number) => string | ChatGptRetryPrompt | undefined | Promise<string | ChatGptRetryPrompt | undefined>;
  /** Return a corrective follow-up prompt after a recoverable response-reading failure. */
  retryPromptForError?: (error: Error, attempt: number) => string | ChatGptRetryPrompt | undefined | Promise<string | ChatGptRetryPrompt | undefined>;
}

interface ChatGptAcknowledgedMultipartStage {
  text: string;
  acknowledgement: string;
  identities: string[];
}

interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialUserTurnCount: number;
  initialResponseTurnCount: number;
  initialTurnIdentities: readonly string[];
  initialPageUrl?: string;
  submissionRequestObserved?: () => boolean;
  activateSubmissionRequestObservation?: () => void;
  initialResponseTurn?: ChatGptAssistantTurnState;
  submittedText?: string;
  acceptedUserIdentity?: string;
  acknowledgedStages?: readonly ChatGptAcknowledgedMultipartStage[];
}

interface ChatGptActivityTurnBinding {
  identity: string;
  locator: Locator;
  acceptedTurnIdentities: readonly string[];
}

export interface ResolvedBrowserConfig {
  appName: string;
  brokerSocketPath?: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  browserHelperScriptPath?: string;
  browserDiagnosticsPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
  experimentalNoAutoCompact?: boolean;
  useEnhancedWebSessionMode?: boolean;
  /** Candidate only: replace large guarded insertions; preserve existing direct inline routes. */
  experimentalComposerPlainText?: boolean;
  maxBrowserTabs?: number;
  useSavedChats: boolean;
}

export function chatGptStopButton(page: Page): Locator {
  return page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({visible: true}).last();
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; activityText?: string; since: number };
  private missingCompletionActionExpired = false;
  private lastFailureKind?: "response_dom" | "empty_completion" | "completion_evidence";

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  /**
   * Suspend health deadlines while external progress proves the turn is alive, preserving
   * `sawResponse`. No grace period may include time spent executing tools.
   */
  suspendForProgress(): void {
    this.missingResponseSince = undefined;
    this.emptyCompletionSince = undefined;
    this.missingCompletionAction = undefined;
    this.missingCompletionActionExpired = false;
  }

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
    externalProgressLive?: boolean;
    activityText?: string;
  }, now = Date.now()): string | undefined {
    this.lastFailureKind = undefined;
    if (state.responsePresent) this.sawResponse = true;
    if (state.externalProgressLive || state.running) {
      // Every conclusion below asserts that ChatGPT stopped producing this turn. A tool call that
      // is still completing or a visible Stop control disproves that, whatever response content
      // the renderer currently exposes. Start a fresh grace period once generation stops.
      this.suspendForProgress();
      return undefined;
    }
    if (state.responsePresent) {
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        this.lastFailureKind = "response_dom";
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
        this.lastFailureKind = "empty_completion";
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
      this.missingCompletionActionExpired = false;
    } else if (this.missingCompletionAction?.text !== state.currentText
      || this.missingCompletionAction?.activityText !== state.activityText) {
      this.missingCompletionAction = { text: state.currentText, activityText: state.activityText, since: now };
      this.missingCompletionActionExpired = false;
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      if (this.missingCompletionActionExpired || state.currentText.length === 0) {
        this.lastFailureKind = "completion_evidence";
        return state.currentText.length > 0
          ? "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed"
          : "ChatGPT stopped showing generation or tool activity without a final answer. Check the ChatGPT tab for an error before retrying.";
      }
      this.missingCompletionActionExpired = true;
    }
    return undefined;
  }

  failureKind(): "response_dom" | "empty_completion" | "completion_evidence" | undefined {
    return this.lastFailureKind;
  }
}

export const MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS = 8;
export const CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000;
export const CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS = 5_000;

export function chatGptExternalProgressSuppressesDomHealth(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): boolean {
  if (!chatGptExternalProgressIsLive(snapshot, now, CHATGPT_RESPONSE_DOM_GRACE_MS)) return false;
  const lastProgressAt = snapshot?.lastProgressAt;
  if (lastProgressAt === undefined) return false;
  const age = now - lastProgressAt;
  return age >= -CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS
    && age < CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  plainTextFallback: string;
  markdownSegments: ChatGptMarkdownSegment[];
  markdownRoots: ChatGptMarkdownRootSnapshot[];
  completionActionVisible: boolean;
  globalCompletionActionVisible: boolean;
  stoppedThinkingVisible: boolean;
  projection: ChatGptFinalProjectionState;
  traceBlocks: ChatGptVisibleTraceBlock[];
  nativeToolCandidates: ChatGptNativeToolCandidate[];
}

export async function discardChatGptStartupPages(): Promise<void> {
  for (const worker of workers.values()) await worker.discardStartupPage();
}

function chatGptCompletionEvidenceRecovered(
  snapshot: Pick<ChatGptResponseDomSnapshot, "responsePresent" | "visibleText" | "completionActionVisible">,
): boolean {
  return snapshot.responsePresent && snapshot.visibleText.length > 0 && snapshot.completionActionVisible;
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  plainTextFallback: "",
  markdownSegments: [],
  markdownRoots: [],
  completionActionVisible: false,
  globalCompletionActionVisible: false,
  stoppedThinkingVisible: false,
  projection: { boundaryProtocolPresent: false, lastNodePresent: false, animations: [] },
  traceBlocks: [],
  nativeToolCandidates: [],
});

function settledPreToolAnswerText(snapshot: ChatGptResponseDomSnapshot | undefined, running: boolean): string | undefined {
  if (!snapshot?.responsePresent || running || !snapshot.completionActionVisible || !snapshot.visibleText) return undefined;
  const projection = snapshot.projection;
  if (!projection.rootId || projection.lastMutationAt === undefined
    || Date.now() - projection.lastMutationAt < CHATGPT_COMPLETION_SETTLE_MS) return undefined;
  if (projection.boundaryProtocolPresent !== false
    && (!projection.lastNodePresent || projection.boundaryStart === undefined || projection.boundaryEnd === undefined)) {
    return undefined;
  }
  return snapshot.visibleText;
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || /^(?:Answer now|Thinking|Répondre maintenant|Réflexion(?: en cours)?(?:\.\.\.|…)?)$/.test(text);
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)(?:Answer now|Répondre maintenant)\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const browserHelperScriptPath = configured.browserHelperScriptPath?.trim();
  const browserDiagnosticsPath = resolve(expandUserPath(
    configured.browserDiagnosticsPath?.trim() || join(getConfigDir(), "diagnostics", "browser-turns"),
  ));
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (browserHelperScriptPath && browserHost !== "launcher") {
    throw new Error("Explicit browser helper script requires a launcher host");
  }
  const resolvedBrowserHelperScriptPath = browserHelperScriptPath
    ? resolve(expandUserPath(browserHelperScriptPath))
    : undefined;
  if (resolvedBrowserHelperScriptPath && !existsSync(resolvedBrowserHelperScriptPath)) {
    throw new Error(`Explicit browser helper script does not exist: ${resolvedBrowserHelperScriptPath}`);
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
    brokerSocketPath: brokerSocketPath(provider),
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    ...(resolvedBrowserHelperScriptPath ? { browserHelperScriptPath: resolvedBrowserHelperScriptPath } : {}),
    browserDiagnosticsPath,
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
    experimentalNoAutoCompact: configured.experimentalNoAutoCompact === true,
    ...(configured.useEnhancedWebSessionMode ? { useEnhancedWebSessionMode: true } : {}),
    ...(configured.experimentalComposerPlainText ? { experimentalComposerPlainText: true } : {}),
    maxBrowserTabs: configured.automaticWebSessionLimitMinutes !== undefined
      ? configured.maxBrowserTabs ?? MAX_CHATGPT_BROWSER_TABS : MAX_CHATGPT_BROWSER_TABS,
    useSavedChats: configured.useSavedChats === true,
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

function assertChatGptPromptAttachments(prompt: CompiledChatGptWebPrompt): void {
  if (prompt.images.length + (prompt.skillFiles?.length ?? 0) > CHATGPT_MAX_INPUT_IMAGES) {
    throw new ChatGptWebAdapterError(
      "Selected skills and images exceed ChatGPT's 10 attachments per message; disable Skills as files or reduce attachments.",
      { status: 400, errorType: "invalid_request_error", code: "too_many_attachments", retryable: false },
    );
  }
  validateSkillFiles(prompt.skillFiles);
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  assertChatGptPromptAttachments(prompt);
  const files = [...chatGptImageFilePayloads(prompt.images), ...(prompt.skillFiles ?? []).map(file => ({
    name: file.name, mimeType: "text/plain", buffer: Buffer.from(file.text, "utf8"),
  }))];
  if (files.reduce((sum, file) => sum + file.buffer.length, 0) > 50_000_000) {
    throw new Error("ChatGPT web attachments exceed the 50 MB per-turn limit");
  }
  return files;
}

export class ChatGptBrowserWorker {
  private lastSelectedModel?: SelectedChatGptWebModelMode;
  private readonly startupPages = new ChatGptStartupPagePool<PreparedChatGptStartupPage>();
  private closing = false;
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
  private readonly preemptiveRetries = new Map<string, string>();
  private readonly preemptedRuns = new Set<string>();
  private readonly compactionBoundaryRetentions = new Set<string>();
  private readonly finalizingRuns = new Set<string>();

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  private async pauseObservation(): Promise<void> {
    await new Promise<void>(resolveSleep => setTimeout(resolveSleep, 250));
  }

  /**
   * Lexical/contenteditable may preserve runs of ASCII spaces by exposing some of them as NBSP
   * through DOM textContent. Treat that DOM-only representation as equivalent only when the
   * expected U+0020 belongs to a multi-space run. Single spaces, tabs, newlines, intentional
   * expected NBSP characters, and every other mutation remain exact and fail closed.
   */
  private promptCodeUnitEquivalent(
    expected: string,
    observed: string,
    index: number,
  ): boolean {
    return chatGptPromptCodeUnitEquivalent(expected, observed, index);
  }

  private promptTextEquivalent(expected: string, observed: string): boolean {
    return chatGptPromptTextEquivalent(expected, observed);
  }

  private promptEquivalentPrefixLength(expected: string, observed: string): number {
    return chatGptPromptEquivalentPrefixLength(expected, observed);
  }

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
      this.preemptiveRetries.delete(turn.traceId);
      this.preemptedRuns.delete(turn.traceId);
      this.compactionBoundaryRetentions.delete(turn.traceId);
      this.finalizingRuns.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  requestPreemptiveRetry(traceId: string, prompt: string): boolean {
    if (!prompt.trim() || !this.activeRuns.has(traceId) || this.finalizingRuns.has(traceId)) return false;
    const useHelper = this.config.browserHost === "launcher"
      && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) return this.launcherHelper?.requestPreemptiveRetry(traceId, prompt) === true;
    if (this.preemptedRuns.has(traceId)) return false;
    this.preemptedRuns.add(traceId);
    this.preemptiveRetries.set(traceId, prompt);
    return true;
  }

  async armCompactionBoundaryRetention(traceId: string): Promise<boolean> {
    if (!this.activeRuns.has(traceId) || this.finalizingRuns.has(traceId)) return false;
    const useHelper = this.config.browserHost === "launcher"
      && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) return await this.launcherHelper?.armCompactionBoundaryRetention(traceId) === true;
    if (this.compactionBoundaryRetentions.has(traceId)) return false;
    this.compactionBoundaryRetentions.add(traceId);
    return true;
  }

  private takePreemptiveRetry(traceId: string): string | undefined {
    const prompt = this.preemptiveRetries.get(traceId);
    if (prompt) this.preemptiveRetries.delete(traceId);
    return prompt;
  }

  private async runWithSurfaceRetry(turn: BrowserTurn): Promise<string> {
    let sendActivated = false;
    let submitted = false;
    const submittedTurn: BrowserTurn = {
      ...turn,
      onSendActivated: async () => {
        sendActivated = true;
        await turn.onSendActivated?.();
      },
      onSubmitted: () => {
        submitted = true;
        return turn.onSubmitted?.();
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
      const canRetryFreshSurface = error instanceof ChatGptWebAdapterError
        && (error.code === "chatgpt_surface_changed" || error.code === "chatgpt_connector_unavailable")
        && error.retryable
        && (!adapterOwnsRecovery || error.code === "chatgpt_connector_unavailable")
        && !sendActivated
        && !submitted
        && !turn.abortSignal?.aborted;
      if (!canRetryFreshSurface) throw error;
      if (turn.requireRetainedConversation) {
        throw chatGptRetainedSurfaceUnavailableError(error);
      }
      console.warn(`[chatgpt-web] browser turn ${turn.traceId} retrying once on a fresh surface`);
      return this.runExclusive(submittedTurn);
    }
  }

  verifyConnector(traceId = `verify_${randomUUID().replaceAll("-", "")}`): Promise<string> {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      return Promise.reject(new Error("ChatGPT connector verification trace id is invalid"));
    }
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive(traceId));
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    extraHighAvailable?: boolean;
    proAvailable?: boolean;
    modelCapabilities?: ChatGptWebModelCapabilities;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  inspectLimitsPlan() {
    return this.enqueueMaintenance("Limits setup", async () => {
      const page = await this.ensurePage();
      await this.prepareChatSurface(page);
      return detectChatGptLimitsPlan(page);
    });
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
    this.closing = true;
    await this.startupPages.cancel();
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

  async discardStartupPage(): Promise<void> {
    await this.startupPages.cancel();
    if (this.launcherHelper && this.config.browserHostDescriptorPath) {
      await discardLauncherStartupPages(this.config.browserHostDescriptorPath);
    }
  }

  private startupPageKey(turn: BrowserTurn): string {
    return JSON.stringify([turn.modelId, turn.reasoning ?? "high", turn.modelFamily, turn.capabilities]);
  }

  private async primeStartupPage(turn: BrowserTurn, prepared: CompiledChatGptWebPrompt, trackUsage: boolean): Promise<void> {
    if (this.closing || turn.abortSignal?.aborted || turn.compaction || prepared.multipart) return;
    const prefix = chatGptStartupHarnessPrefix(prepared.text);
    if (!prefix) return;
    const { modelId, reasoning, capabilities, modelFamily } = turn;
    await this.startupPages.maintain(this.startupPageKey(turn), ` ${prefix}`, (signal, registerCleanup) => prepareChatGptStartupPage({
      descriptorPath: this.config.browserHostDescriptorPath!, connectorIdentity: this.config.appName,
      prefix: ` ${prefix}`,
      prepare: async (page, signal) => {
        await this.prepareChatSurface(page, undefined, this.config.useSavedChats);
        signal.throwIfAborted();
        const mode = await this.selectModelAndEffort(page, modelId, reasoning, capabilities,
          undefined, trackUsage, modelFamily);
        signal.throwIfAborted();
        const operation = new ChatGptPromptOperation(signal).budget(90_000);
        await this.attachPrompt(page, prefix, true, undefined, signal, false, { triggerAttempts: 0 },
          mode.thinkEnabled, false, false, undefined, { traceId: "startup", stage: "startup_harness", operation });
        return mode;
      },
    }, signal, registerCleanup));
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal, remainingMs: () => number) => Promise<T>,
    ownerSignal?: AbortSignal,
    suspensionClock: Pick<typeof chatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    chatGptSuspensionClock.start();
    const startedAt = performance.now();
    const suspendedAtStart = suspensionClock.suspendedMs();
    const remainingMs = () => remainingStageBudgetMs(timeoutMs,
      performance.now() - startedAt, suspensionClock.suspendedMs() - suspendedAtStart);
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onOwnerAbort: (() => void) | undefined;
    let actionPromise: Promise<T> | undefined;
    try {
      if (ownerSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const fireOrRearm = () => {
          const remaining = remainingMs();
          if (remaining > 0) {
            timer = setTimeout(fireOrRearm, remaining);
            return;
          }
          const message = `ChatGPT browser stage timed out: ${stage}`;
          const failure = stage === "prompt_attachment" || stage === "send"
            ? chatGptWebSurfaceError(message, false) : new Error(message);
          rejectTimeout(failure);
          controller.abort(failure);
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      const ownerAbort = ownerSignal
        ? new Promise<never>((_, rejectAbort) => {
            onOwnerAbort = () => {
              const reason = ownerSignal.reason ?? new DOMException("ChatGPT web turn aborted", "AbortError");
              rejectAbort(reason);
              controller.abort(reason);
            };
            ownerSignal.addEventListener("abort", onOwnerAbort, { once: true });
          })
        : undefined;
      actionPromise = action(controller.signal, remainingMs);
      const value = await Promise.race([actionPromise, timeout, ...(ownerAbort ? [ownerAbort] : [])]);
      if (controller.signal.aborted) throw controller.signal.reason;
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      let surfacedError = error;
      if (controller.signal.aborted && awaitAbortedActionSettlement && actionPromise) {
        const settlementAt = performance.now();
        surfacedError = await settleAbortedChatGptMutation(actionPromise, surfacedError);
        console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} mutationSettlementMs=${Math.round(performance.now() - settlementAt)} isolated=${surfacedError instanceof ChatGptPersistentBrowserStateError}`);
      }
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${surfacedError instanceof Error ? surfacedError.message : String(surfacedError)}`);
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
      if (ownerSignal && onOwnerAbort) ownerSignal.removeEventListener("abort", onOwnerAbort);
    }
  }

  private async retryPromptAttachmentAfterRebind(
    action: () => Promise<void>,
    rebind?: (cause: Error) => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!rebind
        || !(error instanceof ChatGptWebAdapterError)
        || error.code !== "chatgpt_surface_changed"
        || error.message !== "ChatGPT browser stage timed out: prompt_attachment") throw error;
      await rebind(error);
      await action();
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

  private async closeEffortMenu(page: Page, control: Locator): Promise<void> {
    const selectionUrl = page.url();
    const composer = await this.activeComposer(page);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.keyboard.press("Escape");
      const deadline = Date.now() + 1_000;
      do {
        const expanded = await control.getAttribute("aria-expanded").catch(() => null);
        const state = await control.getAttribute("data-state").catch(() => null);
        if (page.url() !== selectionUrl || await control.count() !== 1) {
          throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the browser surface while closing its effort menu");
        }
        // Preserve the official bounded close retry, and wait for its composer to commit.
        if ((expanded === "false" || state === "closed")
          && await composer.isEditable({ timeout: Math.max(1, deadline - Date.now()) }).catch(() => false)) return;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
      } while (Date.now() < deadline);
    }
    throw chatGptModelControlUnavailableAdapterError(
      "ChatGPT did not close its effort menu after selecting the requested effort",
    );
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
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
    trackUsage = false,
    modelFamily?: "5.6" | "6",
  ): Promise<SelectedChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const uiEffortIndex = mode.uiEffortIndex;
    const cached = this.lastSelectedModel;
    if (cached?.selection && modelFamily && cached.modelFamily === modelFamily
      && cached.modelId === mode.modelId && cached.effort === mode.effort
      && (!trackUsage || cached.usageModel !== undefined)
      && chatGptModelFamilyMatches([cached.selection.label], modelFamily, mode.effort)) {
      const controls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await controls.count() === 1) {
        const [label, expanded, editable] = await Promise.all([
          controls.innerText(), controls.getAttribute("aria-expanded"), composer.isEditable(),
        ]);
        if (label.trim() === cached.selection.label && expanded === "false" && editable) {
          const selected = { ...mode, modelFamily, selection: { url: page.url(), label: cached.selection.label },
            ...(trackUsage && cached.usageModel ? { usageModel: cached.usageModel } : {}) };
          await this.assertSelectedEffort(page, selected, false);
          await captureDiagnostic?.("effort-selection-cache-verified");
          return selected;
        }
      }
    }
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
        throw chatGptModelControlUnavailableError(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      // Enable Think during prompt attachment, before fresh connector selection. Ordinary Luna
      // still clears a previous Think selection here; retained Think is checked on every attach.
      if (!mode.thinkEnabled) await setChatGptThinkMode(composer, false, captureDiagnostic);
      return mode;
    }
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
    const effortWaitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        currentEffort.waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "effort" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableError(
        "ChatGPT rendered the composer but its model/effort control did not become ready",
      );
    } finally {
      effortWaitAbort.abort();
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    await throwIfChatGptRateLimitDialog(page);
    await throwIfChatGptSessionFailureAlert(page);
    let activation: Awaited<ReturnType<typeof activateChatGptEffortMenu>>;
    try {
      activation = await activateChatGptEffortMenu(page, currentEffort);
      if (modelFamily) activation = await selectChatGptModelFamily(
        activation, modelFamily, () => activateChatGptEffortMenu(page, currentEffort),
      );
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw await chatGptEffortMenuReadinessError(page, "The effort menu did not open");
    }
    if (activation.method === "pointerdown") {
      await captureDiagnostic?.("effort-menu-pointerdown-fallback");
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortSlider = activation.slider;
    const sliderContainer = activation.sliderContainer;
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        sliderContainer.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => effortSlider.waitFor({ state: "attached", timeout: 70_000, signal: waitAbort.signal }))
          .then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
      await captureDiagnostic?.("effort-slider-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw await chatGptEffortMenuReadinessError(
        page, `ChatGPT effort slider did not become ready for item index ${uiEffortIndex}`,
      );
    } finally {
      waitAbort.abort();
    }
    const selectionUrl = page.url();
    const readAvailableEffort = async (container: Locator, menu: Locator) => {
      const state = await readChatGptEffortSnapshot(container)
        .catch(error => { throw chatGptModelControlUnavailableAdapterError(String(error)); });
      if (uiEffortIndex > state.max - state.min) {
        const detail = uiEffortIndex === 4 ? await chatGptUnavailableProDetail(menu) : undefined;
        throw chatGptModelControlUnavailableAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex} (min=${state.min}; max=${state.max})`
          + (uiEffortIndex === 4 ? " ChatGPT may have temporarily hidden Pro because you reached its usage limit." : ""),
          detail,
        );
      }
      if (!state.available[uiEffortIndex]) {
        throw new ChatGptWebAdapterError(
          `ChatGPT locks the browser option requested for ${mode.displayLabel} behind an upgrade. `
          + "The message was not sent. Choose an available effort and run Repair Codex setup to refresh the model list.",
          { status: 400, errorType: "invalid_request_error", code: "chatgpt_effort_locked", retryable: false },
        );
      }
      return state;
    };
    let sliderState = await readAvailableEffort(sliderContainer, activation.menu);
    const initialMin = sliderState.min;
    const targetValue = initialMin + uiEffortIndex;
    const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
    while (sliderState.value !== targetValue) {
      await throwIfChatGptRateLimitDialog(page);
      const direction = targetValue > sliderState.value ? 1 : -1;
      const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
      const previousValue = sliderState.value;
      await sliderControl.press(key);
      const changeDeadline = Date.now() + 5_000;
      do {
        sliderState = await readAvailableEffort(sliderContainer, activation.menu);
        if (sliderState.min !== initialMin) {
          throw chatGptModelControlUnavailableError("ChatGPT changed its effort range origin during selection");
        }
        if (sliderState.value !== previousValue) break;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
      } while (Date.now() < changeDeadline);
      if (!chatGptEffortSliderAdvancedTowardTarget(previousValue, sliderState.value, targetValue)) {
        throw chatGptModelControlUnavailableError(
          `ChatGPT effort slider did not advance toward the target with ${key}`
          + ` (before=${previousValue}; after=${sliderState.value}; target=${targetValue})`,
        );
      }
    }
    await settleChatGptUi();
    const selectedState = await readAvailableEffort(sliderContainer, activation.menu);
    if (selectedState.min !== initialMin || selectedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT changed its effort range or selection before the menu closed");
    }
    await captureDiagnostic?.("effort-selected");
    await this.closeEffortMenu(page, currentEffort);
    await settleChatGptUi();
    // While open, the trigger reads "Thinking effort", not the selected value. Read its
    // closed label and reopen the menu once to prove the selection survived the commit.
    const selectedMode: SelectedChatGptWebModelMode = {
      ...mode,
      ...(modelFamily ? { modelFamily } : {}),
      selection: { url: selectionUrl, label: (await currentEffort.innerText()).trim() },
    };
    await this.assertSelectedEffort(page, selectedMode, false);
    const confirmation = await activateChatGptEffortMenu(page, currentEffort);
    await confirmation.slider.waitFor({ state: "attached", timeout: 5_000 });
    const confirmedState = await readAvailableEffort(confirmation.sliderContainer, confirmation.menu);
    if (confirmedState.min !== initialMin || confirmedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT did not persist the requested effort after closing its menu");
    }
    if (modelFamily) await assertChatGptModelFamily(confirmation, modelFamily, mode.effort, uiEffortIndex, 1_000);
    // A bare 'Pro' trigger does not identify the family selected by ChatGPT's Latest option.
    // Unknown evidence remains visible as unclassified Pro usage in Limits.
    if (trackUsage) {
      selectedMode.usageModel = await readChatGptUsageModel(confirmation.slider, mode.effort === "max")
        .catch(() => mode.effort === "max" ? "pro-unknown" as const : "other" as const);
    }
    await this.closeEffortMenu(page, currentEffort);
    await settleChatGptUi();
    await this.assertSelectedEffort(page, selectedMode, false);
    await captureDiagnostic?.("effort-selection-confirmed");
    this.lastSelectedModel = selectedMode;
    return selectedMode;
  }

  private async assertSelectedEffort(page: Page, mode: SelectedChatGptWebModelMode, verifyFamily = true, traceId?: string): Promise<void> {
    if (!mode.selection) return;
    const composer = await this.activeComposer(page);
    const controls = composer.locator("xpath=ancestor::form[1]")
      .locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
    const urlMatches = page.url() === mode.selection.url;
    let controlCount: number | undefined;
    if (!urlMatches || !mode.selection.label || (controlCount = await controls.count()) !== 1) {
      console.warn(`[chatgpt-web] selected_effort_failure=${JSON.stringify({
        traceId, phase: "surface", urlMatches, controlCount: controlCount ?? null, labelPresent: Boolean(mode.selection.label),
      })}`);
      throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the selected model's browser surface before submission");
    }
    const control = controls.first();
    const [label, expanded, editable] = await Promise.all([
      control.innerText(), control.getAttribute("aria-expanded"), composer.isEditable(),
    ]);
    if (label.trim() !== mode.selection.label || expanded !== "false" || !editable) {
      console.warn(`[chatgpt-web] selected_effort_failure=${JSON.stringify({
        traceId, phase: "selection", labelMatches: label.trim() === mode.selection.label,
        expandedClosed: expanded === "false", composerEditable: editable,
      })}`);
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT did not retain the selected effort in its ready composer; the message was not submitted",
      );
    }
    if (verifyFamily && mode.modelFamily && mode.uiEffortIndex !== null
      && !chatGptModelFamilyMatches([mode.selection.label], mode.modelFamily, mode.effort)) {
      const menu = await activateChatGptEffortMenu(page, control);
      try {
        await assertChatGptModelFamily(menu, mode.modelFamily, mode.effort, mode.uiEffortIndex);
      } finally {
        try {
          await this.closeEffortMenu(page, control);
        } catch (error) {
          console.warn(`[chatgpt-web] selected_effort_failure=${JSON.stringify({ traceId, phase: "family-close" })}`);
          throw error;
        }
      }
      if (page.url() !== mode.selection.url || (await control.innerText()).trim() !== mode.selection.label
        || await control.getAttribute("aria-expanded") !== "false" || !await composer.isEditable()) {
        console.warn(`[chatgpt-web] selected_effort_failure=${JSON.stringify({ traceId, phase: "family" })}`);
        throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the model while checking its family before submission");
      }
    }
  }

  private async activeComposer(
    page: Page, timeoutMs = 30_000, signal?: AbortSignal, operation?: ChatGptPromptOperation,
  ): Promise<Locator> {
    const parent = operation ?? new ChatGptPromptOperation(signal);
    const op = parent.budget(timeoutMs);
    op.check();
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    let count = 0;
    while (op.timeLeft() > 0) {
      count = await op.read(() => composers.count(), timeoutMs);
      if (count === 1) return composers.first();
      await op.poll(50);
    }
    parent.check();
    throw new Error(`ChatGPT did not expose exactly one visible composer (visibleComposers=${count})`);
  }

  /** Prepare a new conversation; account inspection still uses an empty Temporary Chat. */
  private async prepareChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    useSavedChats = false,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    throwIfPromptAttachmentAborted(abortSignal);
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    const targetUrl = chatGptNewChatUrl(useSavedChats);
    if (page.url() !== targetUrl) {
      await withBrowserTurnAbort(page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      }), abortSignal);
      await captureDiagnostic?.(useSavedChats ? "saved-chat-navigation-complete" : "temporary-chat-navigation-complete");
    }
    // A page-read failure is not proof that authentication expired. Preserve the actual
    // observation error; the authenticated-session check below owns login failures.
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    throwIfPromptAttachmentAborted(abortSignal);
    if (!useSavedChats && await dismissChatGptTemporaryChatOnboarding(page)) {
      await captureDiagnostic?.("temporary-chat-onboarding-dismissed");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertNewChatPage(page, useSavedChats);
    await captureDiagnostic?.("session-verified");
    return composer;
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 50): Promise<void> {
    await page.evaluate(({ timeout, attributeFilter }) => new Promise<void>(resolveMutation => {
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolveMutation();
      };
      const observer = new MutationObserver(() => {
        if (settleTimer) return;
        // Let one React mutation batch finish before the next compact state read.
        settleTimer = setTimeout(finish, 16);
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter,
      });
      const timeoutTimer = setTimeout(finish, timeout);
    }), { timeout: timeoutMs, attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES] });
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    const domMutation = this.waitForTurnDomMutation(page);
    if (!externalProgress) {
      await withBrowserTurnAbort(domMutation, signal);
      return;
    }
    const progressWaitAbort = new AbortController();
    const progressSignal = signal
      ? AbortSignal.any([progressWaitAbort.signal, signal])
      : progressWaitAbort.signal;
    try {
      await withBrowserTurnAbort(Promise.race([
        domMutation,
        externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
      ]), signal);
    } finally {
      progressWaitAbort.abort();
    }
  }

  private async waitForSubmissionAccepted(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    responseTurn: Locator,
    initialUserTurnCount: number,
    initialResponseTurn: ChatGptAssistantTurnState,
    initialTurnIdentities: readonly string[],
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    initialBrokerActivityRevision = externalProgress?.snapshot().lastBrokerActivityRevision ?? 0,
    recoverObservation?: ChatGptObservationRecovery,
    baseline?: ChatGptSubmissionBaseline,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    return withChatGptPageObservationRecovery(page, async observationPage => {
      if (page !== observationPage) {
        page = observationPage;
        userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
        responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
        if (baseline) {
          baseline.userTurns = userTurns;
          baseline.responseTurns = responseTurns;
        }
        responseTurn = responseTurns.nth(initialResponseTurn.count);
      }
      for (;;) {
        if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
        const progress = externalProgress?.snapshot();
        if (progress && progress.lastToolBatchRevision > initialToolBatchRevision) return "mcp_tool_call";
        if (progress && (progress.lastBrokerActivityRevision ?? 0) > initialBrokerActivityRevision) {
          return "mcp_tool_call";
        }
        const observed = await observeChatGptTurnIdentityAfterSend(
          () => observeChatGptSubmission(async () => {
            await throwIfChatGptSessionFailureAlert(page);
            await throwIfChatGptRateLimitDialog(page);
            await throwIfChatGptTerminalErrorAlert(responseTurn);
            const snapshot = await Promise.all([
              readChatGptTurnIdentities(userTurns),
              readChatGptAssistantTurnState(responseTurns),
              page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count(),
              (async () => {
                if (!baseline?.initialPageUrl
                  || baseline.submissionRequestObserved?.() !== true
                  || !isTemporaryChatGptUrl(baseline.initialPageUrl)) return {};
                const currentPageUrl = page.url();
                if (isTemporaryChatGptUrl(currentPageUrl)
                  || !isTemporaryChatGptTurnUrl(currentPageUrl)) return { currentPageUrl };
                const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
                if (await composers.count() !== 1) return { currentPageUrl };
                return {
                  currentPageUrl,
                  composerTextLength: (await composers.first().evaluate(readChatGptPromptText)).length,
                };
              })(),
            ]);
            const [userIdentities, assistantTurn] = snapshot;
            const knownTurns = new Set(assistantTurn.knownTurnIdentities ?? []);
            if (userIdentities.some(identity => !knownTurns.has(identity))) {
              throw new ChatGptTurnIdentityAmbiguityError(
                "conversation",
                "ChatGPT user turn has no matching identity container",
              );
            }
            return snapshot;
          }, signal, externalProgress, progress?.revision ?? 0),
          settleChatGptUi,
          signal,
        );
        if (!observed) continue;
        const [userIdentities, assistantTurn, visibleStopButtonCount, navigation] = observed.value;
        if (baseline) {
          await this.reconcileMultipartHistory(page, baseline, {turnIdentities: assistantTurn.knownTurnIdentities ?? []}, signal);
          initialTurnIdentities = baseline.initialTurnIdentities;
        }
        const evidence = chatGptSubmissionEvidence({
          initialUserTurnCount,
          userTurnCount: userIdentities.length,
          initialAssistantTurnCount: initialResponseTurn.count,
          assistantTurnCount: assistantTurn.count,
          ...(initialResponseTurn.lastId ? { initialAssistantTurnId: initialResponseTurn.lastId } : {}),
          ...(assistantTurn.lastId ? { assistantTurnId: assistantTurn.lastId } : {}),
          initialTurnIdentities,
          userIdentities,
          responseIdentities: assistantTurn.identities ?? [],
          generationRunning: visibleStopButtonCount > 0,
          initialPageUrl: baseline?.initialPageUrl,
          currentPageUrl: navigation.currentPageUrl,
          composerTextLength: navigation.composerTextLength,
          submissionRequestObserved: baseline?.submissionRequestObserved?.() === true,
        });
        if (evidence) {
          if (evidence === "user_turn") {
            const identity = chatGptNewTurnIdentity(initialTurnIdentities, userIdentities);
            if (!identity) throw new Error("ChatGPT acknowledged the submission without a stable user turn identity");
            if (baseline?.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
              throw new Error("ChatGPT changed the user turn that acknowledged the submission");
            }
            if (baseline) baseline.acceptedUserIdentity = identity;
          }
          return evidence;
        }
        await observeChatGptSubmission(observationSignal => this.waitForTurnDomOrExternalProgress(
          page,
          progress?.revision ?? 0,
          externalProgress,
          observationSignal,
        ), signal);
      }
    }, recoverObservation, signal);
  }

  private async waitForNewAssistantTurn(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    responseDomGraceMs?: number,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptActivityTurnBinding>;
  private async waitForNewAssistantTurn(
    page: Page,
    responseTurns: Locator,
    initialResponseTurn: ChatGptAssistantTurnState,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    responseDomGraceMs?: number,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<Locator>;
  private async waitForNewAssistantTurn(
    page: Page,
    baselineOrResponseTurns: ChatGptSubmissionBaseline | Locator,
    initialResponseTurnOrDeadline: ChatGptAssistantTurnState | number | undefined,
    deadlineOrSignal?: number | AbortSignal,
    signalOrExternalProgress?: AbortSignal | ChatGptTurnProgressReader,
    externalProgressOrGrace?: ChatGptTurnProgressReader | number,
    responseDomGraceOrRecovery?: number | ChatGptObservationRecovery,
    recoverObservationArg?: ChatGptObservationRecovery,
  ): Promise<Locator | ChatGptActivityTurnBinding> {
    const baselineMode = "initialTurnIdentities" in baselineOrResponseTurns;
    const baseline = baselineMode ? baselineOrResponseTurns : undefined;
    let responseTurns = baseline?.responseTurns ?? baselineOrResponseTurns as Locator;
    const initialResponseTurn = baseline?.initialResponseTurn
      ?? (baselineMode
        ? { count: baseline!.initialResponseTurnCount, knownTurnIdentities: baseline!.initialTurnIdentities }
        : initialResponseTurnOrDeadline as ChatGptAssistantTurnState);
    const deadline = baselineMode
      ? initialResponseTurnOrDeadline as number | undefined
      : deadlineOrSignal as number | undefined;
    const signal = baselineMode
      ? deadlineOrSignal as AbortSignal | undefined
      : signalOrExternalProgress as AbortSignal | undefined;
    const externalProgress = baselineMode
      ? signalOrExternalProgress as ChatGptTurnProgressReader | undefined
      : externalProgressOrGrace as ChatGptTurnProgressReader | undefined;
    const responseDomGraceMs = ((baselineMode ? externalProgressOrGrace : responseDomGraceOrRecovery) as number | undefined)
      ?? CHATGPT_RESPONSE_DOM_GRACE_MS;
    const recoverObservation = (baselineMode ? responseDomGraceOrRecovery : recoverObservationArg) as
      ChatGptObservationRecovery | undefined;
    let responseDeadline = Math.min(
      deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + responseDomGraceMs,
    );
    return withChatGptPageObservationRecovery(page, async observationPage => {
      if (page !== observationPage) {
        page = observationPage;
        responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
        if (baseline) {
          baseline.responseTurns = responseTurns;
          baseline.userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
        }
      }
      for (;;) {
        if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
        if (page.isClosed()) throw chatGptBrowserTabClosedError();
        if (deadline !== undefined && Date.now() >= deadline) throw new Error("ChatGPT web turn timed out");
        const progress = externalProgress?.snapshot();
        const observed = await observeChatGptTurnIdentityAfterSend(
          () => observeChatGptSubmission(async () => {
            await throwIfChatGptSessionFailureAlert(page);
            await throwIfChatGptRateLimitDialog(page);
            return Promise.all([
              readChatGptAssistantTurnState(responseTurns),
              page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count(),
            ]);
          }, signal, externalProgress, progress?.revision ?? 0),
          settleChatGptUi,
          signal,
        );
        if (!observed) continue;
        const [current, visibleStopButtonCount] = observed.value;
        if (baseline) {
          await this.reconcileMultipartHistory(page, baseline, {turnIdentities: current.knownTurnIdentities ?? []}, signal);
          initialResponseTurn.knownTurnIdentities = baseline.initialTurnIdentities;
        }
        const binding = bindChatGptAssistantTurn(initialResponseTurn, current);
        if (binding) {
          const locator = locateChatGptAssistantTurn(responseTurns, binding);
          if (!baselineMode) return locator;
          return {
            identity: binding.id,
            locator,
            acceptedTurnIdentities: current.knownTurnIdentities ?? baseline!.initialTurnIdentities,
          };
        }
        const latestProgress = externalProgress?.snapshot();
        if (visibleStopButtonCount > 0 || chatGptExternalProgressSuppressesDomHealth(latestProgress, Date.now())) {
          responseDeadline = Math.min(
            deadline ?? Number.POSITIVE_INFINITY,
            Date.now() + responseDomGraceMs,
          );
        } else if (Date.now() >= responseDeadline) {
          throw new Error("ChatGPT accepted the message but did not expose its assistant turn in the DOM");
        }
        await observeChatGptSubmission(observationSignal => this.waitForTurnDomOrExternalProgress(
          page,
          latestProgress?.revision ?? 0,
          externalProgress,
          observationSignal,
        ), signal);
      }
    }, recoverObservation, signal);
  }

  private async sendAttachedPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    initialResponseTurn: ChatGptAssistantTurnState,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    onSendActivated?: () => void | Promise<void>,
    externalProgress?: ChatGptTurnProgressReader,
    recoverObservation?: ChatGptObservationRecovery,
    expectedPrompt?: string,
    insertionPlan?: ChatGptPromptInsertionPlan,
  ): Promise<ChatGptSubmissionEvidence> {
    const composer = await this.activeComposer(page);
    const sendButton = composer
      .locator("xpath=ancestor::form[1]")
      .locator(CHATGPT_SEND_BUTTON_SELECTOR);
    await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
    let sendEnableDeadline: number | undefined;
    for (;;) {
      if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      if (await sendButton.isEnabled()) break;
      if (sendEnableDeadline !== undefined && Date.now() >= sendEnableDeadline) {
        await captureDiagnostic?.("send-disabled");
        throw new Error("ChatGPT send button remained disabled after the complete prompt was attached");
      }
      await settleChatGptUi();
      sendEnableDeadline ??= Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
    }
    if (expectedPrompt !== undefined) {
      const preserveLeading = chatGptPromptPreservesLeading(insertionPlan ?? planChatGptPromptInsertion(expectedPrompt, {
        candidatePlainText: this.config?.experimentalComposerPlainText === true,
      }));
      await this.assertPromptAttached(page, expectedPrompt, abortSignal, undefined, preserveLeading);
    }
    await captureDiagnostic?.("send-ready");
    await onSendActivated?.();
    initialResponseTurn = baseline.initialResponseTurn ?? initialResponseTurn;
    const initialProgress = externalProgress?.snapshot();
    const initialToolBatchRevision = initialProgress?.lastToolBatchRevision ?? 0;
    const initialBrokerActivityRevision = initialProgress?.lastBrokerActivityRevision ?? 0;
    await activateChatGptSendControl(
      sendButton,
      abortSignal,
      baseline.activateSubmissionRequestObservation,
    );
    return this.waitForSubmissionAccepted(
      page,
      baseline.userTurns,
      baseline.responseTurns,
      baseline.responseTurns.nth(initialResponseTurn.count),
      baseline.initialUserTurnCount,
      initialResponseTurn,
      baseline.initialTurnIdentities,
      abortSignal,
      externalProgress,
      initialToolBatchRevision,
      initialBrokerActivityRevision,
      recoverObservation,
      baseline,
    );
  }

  private async waitForMultipartAcknowledgement(
    page: Page,
    responseTurn: Locator,
    stage: PreparedChatGptWebMultipartTransport["stages"][number],
    deadline: number | undefined,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
  ): Promise<void> {
    const completionTracker = new ChatGptCompletionTracker();
    const domHealthTracker = new ChatGptTurnDomHealthTracker(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS);
    for (;;) {
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      if (abortSignal?.aborted) {
        const stop = chatGptStopButton(page);
        if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
        throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT Bigger Context transaction timed out while awaiting a stage acknowledgement");
      }
      await throwIfChatGptSessionFailureAlert(page);
      const running = await chatGptStopButton(page).isVisible().catch(() => false);
      const snapshot = await this.responseDomSnapshot(responseTurn, undefined, running);
      const progress = externalProgress?.snapshot();
      if (externalProgress
        && progress
        && completionTracker.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, settledPreToolAnswerText(snapshot, running));
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(progress, Date.now());
      if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
      await throwIfChatGptTerminalErrorAlert(
        responseTurn,
        snapshot.completionActionVisible && snapshot.visibleText.length > 0,
      );
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
      });
      if (domError) throw chatGptResponseIncompleteError(domError);
      const completion = completionTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        currentHtml: snapshot.fullHtml,
        completionActionVisible: snapshot.completionActionVisible,
        projection: snapshot.projection,
        externalProgressLive,
        externalToolCallsInFlight: chatGptExternalToolCallsAreInFlight(progress),
      });
      if (completion.status === "complete") {
        const actual = snapshot.visibleText.trim();
        if (actual !== stage.acknowledgement) {
          throw new ChatGptWebAdapterError(
            `ChatGPT Bigger Context stage returned ${actual.length.toLocaleString("en-US")} characters instead of its exact acknowledgement. The staged task was not committed and will not be retried automatically.`,
            {
              status: 502,
              errorType: "server_error",
              code: "multipart_protocol_violation",
              retryable: false,
              retireSession: true,
            },
          );
        }
        return;
      }
      if (completion.status === "stalled") {
        throw new ChatGptWebAdapterError(
          `ChatGPT Bigger Context acknowledgement projection stopped before completion (${JSON.stringify(completion.diagnostic)})`,
          {
            status: 502,
            errorType: "server_error",
            code: "multipart_protocol_violation",
            retryable: false,
            retireSession: true,
          },
        );
      }
      await this.waitForTurnDomOrExternalProgress(
        page,
        progress?.revision ?? 0,
        externalProgress,
        abortSignal,
      );
    }
  }

  private async reconcileMultipartHistory(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    state: {turnIdentities: readonly string[]},
    signal?: AbortSignal,
  ): Promise<void> {
    const stages = baseline.acknowledgedStages;
    if (!stages?.length) return;
    for (const stage of stages) {
      if (stage.identities.filter(identity => state.turnIdentities.includes(identity)).length > 1) {
        throw new Error("ChatGPT duplicated an acknowledged Bigger Context exchange");
      }
    }
    const known = new Set(baseline.initialTurnIdentities);
    const candidates = state.turnIdentities.filter(identity => identity.startsWith("group:assistant:")
      && !known.has(identity));
    for (const identity of candidates) {
      const previousStage = stages.find(stage => stage.identities.includes(identity));
      if (previousStage) {
        known.add(identity);
        known.add(`group:user:${identity.slice("group:assistant:".length)}`);
        continue;
      }
      // A newly submitted group already has a user bubble while its assistant area may
      // not exist yet. Inspect the existing group; waiting for an assistant here turns
      // normal response startup into repeated DOM observation timeouts.
      const locator = page.locator(`[data-turn-key=${JSON.stringify(identity.slice("group:assistant:".length))}]`);
      const text = await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(locator.evaluate(group => {
        const bubbles = group.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
        const contents = bubbles.length === 1
          ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]") : [];
        return contents.length === 1 ? contents[0]!.innerText.replace(/\r\n?/g, "\n") : undefined;
      }), signal));
      // Only this transaction's already completed stages may acquire a new identity. A
      // matching acknowledgement alone cannot prove that the uploaded context survived.
      const snapshot = await this.responseDomSnapshot(locator);
      const stage = stages.find(candidate => candidate.text.replace(/\r\n?/g, "\n") === text);
      const ackStage = stages.find(candidate => candidate.acknowledgement === snapshot.visibleText.trim());
      if (!stage && !ackStage) continue;
      if (!stage || stage !== ackStage || !snapshot.completionActionVisible) {
        throw new Error("ChatGPT changed an acknowledged Bigger Context exchange");
      }
      if (stage.identities.some(previous => state.turnIdentities.includes(previous))) {
        throw new Error("ChatGPT duplicated an acknowledged Bigger Context exchange");
      }
      stage.identities.push(identity);
      known.add(identity);
      known.add(`group:user:${identity.slice("group:assistant:".length)}`);
    }
    baseline.initialTurnIdentities = [...known];
  }

  private async captureSubmissionBaseline(
    page: Page,
    submittedText?: string,
    previousOrStages?: ChatGptSubmissionBaseline | readonly ChatGptAcknowledgedMultipartStage[],
  ): Promise<ChatGptSubmissionBaseline> {
    const previous = Array.isArray(previousOrStages) ? undefined : previousOrStages as ChatGptSubmissionBaseline | undefined;
    const stages = Array.isArray(previousOrStages) ? previousOrStages : previous?.acknowledgedStages ?? [];
    const initialPageUrl = page.url();
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const [userIdentities, initialResponseTurn] = await Promise.all([
      readChatGptTurnIdentities(userTurns),
      readChatGptAssistantTurnState(responseTurns),
    ]);
    const initialTurnIdentities = initialResponseTurn.knownTurnIdentities ?? [
      ...userIdentities, ...(initialResponseTurn.identities ?? []),
    ];
    if (initialPageUrl !== page.url() || (previous && previous.initialPageUrl !== initialPageUrl)) {
      throw new ChatGptWebAdapterError("ChatGPT history changed before Send: browser surface changed", {
        status: 502, errorType: "server_error", code: "chatgpt_submission_ambiguous", retryable: false, retireSession: true,
      });
    }
    const reconciliationBaseline = previous ?? { initialTurnIdentities: [], acknowledgedStages: stages } as unknown as ChatGptSubmissionBaseline;
    await this.reconcileMultipartHistory(page, reconciliationBaseline, {turnIdentities: initialTurnIdentities});
    if (previous) {
      assertChatGptPreSendHistory(previous.initialTurnIdentities, initialTurnIdentities);
    }
    return {
      userTurns,
      responseTurns,
      acknowledgedStages: stages,
      initialUserTurnCount: userIdentities.length,
      initialResponseTurnCount: initialResponseTurn.count,
      initialTurnIdentities,
      initialPageUrl,
      initialResponseTurn,
      submittedText,
    };
  }

  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptActivityTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptActivityTurnBinding> {
    const boundCount = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(binding.locator.count(), signal),
    );
    if (boundCount === 1) return binding;
    if (boundCount > 1) {
      throw new Error(`ChatGPT exposed ${boundCount} DOM nodes for the bound assistant turn`);
    }

    const [assistantTurn, userIdentities] = await Promise.all([
      readChatGptAssistantTurnState(page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR)),
      readChatGptTurnIdentities(page.locator(CHATGPT_USER_TURN_SELECTOR)),
    ]);
    await this.reconcileMultipartHistory(page, baseline, {turnIdentities: assistantTurn.knownTurnIdentities ?? []}, signal);
    const identity = chatGptReboundTurnIdentity(
      baseline.initialTurnIdentities,
      binding.identity,
      assistantTurn.identities ?? [],
    );
    if (!identity || identity === binding.identity) return binding;

    const acceptedTurns = new Set([...binding.acceptedTurnIdentities, ...baseline.initialTurnIdentities]);
    const currentTurns = assistantTurn.knownTurnIdentities ?? [];
    const newUsers = userIdentities.filter(candidate => !acceptedTurns.has(candidate));
    if (newUsers.length > 0) {
      const user = newUsers[0]!;
      const replacement = newUsers.length === 1
        && binding.identity.startsWith("group:assistant:")
        && user.startsWith("group:user:")
        && identity === `group:assistant:${user.slice("group:user:".length)}`
        && !currentTurns.includes(binding.identity)
        && currentTurns.every(turn => acceptedTurns.has(turn) || turn === user || turn === identity);
      let matches = false;
      if (replacement) {
        const locator = page.locator(chatGptAssistantTurnSelector(identity));
        matches = baseline.acceptedUserIdentity
          ? user === baseline.acceptedUserIdentity
          : Boolean(baseline.submittedText) && await withChatGptBrowserObservationTimeout(
            withBrowserTurnAbort(locator.evaluate((group, submitted) => {
              const bubbles = group.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
              const contents = bubbles.length === 1
                ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]")
                : [];
              const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
              return contents.length === 1
                && normalize(contents[0]!.innerText) === normalize(submitted);
            }, baseline.submittedText!), signal),
          );
        // The accepted user identity (or exact submitted text) establishes ownership.
        // Activity can replace its temporary group while still generating; requiring
        // a completed answer here mistakes that same unfinished turn for a foreign one.
      }
      if (!matches) {
        throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
      }
    } else if (currentTurns.includes(binding.identity)
      || !currentTurns.every(turn => acceptedTurns.has(turn) || turn === identity
        || (identity.startsWith("group:assistant:")
          && turn === `group:user:${identity.slice("group:assistant:".length)}`
          && !userIdentities.includes(turn)))) {
      throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
    }

    return {
      identity,
      locator: page.locator(chatGptAssistantTurnSelector(identity)),
      acceptedTurnIdentities: currentTurns,
    };
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
  ): Promise<ChatGptSubmissionEvidence | undefined>;
  private async currentSubmissionEvidence(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    initialTurnIdentities: readonly string[],
  ): Promise<ChatGptSubmissionEvidence | undefined>;
  private async currentSubmissionEvidence(
    page: Page,
    baselineOrUserTurns: ChatGptSubmissionBaseline | Locator,
    responseTurns?: Locator,
    initialTurnIdentities?: readonly string[],
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const baseline = "initialTurnIdentities" in baselineOrUserTurns ? baselineOrUserTurns : undefined;
    const userTurns = baseline?.userTurns ?? baselineOrUserTurns as Locator;
    const currentResponseTurns = baseline?.responseTurns ?? responseTurns!;
    let initial = baseline?.initialTurnIdentities ?? initialTurnIdentities!;
    const [userIdentities, assistantTurn, visibleStopButtonCount] = await Promise.all([
      readChatGptTurnIdentities(userTurns),
      readChatGptAssistantTurnState(currentResponseTurns),
      page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count(),
    ]);
    if (baseline) {
      await this.reconcileMultipartHistory(page, baseline, {turnIdentities: assistantTurn.knownTurnIdentities ?? []});
      initial = baseline.initialTurnIdentities;
    }
    const knownTurns = new Set(assistantTurn.knownTurnIdentities ?? []);
    if (userIdentities.some(identity => !knownTurns.has(identity))) {
      throw new Error("ChatGPT user turn has no matching identity container");
    }
    const evidence = chatGptSubmissionEvidence({
      initialUserTurnCount: 0,
      userTurnCount: userIdentities.length,
      initialAssistantTurnCount: 0,
      assistantTurnCount: assistantTurn.count,
      initialTurnIdentities: initial,
      userIdentities,
      responseIdentities: assistantTurn.identities ?? [],
      generationRunning: visibleStopButtonCount > 0,
    });
    if (baseline && evidence === "user_turn") {
      const identity = chatGptNewTurnIdentity(initial, userIdentities);
      if (!identity) throw new Error("ChatGPT acknowledged the submission without a stable user turn identity");
      if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      baseline.acceptedUserIdentity = identity;
    }
    return evidence;
  }

  private async currentSubmissionAnswerText(page: Page, baseline: ChatGptSubmissionBaseline): Promise<string> {
    const current = await readChatGptAssistantTurnState(page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR));
    await this.reconcileMultipartHistory(page, baseline, {turnIdentities: current.knownTurnIdentities ?? []});
    const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, current.identities ?? []);
    return identity ? (await this.responseDomSnapshot(page.locator(chatGptAssistantTurnSelector(identity)))).visibleText : "";
  }

  private async attachedPromptText(
    page: Page, signal?: AbortSignal, operation?: ChatGptPromptOperation,
    preserveLeading = false,
  ): Promise<string> {
    const op = operation ?? new ChatGptPromptOperation(signal);
    const composer = await this.activeComposer(page, 30_000, signal, op);
    return op.read(options => composer.evaluate(readChatGptPromptText,
      preserveLeading ? { preserveLeading: true } : undefined, options));
  }

  private async assertPromptAttached(
    page: Page, prompt: string, abortSignal?: AbortSignal, operation?: ChatGptPromptOperation,
    preserveLeading = false,
  ): Promise<void> {
    const parent = operation ?? new ChatGptPromptOperation(abortSignal);
    const op = parent.budget(10_000);
    let observed = "";
    while (op.timeLeft() > 0) {
      observed = await this.attachedPromptText(page, abortSignal, op, preserveLeading);
      op.check();
      if (this.promptTextEquivalent(prompt, observed)) return;
      await op.poll(50);
    }
    parent.check();
    throw chatGptPromptAttachmentMismatch(
      "ChatGPT composer did not preserve the complete prompt", prompt, observed,
      this.promptEquivalentPrefixLength(prompt, observed),
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator("xpath=ancestor::form[1]")
      .locator([
        `[data-id^="plugin:"][data-keyword=${JSON.stringify(this.config.appName)}]`,
        `[app-mention-path^="app://"][app-mention-display-name=${JSON.stringify(this.config.appName)}][contenteditable="false"]`,
      ].join(", "))
      .filter({ visible: true });
  }

  private async connectorIsSelected(composer: Locator, signal?: AbortSignal): Promise<boolean> {
    const selected = this.selectedConnectorControl(composer);
    const keywords = await withBrowserTurnAbort(selected.evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name"))
    )), signal);
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private async connectorMentionRowTitles(menuRows: Locator, signal?: AbortSignal): Promise<string[]> {
    let texts: string[];
    try {
      texts = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).allInnerTexts()),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      texts = [];
    }
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(
    menuRows: Locator,
    triggerAttempts: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const titles = await this.connectorMentionRowTitles(menuRows, signal);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && titles.includes(DEV_CHATGPT_CONNECTOR_NAME)) {
      return `ChatGPT exposes the isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)},`
        + ` but production requires a separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)};`
        + ` create ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the production tunnel and leave the DEV connector unchanged`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + "; create a connector with that exact name before retrying";
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    await runChatGptMutationCleanup(async signal => {
      const op = new ChatGptPromptOperation(signal).budget(5_000);
      await page.locator("body").press("Escape", op.options(5_000));
      const composer = await this.activeComposer(page, 5_000, signal, op);
      await clearChatGptComposerInput(composer, signal, op);
      await withBrowserTurnAbort(settleChatGptUi(), signal);
      const text = await composer.evaluate(
        element => element.textContent ?? "",
        undefined,
        op.options(5_000),
      );
      if (text.length > 0 || await this.connectorIsSelected(composer, signal)) {
        throw new Error("ChatGPT connector cleanup did not produce an empty composer");
      }
    });
  }

  private async ensureConnectorSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    proveConnectorAccess?: (signal: AbortSignal) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    await ensureChatGptPersonalizedConnectorAccess(
      page,
      captureDiagnostic,
      proveConnectorAccess,
      signal,
    );
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
    operation?: ChatGptPromptOperation,
  ): Promise<Locator> {
    const op = operation ?? new ChatGptPromptOperation(abortSignal);
    op.check();
    const capture = async (checkpoint: string): Promise<void> => {
      throwIfPromptAttachmentAborted(abortSignal);
      await withBrowserTurnAbort(captureDiagnostic?.(checkpoint) ?? Promise.resolve(), abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
    };
    const menuRows = page.locator(CHATGPT_CONNECTOR_MENTION_ROW_SELECTOR);
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    await this.ensureConnectorSurface(
      page,
      capture,
      async personalizationSignal => {
        const proof = new ChatGptPromptOperation(personalizationSignal, () => op.timeLeft(), op.now);
        let proofResult = false;
        let proofError: unknown;
        try {
          const composer = await this.activeComposer(page, 30_000, personalizationSignal, proof);
          await composer.fill("", proof.options(10_000));
          await composer.focus(proof.options(10_000));
          await withBrowserTurnAbort(settleChatGptUi(), personalizationSignal);
          await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, {
            delay: 25,
            ...proof.options(10_000),
          });
          try {
            await appResult.waitFor({ state: "visible", ...proof.options(2_500) });
            proofResult = true;
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
            const mention = await composer.evaluate(element => ({
              text: element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                ? element.value : element.textContent ?? "",
              focused: element === document.activeElement,
            }), undefined, proof.options(10_000));
            if (mention.text !== CHATGPT_CONNECTOR_MENTION_QUERY) {
              throw new ChatGptPromptAttachmentIntegrityError(
                `ChatGPT did not preserve the connector mention (expectedChars=${CHATGPT_CONNECTOR_MENTION_QUERY.length}, actualChars=${mention.text.length}, focused=${mention.focused})`,
              );
            }
            await this.clearChatGptComposerState(page);
            const plusResult = typeof page.getByTestId === "function"
              ? await openChatGptConnectorPlusMenu(page, this.config.appName, personalizationSignal)
              : undefined;
            proofResult = plusResult !== undefined;
          }
        } catch (error) {
          proofError = error;
        }
        try { await this.clearChatGptComposerState(page); }
        catch (cleanupError) {
          throw new ChatGptPersistentBrowserStateError(
            proofError === undefined ? [cleanupError] : [proofError, cleanupError],
            "ChatGPT connector proof did not leave a verified empty composer",
          );
        }
        if (proofError !== undefined) throw proofError;
        return proofResult;
      },
      abortSignal,
    );
    let composer = await this.activeComposer(page, 30_000, abortSignal, op);
    try {
      if (await this.connectorIsSelected(composer, abortSignal)) {
        if ((await this.attachedPromptText(page, abortSignal, op)).length === 0) {
          await capture("connector-already-selected");
          return composer;
        }
        // A restored draft can include both the connector and an earlier request. Selecting
        // that pill proves the connector, not an empty composer. Reset the owned draft before
        // attaching this request so it cannot be appended to the previous one.
        await this.clearChatGptComposerState(page);
        throwIfPromptAttachmentAborted(abortSignal);
        composer = await this.activeComposer(page, 30_000, abortSignal, op);
      }
      await composer.fill("", op.options(10_000));

      const activateConnectorChoice = async (control: Locator): Promise<Locator> => {
        await control.press("Enter", op.options(10_000));
        await capture("connector-choice-activated");
        const selectedComposer = await this.activeComposer(page, 30_000, abortSignal, op);
        const selectedConnector = this.selectedConnectorControl(selectedComposer);
        await selectedConnector.waitFor({ state: "visible", ...op.options(10_000) });
        if (!await this.connectorIsSelected(selectedComposer, abortSignal)) {
          throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
        }
        await capture("connector-selected");
        return selectedComposer;
      };

      let firstMenuCaptured = false;
      let mentionMenuVisible = false;
      let mentionFailure: string | undefined;
      while (attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        composer = await this.activeComposer(page, 30_000, abortSignal, op);
        await composer.fill("", op.options(10_000));
        await composer.focus(op.options(10_000));
        await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
        await composer.pressSequentially(CHATGPT_CONNECTOR_MENTION_QUERY, { delay: 25, ...op.options(10_000) });
        if (!firstMenuCaptured) {
          firstMenuCaptured = true;
          await capture("connector-mention-triggered");
        }
        try {
          await appResult.waitFor({ state: "visible", ...op.options(2_500) });
          await capture("connector-menu-visible");
          mentionMenuVisible = true;
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          const visibleRows = await this.connectorMentionRowTitles(menuRows, abortSignal);
          const knownIdentityMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
            && (visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME)
              || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => visibleRows.includes(name)));
          if (knownIdentityMismatch) {
            mentionFailure = await this.connectorMentionFailure(
              menuRows,
              attemptBudget.triggerAttempts,
              abortSignal,
            );
            break;
          }
          if (catalogRefreshAvailable
            && visibleRows.length > 0
            && !visibleRows.includes(this.config.appName)
            && attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            throw new ChatGptConnectorCatalogStaleError(this.config.appName, attemptBudget.triggerAttempts);
          }
          if (attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            break;
          }
        }
      }
      if (!mentionMenuVisible) {
        mentionFailure ??= await this.connectorMentionFailure(
          menuRows,
          attemptBudget.triggerAttempts,
          abortSignal,
        );
        await this.clearChatGptComposerState(page);
        const plusResult = typeof page.getByTestId === "function"
          ? await openChatGptConnectorPlusMenu(page, this.config.appName, abortSignal)
          : undefined;
        if (plusResult) {
          await capture("connector-menu-visible");
          return await activateConnectorChoice(plusResult);
        }
        await capture("connector-menu-missing");
        throw chatGptConnectorUnavailableError(mentionFailure);
      }
      const exactResultCount = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(appResult.count()),
        abortSignal,
      );
      if (exactResultCount !== 1) {
        throw chatGptConnectorUnavailableError(
          `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
          + ` after ${attemptBudget.triggerAttempts} complete mention trigger attempt(s)`,
        );
      }
      const rowHighlighted = async () => chatGptConnectorMentionRowHighlighted(appResult, op.options(10_000));
      if (!await rowHighlighted()) {
        const visibleRowCount = await withBrowserTurnAbort(
          withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
          abortSignal,
        );
        for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
          await composer.press("ArrowDown", op.options(10_000));
        }
      }
      if (!await rowHighlighted()) {
        throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.config.appName)}`);
      }
      return await activateConnectorChoice(composer);
    } catch (error) {
      try { await this.clearChatGptComposerState(page); }
      catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT connector selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    requireThink = false,
    largeStructuredDirect = false,
    forceStructuredDirect = false,
    beforeRecoveryInsertion?: (composer: Locator) => Promise<boolean | void>,
    diagnosticContext?: { traceId: string; stage: string; operation?: ChatGptPromptOperation; insertionPlan?: ChatGptPromptInsertionPlan; candidateBudget?: ChatGptCandidateAttachmentBudget; preparedPrefix?: string },
  ): Promise<void> {
    await throwIfChatGptRateLimitDialog(page);
    const parent = diagnosticContext?.operation ?? new ChatGptPromptOperation(abortSignal);
    const insertionText = localTools ? ` ${prompt}` : prompt;
    const insertionPlan = diagnosticContext?.insertionPlan ?? planChatGptPromptInsertion(insertionText, {
      largeStructuredDirect, forceStructuredDirect,
      candidatePlainText: this.config?.experimentalComposerPlainText === true,
    });
    const candidateBudget = diagnosticContext?.candidateBudget
      ?? new ChatGptCandidateAttachmentBudget(insertionPlan, parent.now);
    const op = candidateBudget
      ? new ChatGptPromptOperation(abortSignal, () => Math.min(parent.timeLeft(), candidateBudget.remainingMs()), parent.now)
      : parent;
    diagnosticContext = { ...diagnosticContext, traceId: diagnosticContext?.traceId ?? "unscoped",
      stage: diagnosticContext?.stage ?? "prompt_attachment", operation: op, insertionPlan, candidateBudget };
    op.check();
    let mutationStarted = false;
    try {
      if (forceStructuredDirect) await captureDiagnostic?.("retained-compaction-direct-insertion");
      if (localTools && diagnosticContext.preparedPrefix && insertionText.startsWith(diagnosticContext.preparedPrefix)) {
        const composer = await this.activeComposer(page, 30_000, abortSignal, op);
        const observed = await this.attachedPromptText(page, abortSignal, op, true);
        if (this.promptTextEquivalent(diagnosticContext.preparedPrefix, observed)
          && await this.connectorIsSelected(composer, abortSignal)) {
          mutationStarted = true;
          await this.insertPromptText(page, insertionText, abortSignal, false, false, diagnosticContext, true);
          await this.assertPromptAttached(page, insertionText, abortSignal, op, true);
          return;
        }
      }
      diagnosticContext.preparedPrefix = undefined;
      if (!localTools) {
        const composer = await this.activeComposer(page, 30_000, abortSignal, op);
        // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
        // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
        // then transport the complete text through verified CDP edits.
        if (!beforeRecoveryInsertion) {
          mutationStarted = true;
          await op.mutate(options => composer.fill("", options), 10_000);
        }
        if (requireThink) {
          await setChatGptThinkMode(composer, true, captureDiagnostic, abortSignal);
        }
        await op.mutate(options => composer.focus(options));
        op.check();
        if (await beforeRecoveryInsertion?.(composer) === false) return;
        op.check();
        mutationStarted = true;
        await this.insertPromptText(page, prompt, abortSignal, largeStructuredDirect, forceStructuredDirect, diagnosticContext);
        await this.assertPromptAttached(page,
          chatGptPromptPreservesLeading(insertionPlan) ? insertionText : prompt,
          abortSignal, op, chatGptPromptPreservesLeading(insertionPlan));
        return;
      }
      // Recheck the stopped response before mention selection mutates the composer.
      // The owned Send guard rechecks it again atomically before any submission.
      if (beforeRecoveryInsertion) {
        const composer = await this.activeComposer(page, 30_000, abortSignal, op);
        if (await beforeRecoveryInsertion(composer) === false) return;
      }
      if (requireThink) {
        const composer = await this.activeComposer(page, 30_000, abortSignal);
        mutationStarted = true;
        await composer.fill("", { signal: abortSignal, timeout: 10_000 });
        await setChatGptThinkMode(composer, true, captureDiagnostic, abortSignal);
      }
      // A retained tab preserves history, but ChatGPT can require the plugin on each new
      // message. Reuse an existing selected pill only when selectConnector verifies it here.
      const selectedComposer = await this.selectConnector(
        page,
        captureDiagnostic,
        catalogRefreshAvailable,
        connectorAttemptBudget,
        abortSignal,
        op,
      );
      mutationStarted = true;
      if (requireThink) {
        const controls = selectedComposer.locator("xpath=ancestor::form[1]")
          .getByRole("button", { name: /^(?:Think|Analyser)$/, exact: true }).filter({ visible: true });
        if (await controls.count() !== 1 || await controls.first().getAttribute("aria-pressed", {
          signal: abortSignal, timeout: 10_000,
        }) !== "true") {
          throw new Error("ChatGPT connector selection did not preserve Think mode");
        }
      }
      await op.mutate(options => selectedComposer.focus(options));
      await op.mutate(() => page.keyboard.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY));
      await this.insertPromptText(page, ` ${prompt}`, abortSignal, largeStructuredDirect, forceStructuredDirect, diagnosticContext, true);
      await this.assertPromptAttached(page,
        chatGptPromptPreservesLeading(insertionPlan) ? insertionText : prompt,
        abortSignal, op, chatGptPromptPreservesLeading(insertionPlan));
    } catch (error) {
      if (!mutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try { await this.clearChatGptComposerState(page); }
      catch (cleanupError) {
        if (isChatGptPromptIntegrityMismatch(error)) {
          throw new ChatGptPromptIntegrityMismatchError(
            `${error.message}; composer cleanup could not be verified; the failed surface must be retired`,
            new AggregateError([error, cleanupError]),
          );
        }
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT prompt attachment failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async resetCompactionComposerForRetry(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
    operation?: ChatGptPromptOperation,
  ): Promise<void> {
    const op = operation ?? new ChatGptPromptOperation(abortSignal);
    op.check();
    const before = await this.currentSubmissionEvidence(
      page,
      baseline.userTurns,
      baseline.responseTurns,
      baseline.initialTurnIdentities,
    );
    if (before) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT exposed ${before} after compaction prompt attachment failed; refusing a duplicate submission`,
      );
    }

    const composer = await this.activeComposer(page, 30_000, abortSignal, op);
    await op.mutate(options => composer.fill("", options));
    await op.mutate(options => composer.focus(options));
    await op.poll(CHATGPT_UI_SETTLE_MS);
    throwIfPromptAttachmentAborted(abortSignal);

    const after = await this.currentSubmissionEvidence(
      page,
      baseline.userTurns,
      baseline.responseTurns,
      baseline.initialTurnIdentities,
    );
    if (after) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT exposed ${after} while resetting a failed compaction prompt; refusing a duplicate submission`,
      );
    }
    const observed = await this.attachedPromptText(page, abortSignal, op);
    if (observed.length > 0) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT composer could not reset cleanly for compaction retry (actualChars=${observed.length})`,
      );
    }
  }

  private async attachPromptWithCompactionRetry(
    page: Page,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    requireThink = false,
    largeStructuredDirect = false,
    forceStructuredDirect = false,
    beforeRecoveryInsertion?: (composer: Locator) => Promise<boolean | void>,
    diagnosticContext?: { traceId: string; stage: string; operation?: ChatGptPromptOperation; insertionPlan?: ChatGptPromptInsertionPlan; candidateBudget?: ChatGptCandidateAttachmentBudget; preparedPrefix?: string },
  ): Promise<void> {
    // One deadline owner covers the existing initial + at most one safe compaction repair.
    // Neither reset nor a second attachment gets a fresh candidate hard budget.
    {
      const parent = diagnosticContext?.operation ?? new ChatGptPromptOperation(abortSignal);
      const insertionPlan = diagnosticContext?.insertionPlan ?? planChatGptPromptInsertion(
        localTools ? ` ${prompt}` : prompt,
        { largeStructuredDirect, forceStructuredDirect, candidatePlainText: true },
      );
      const candidateBudget = diagnosticContext?.candidateBudget
        ?? new ChatGptCandidateAttachmentBudget(insertionPlan, parent.now);
      const operation = new ChatGptPromptOperation(abortSignal,
        () => Math.min(parent.timeLeft(), candidateBudget.remainingMs()), parent.now);
      diagnosticContext = { ...diagnosticContext, traceId: diagnosticContext?.traceId ?? "unscoped",
        stage: diagnosticContext?.stage ?? "prompt_attachment", operation, insertionPlan, candidateBudget };
    }
    let retryAvailable = compaction;
    for (;;) {
      try {
        await this.attachPrompt(
          page,
          prompt,
          localTools,
          captureDiagnostic,
          abortSignal,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          requireThink,
          largeStructuredDirect,
          forceStructuredDirect,
          beforeRecoveryInsertion,
          diagnosticContext,
        );
        return;
      } catch (error) {
        if (!retryAvailable || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
        retryAvailable = false;
        const evidence = await this.currentSubmissionEvidence(
          page,
          baseline.userTurns,
          baseline.responseTurns,
          baseline.initialTurnIdentities,
        );
        if (evidence) {
          throw new ChatGptPromptAttachmentIntegrityError(
            `${error.message}; ChatGPT exposed ${evidence}, so the bridge refused to insert or send the compaction prompt again`,
          );
        }
        await captureDiagnostic?.("prompt-attachment-integrity-retry");
        await this.resetCompactionComposerForRetry(page, baseline, abortSignal, diagnosticContext?.operation);
        connectorAttemptBudget.triggerAttempts = 0;
      }
    }
  }

  private async reanchorPromptCaret(page: Page, abortSignal?: AbortSignal, operation?: ChatGptPromptOperation): Promise<void> {
    const op = operation ?? new ChatGptPromptOperation(abortSignal);
    op.check();
    const composer = await this.activeComposer(page, 30_000, abortSignal, op);
    let anchored = false;
    try {
      anchored = await reanchorChatGptComposerCaret(composer, 2, abortSignal, op);
    } catch (error) {
      throwIfPromptAttachmentAborted(abortSignal);
      if (error instanceof ChatGptWebAdapterError || error instanceof ChatGptPersistentBrowserStateError) throw error;
      throw chatGptWebSurfaceError("ChatGPT composer caret re-anchor failed", false);
    }
    throwIfPromptAttachmentAborted(abortSignal);
    if (!anchored) {
      throw chatGptWebSurfaceError(
        "ChatGPT composer could not re-anchor the prompt caret at the logical document end",
        false,
      );
    }
  }

  private async insertPromptText(
    page: Page,
    text: string,
    abortSignal?: AbortSignal,
    largeStructuredDirect = false,
    forceStructuredDirect = false,
    diagnosticContext?: { traceId: string; stage: string; operation?: ChatGptPromptOperation; insertionPlan?: ChatGptPromptInsertionPlan; candidateBudget?: ChatGptCandidateAttachmentBudget; preparedPrefix?: string },
    connectorSelected = false,
  ): Promise<void> {
    const op = diagnosticContext?.operation ?? new ChatGptPromptOperation(abortSignal);
    const insertionPlan = diagnosticContext?.insertionPlan ?? planChatGptPromptInsertion(text, {
      largeStructuredDirect, forceStructuredDirect,
      candidatePlainText: this.config?.experimentalComposerPlainText === true,
    });
    // The writer verifies a supplied warm prefix before any paste. Reading it
    // here too cannot establish additional evidence for the later mutation.
    const existingText = connectorSelected && !diagnosticContext?.preparedPrefix
      ? await this.attachedPromptText(page, abortSignal, op, true) : "";
    await insertChatGptPromptText(text, abortSignal, {
      composer: () => this.activeComposer(page, 30_000, abortSignal, op),
      verify: expected => this.waitForPromptChunkAttached(page, expected, abortSignal, op,
        chatGptPromptPreservesLeading(insertionPlan)),
      reanchor: () => this.reanchorPromptCaret(page, abortSignal, op),
      connectorSelected,
      existingPrefix: diagnosticContext?.preparedPrefix ?? (existingText === " " ? " " : undefined),
      onProgress: snapshot => {
        diagnosticContext?.candidateBudget?.observe(snapshot);
        console.info(`[chatgpt-web] browser turn ${diagnosticContext?.traceId ?? "unscoped"}`
          + ` stage=${diagnosticContext?.stage ?? "prompt_attachment"} composer=${JSON.stringify(snapshot)}`);
      },
    }, { largeStructuredDirect, forceStructuredDirect,
      candidatePlainText: this.config?.experimentalComposerPlainText === true }, op, insertionPlan);
  }

  private async waitForPromptChunkAttached(
    page: Page, expected: string, abortSignal?: AbortSignal, operation?: ChatGptPromptOperation,
    preserveLeading = false,
  ): Promise<void> {
    const parent = operation ?? new ChatGptPromptOperation(abortSignal);
    const op = parent.budget(20_000);
    let observed = "";
    while (op.timeLeft() > 0) {
      observed = await this.attachedPromptText(page, abortSignal, op, preserveLeading);
      op.check();
      if (this.promptTextEquivalent(expected, observed)) return;
      await op.poll(100);
    }
    parent.check();
    throw chatGptPromptAttachmentMismatch(
      "ChatGPT composer did not commit the expected prompt text", expected, observed,
      this.promptEquivalentPrefixLength(expected, observed),
    );
  }

  private async verifyConnectorExclusive(
    traceId = `verify_${randomUUID().replaceAll("-", "")}`,
  ): Promise<string> {
    const page = await this.ensurePage();
    const diagnostics = new ChatGptBrowserDiagnostics(
      traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      true,
    );
    const captureDiagnostic = (checkpoint: string): Promise<void> => diagnostics.capture(page, checkpoint);
    try {
      await captureDiagnostic("connector-verification-started");
      await this.prepareChatSurface(page, captureDiagnostic);
      // The launcher refreshes its owned ChatGPT document before starting this helper. A second
      // reload here can discard the first catalog's exact mismatch evidence and report a generic
      // menu failure instead of identifying the connector the account actually exposes.
      await this.selectConnector(page, captureDiagnostic);
      const account = await detectChatGptAccountCapabilities(page);
      const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
      const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
      // The verification turn must prioritize deterministic tool dispatch over a
      // deeper answer. User task effort selection remains unchanged elsewhere.
      const reasoning = "low";
      const modelFamily = account.solAvailable ? "5.6" as const : undefined;
      const contract = this.config.appName === ZERO_RISK_CHATGPT_CONNECTOR_NAME ? "safe" as const : "native" as const;
      if (!this.config.brokerSocketPath) {
        throw new Error("Connector verification requires the active runtime broker socket");
      }
      const broker = new RemoteTurnBroker(this.config.brokerSocketPath);
      const cwd = process.cwd();
      const environment = {
        cwd,
        roots: [cwd],
        writableRoots: [],
        sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
        tools: [],
      };
      const surfaceNonce = `verify_${randomUUID().replaceAll("-", "")}`;
      let reference: string | undefined;
      try {
        await verifyCurrentConnectorContract(this.config.appName, contract, async probe => {
          if (probe.attempt > 1) await captureDiagnostic("connector-contract-retry");
          await this.runBrowserTurn({
            traceId: probe.attempt === 1 ? `${traceId}_contract` : `${traceId}_contract_retry`,
            modelId,
            reasoning,
            modelFamily,
            capabilities,
            nativeConnector: true,
            prepare: async () => ({ text: probe.prompt, images: [], release: () => {} }),
            onTextDelta: () => {},
          }, undefined, page);
        }, async attempt => {
          // A retry gets a fresh broker lease; the previous turn's token can
          // already have expired or been retired by its completed response.
          if (reference) await broker.revoke(reference);
          const probeTraceId = attempt === 1 ? `${traceId}_contract` : `${traceId}_contract_retry`;
          reference = contract === "safe"
            ? await broker.registerSafe(environment, surfaceNonce, 60_000, probeTraceId)
            : await broker.register(environment, 60_000, probeTraceId);
          if (contract === "safe") await broker.confirmSafeTurnSent(reference, surfaceNonce);
          return reference;
        }, { retryMissingEvidence: true });
      } finally {
        if (reference) await broker.revoke(reference);
      }
      await captureDiagnostic("connector-contract-verified");
      await this.clearChatGptComposerState(page);
      await captureDiagnostic("connector-verification-cleared");
      await captureDiagnostic("connector-verification-succeeded");
      return this.config.appName;
    } catch (error) {
      await diagnostics.capture(page, "connector-verification-failed", error);
      throw error;
    }
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    extraHighAvailable?: boolean;
    proAvailable?: boolean;
    modelCapabilities?: ChatGptWebModelCapabilities;
  }> {
    const page = await this.ensurePage();
    await this.prepareChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareChatSurface(page, undefined, false, abortSignal);
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
    const input = page.locator('input[data-testid="upload-photos-input"], form[data-chatgpt-composer] input[type="file"][multiple]:not([accept])');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .or(composerForm.locator(`.composer-attachment-surface:is(button, [role="button"])[aria-label=${JSON.stringify(file.name)}]`))
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
    const send = composerForm.locator(CHATGPT_SEND_BUTTON_SELECTOR);
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
    const snapshot = await responseTurn.evaluate((element, options) => {
      const root = element as HTMLElement;
      const completionActionSelector = options.completionActionSelector;
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        return candidate.isConnected
          && !candidate.hidden
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };
      const renderedThroughRoot = (candidate: HTMLElement): boolean => {
        for (let current: HTMLElement | null = candidate; current; current = current.parentElement) {
          if (!renderedInDom(current) || current.getAttribute("aria-hidden") === "true") return false;
          if (current === root) return true;
        }
        return false;
      };

      // ChatGPT's DIL renderer has no .markdown class (#538). Read its response root within the
      // assistant-owned PUIK container; the CSS module hash is build-specific. Both renderers
      // feed the same content serializer and completion checks below, without reading UI text.
      const answerRootSelector = '.markdown, [data-message-author-role="assistant"] .puik-root.not-markdown > [class*="_DilResponseRoot"], [data-markdown-text-style="assistant-message"]';
      // In the Activity renderer, the agent-start marker owns the progress block
      // before an assistant search unit exists. Final answers have their own unit.
      const activityContainers = [...root.querySelectorAll<HTMLElement>("[data-chatgpt-agent-turn-start]")]
        .map(marker => marker.parentElement!);
      // ChatGPT uses the same content renderer for intermediate commentary and for the final
      // answer. Older responses nested commentary in the streaming-status container. Pro can also
      // render a completed commentary Markdown root immediately before that live status container.
      // Final-answer Markdown follows the live status instead, so DOM order remains the semantic
      // boundary without relying on localized labels such as "Pro thinking".
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(answerRootSelector)]
        .filter(candidate => {
          if (!root.hasAttribute("data-turn-key") && !candidate.hasAttribute("data-markdown-text-style")) return true;
          const unit = candidate.closest("[data-content-search-unit-key]");
          return unit ? Array.from(unit.children)
            .some(child => child.getAttribute("data-conversation-role") === "assistant")
            : activityContainers.some(container => container.contains(candidate));
        })
        .filter(candidate => !candidate.parentElement?.closest(answerRootSelector))
        .filter(renderedThroughRoot);
      const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")]
        .filter(renderedThroughRoot);
      // Captured Activity uses the same Markdown component for public action summaries
      // and assistant commentary, including summaries outside activity-header rows.
      // Its explicit tone distinguishes these within the agent's progress section;
      // a final-answer search unit remains an answer regardless of its text tone.
      const activitySummaryRoots = new Set(allMarkdownRoots.filter(candidate => (
        candidate.getAttribute("data-markdown-text-tone") === "tertiary"
        && !candidate.closest("[data-content-search-unit-key]")
        && activityContainers.some(container => container.contains(candidate))
      )));
      // CHATGPT_COMMENTARY_CLASSIFIER_BEGIN
      // Self-contained so the test suite can execute this exact source against a synthetic DOM;
      // it must not close over anything from the surrounding evaluate scope.
      const selectChatGptAnswerRoots = (
        markdownRoots: HTMLElement[],
        statusContainers: HTMLElement[],
        activityContainers: HTMLElement[] = [],
      ): { commentaryRoots: HTMLElement[]; answerRoots: HTMLElement[] } => {
        const firstStatusContainer = statusContainers[0];
        const commentary = markdownRoots.filter(candidate => (
          (!candidate.closest("[data-content-search-unit-key]")
            && activityContainers.some(container => container.contains(candidate)))
          || candidate.closest("[data-streaming-response-status]") !== null
          // Chain-of-thought components carry reasoning, never the final answer, so containment is
          // a position-independent commentary signal. Position alone cannot separate "commentary
          // between two status containers" from "answer between two tool calls".
          || candidate.closest('[data-testid^="cot-v5"]') !== null
          // Only Markdown that precedes the FIRST status container is prior commentary. Keying
          // this on "some status follows me" silently reclassified answer text as commentary as
          // soon as a second tool call opened another status container below it, which both zeroed
          // the visible text and dropped every answer chunk emitted between tool calls.
          || (firstStatusContainer !== undefined && Boolean(
            // 4 is Node.DOCUMENT_POSITION_FOLLOWING, inlined to keep this function standalone.
            candidate.compareDocumentPosition(firstStatusContainer) & 4,
          ))
        ));
        return {
          commentaryRoots: commentary,
          answerRoots: markdownRoots.filter(candidate => !commentary.includes(candidate)),
        };
      };
      // CHATGPT_COMMENTARY_CLASSIFIER_END
      const classified = selectChatGptAnswerRoots(
        allMarkdownRoots.filter(candidate => !activitySummaryRoots.has(candidate)),
        streamingStatusContainers,
        activityContainers,
      );
      const commentaryRoots = classified.commentaryRoots;
      const renderedRoots = classified.answerRoots;
      const runtimeWindow = globalThis as typeof globalThis & {
        __codexMarkdownRootIds?: WeakMap<HTMLElement, string>;
        __codexMarkdownRootSequence?: number;
        __codexMarkdownNodeRegistry?: { documentId: string; nextNodeId: number; nodeIds: WeakMap<Node, number> };
        __codexFinalProjectionStates?: WeakMap<HTMLElement, {
          lastMutationAt: number;
          observer: MutationObserver;
        }>;
        __codexFinalProjectionRootSets?: WeakMap<HTMLElement, { signature: string; lastChangedAt: number }>;
      };
      runtimeWindow.__codexMarkdownRootIds ??= new WeakMap<HTMLElement, string>();
      runtimeWindow.__codexMarkdownRootSequence ??= 0;
      const registry = runtimeWindow.__codexMarkdownNodeRegistry ??= {
        documentId: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
        nextNodeId: 0,
        nodeIds: new WeakMap(),
      };
      runtimeWindow.__codexFinalProjectionStates ??= new WeakMap();
      runtimeWindow.__codexFinalProjectionRootSets ??= new WeakMap();
      const nodeId = (markdownRoot: HTMLElement): string => {
        const existing = runtimeWindow.__codexMarkdownRootIds!.get(markdownRoot);
        if (existing) return existing;
        const created = `dom-${runtimeWindow.__codexMarkdownRootSequence!++}`;
        runtimeWindow.__codexMarkdownRootIds!.set(markdownRoot, created);
        return created;
      };
      // ChatGPT may merge adjacent `.markdown` roots or virtualize an old prefix while a streamed
      // answer is finalized. Root boundaries and visible indices therefore are not identity:
      // flatten semantic blocks and preserve ChatGPT's source ranges across that reparenting.
      // CHATGPT_MARKDOWN_CONTENT_BEGIN
      const blockMarkdownTags = new Set([
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
        "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
      ]);
      const chatGptMarkdownContent = (markdownRoot: HTMLElement, onClone?: (original: HTMLElement, clone: HTMLElement) => void): HTMLElement => {
        const content = markdownRoot.cloneNode(true) as HTMLElement;
        onClone?.(markdownRoot, content);
        // A formula's visual and accessibility layers hydrate independently. Compare
        // its TeX source, just as Markdown conversion does, so cosmetic changes cannot
        // look like an edit to text already delivered to Codex.
        for (const math of Array.from(content.querySelectorAll<HTMLElement>(".katex"))) {
          if (math.closest("pre, code")) continue;
          const sources = math.querySelectorAll('annotation[encoding="application/x-tex"]');
          if (sources.length !== 1) continue;
          const source = content.ownerDocument.createElement("annotation");
          source.setAttribute("encoding", "application/x-tex");
          source.textContent = sources[0]!.textContent;
          math.textContent = "";
          math.appendChild(source);
        }
        // Writing cards expose a copy-content boundary separate from their title,
        // format picker and other changing controls. Keep only that owned content.
        const writingCard = '[data-markdown-copy="rich-block"]';
        const cards = [...(content.matches(writingCard) ? [content] : []),
          ...Array.from(content.querySelectorAll<HTMLElement>(writingCard))];
        for (const card of cards.reverse()) {
          const bodies = Array.from(card.querySelectorAll('[data-markdown-copy-content="true"]'))
            .filter(body => body.closest(writingCard) === card);
          if (bodies.length !== 1) continue;
          const children = Array.from(bodies[0]!.childNodes);
          card.textContent = "";
          for (const child of children) card.appendChild(child);
        }
        // #769 captured a resource preview changing its title to filename/type after
        // surrounding prose was already delivered. This is a presentation control,
        // not answer text. Preserve cards that expose an actual link destination.
        const referenceSelector = '[data-chatgpt-copy-reference][data-markdown-copy="contents"]';
        for (const card of [content, ...Array.from(content.querySelectorAll(referenceSelector))]
          .filter(node => node.matches(referenceSelector) && !node.closest("pre, code"))) {
          if (card.querySelector('[class~="group/resource-row"]') && !card.querySelector("a[href]")) {
            // Keep the reference boundary even when its current view has no answer
            // content: a download link may replace this preview on a later frame.
            card.textContent = "";
          }
        }
        // These are embedded renderers, not Markdown answer text. Their loading labels, controls
        // and plot axes change independently of generation (including after a later paragraph).
        // Keep their UI out of both the emitted HTML and the text consistency fingerprint.
        // Also remove the media already excluded by chatGptHtmlToMarkdown, so their
        // accessibility labels cannot become consistency fingerprints for untransmitted text.
        // Ordinary code blocks, surrounding prose and the original observed DOM remain intact.
        for (const widget of Array.from(content.querySelectorAll(
          ".chart-widget-container, [data-code-block-preview-pane], script, style, svg, img, picture, source",
        ))) widget.remove();
        for (const button of Array.from(content.querySelectorAll("button"))) {
          // Observed file-reference controls have a label but no authoritative download URL.
          // Keep only their text; never carry button attributes or infer a link from the name.
          if (button.matches(".behavior-btn.entity-underline")
            && !button.closest('[hidden], [aria-hidden="true"]')) {
            for (const hidden of Array.from(button.querySelectorAll('[hidden], [aria-hidden="true"], .sr-only, [role="tooltip"]'))) {
              hidden.remove();
            }
            button.replaceWith(content.ownerDocument.createTextNode(button.textContent ?? ""));
          } else {
            button.remove();
          }
        }
        const codeBlockSelector = 'pre, [data-markdown-copy="code-block"]';
        for (const block of Array.from(content.querySelectorAll(codeBlockSelector))) {
          if (block.parentElement?.closest(codeBlockSelector)) continue;
          const codes = block.querySelectorAll("code");
          if (codes.length !== 1) continue;
          const code = codes[0]!.cloneNode(true);
          const pre = block.tagName === "PRE" ? block : content.ownerDocument.createElement("pre");
          block.textContent = "";
          pre.appendChild(code);
          if (pre !== block) block.appendChild(pre);
        }
        return content;
      };
      const markdownText = (element: HTMLElement): string => {
        const parts: string[] = [];
        const blockBoundary = () => {
          if (parts.length > 0 && !parts.at(-1)!.endsWith("\n")) parts.push("\n");
        };
        const visit = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
          if (!(node instanceof HTMLElement)) return;
          const tag = node.tagName.toLowerCase();
          const block = blockMarkdownTags.has(tag);
          if (block) blockBoundary();
          if (tag === "br") parts.push("\n");
          node.childNodes.forEach(visit);
          if (block) blockBoundary();
        };
        visit(element);
        return parts.join("").trim();
      };
      // CHATGPT_MARKDOWN_CONTENT_END
      // A DOM position is not a block identity: a file preview leaving the answer
      // must not give the following paragraph the preview's already committed key.
      const nodeKey = (node: Node): string => {
        let id = registry.nodeIds.get(node);
        if (id === undefined) {
          id = registry.nextNodeId++;
          registry.nodeIds.set(node, id);
        }
        return `dom:${registry.documentId}:${id}`;
      };
      const rememberClone = (original: HTMLElement, clone: HTMLElement): void => {
        const source = document.createTreeWalker(original, NodeFilter.SHOW_ALL);
        const copied = document.createTreeWalker(clone, NodeFilter.SHOW_ALL);
        do {
          nodeKey(source.currentNode);
          registry.nodeIds.set(copied.currentNode, registry.nodeIds.get(source.currentNode)!);
        } while (source.nextNode() && copied.nextNode());
      };
      let listGroupIndex = 0;
      const sourceRange = (candidate: Element): { sourceStart: number; sourceEnd: number } | undefined => {
        const startAttribute = candidate.getAttribute("data-start");
        const endAttribute = candidate.getAttribute("data-end");
        if (startAttribute === null || endAttribute === null) return undefined;
        if (!startAttribute.trim() || !endAttribute.trim()) return undefined;
        const sourceStart = Number(startAttribute);
        const sourceEnd = Number(endAttribute);
        return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
          ? { sourceStart, sourceEnd }
          : undefined;
      };
      const linkState = (element: HTMLElement): { pendingLinks: boolean; linkTargets: string[]; mutableReference: boolean } => {
        // ChatGPT may paint a link label before supplying its destination. An append-only
        // response cannot add that destination back after committing the label as plain text.
        const anchors = [element, ...element.querySelectorAll<HTMLElement>("a")]
          .filter(candidate => candidate.tagName === "A" && Boolean(candidate.textContent?.trim()));
        return {
          mutableReference: [element, ...element.querySelectorAll('[data-chatgpt-copy-reference][data-markdown-copy="contents"]')]
            .some(node => node.matches('[data-chatgpt-copy-reference][data-markdown-copy="contents"]') && !node.closest("pre, code")),
          pendingLinks: anchors.some(candidate => !candidate.getAttribute("href")?.trim()),
          linkTargets: anchors.flatMap(candidate => {
            const href = candidate.getAttribute("href");
            return href?.trim() ? [href] : [];
          }),
        };
      };
      const segmentsFor = (markdownRoot: HTMLElement, rootIsComplete: boolean) => {
        const flattened: Array<{
          nodeKey: string;
          tag: string;
          html: string;
          text: string;
          pendingLinks: boolean;
          linkTargets: string[];
          mutableReference: boolean;
          group?: string;
          sourceStart?: number;
          sourceEnd?: number;
        }> = [];
        const appendBlockSegment = (child: HTMLElement) => {
          const tag = child.tagName.toLowerCase();
          const childRange = sourceRange(child);
          const listItems = tag === "ol" || tag === "ul"
            ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
            : [];
          if (listItems.length === 0) {
            flattened.push({ nodeKey: nodeKey(child), tag, html: child.outerHTML, text: markdownText(child), ...linkState(child), ...childRange });
            return;
          }

          const group = childRange
            ? `list:${childRange.sourceStart}:${tag}`
            : `list:${listGroupIndex++}:${tag}`;
          const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
          listItems.forEach((item, itemIndex) => {
            const shell = child.cloneNode(false) as HTMLElement;
            shell.removeAttribute("data-is-last-node");
            if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
              shell.setAttribute("start", String(orderedStart + itemIndex));
            }
            shell.append(item.cloneNode(true));
            flattened.push({
              nodeKey: nodeKey(item),
              tag: `${tag}:item`,
              html: shell.outerHTML,
              text: markdownText(item),
              ...linkState(item),
              group,
              ...sourceRange(item),
            });
          });
        };
        const children = [...markdownRoot.children] as HTMLElement[];
        const hasBlockChildren = children.some(child => blockMarkdownTags.has(child.tagName.toLowerCase()));
        if (!hasBlockChildren) {
          if (markdownRoot.innerHTML.trim() || linkState(markdownRoot).mutableReference) flattened.push({
            nodeKey: nodeKey(markdownRoot),
            tag: "root",
            html: markdownRoot.innerHTML,
            text: markdownText(markdownRoot),
            ...linkState(markdownRoot),
            ...sourceRange(markdownRoot),
          });
        } else {
          let inlineRun: Node[] = [];
          const flushInlineRun = () => {
            if (inlineRun.length === 0) return;
            const nodes = inlineRun;
            inlineRun = [];
            const shell = document.createElement("span");
            nodes.forEach(node => shell.append(node.cloneNode(true)));
            const text = markdownText(shell);
            if (!text && !nodes.some(node => node instanceof HTMLElement && linkState(node).mutableReference)) return;
            const ranges = nodes.flatMap(node => node instanceof Element
              ? [node, ...node.querySelectorAll<HTMLElement>("[data-start][data-end]")]
              : [])
              .map(sourceRange)
              .filter((range): range is { sourceStart: number; sourceEnd: number } => range !== undefined);
            flattened.push({
              nodeKey: nodeKey(nodes[0]!),
              tag: "inline",
              html: shell.outerHTML,
              text,
              ...linkState(shell),
              ...(ranges.length > 0 ? {
                sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
                sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
              } : {}),
            });
          };
          markdownRoot.childNodes.forEach((node) => {
            if (node instanceof HTMLElement && blockMarkdownTags.has(node.tagName.toLowerCase())) {
              flushInlineRun();
              appendBlockSegment(node);
            } else {
              inlineRun.push(node);
            }
          });
          flushInlineRun();
        }
        return flattened.map((segment, index, segments) => ({
          key: `${segment.nodeKey}:${segment.tag}`,
          tag: segment.tag,
          html: segment.html,
          text: segment.text,
          ...(segment.group ? { group: segment.group } : {}),
          ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
          ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
          streamable: (rootIsComplete || index < segments.length - 1) && !segment.pendingLinks,
          linkTargets: segment.linkTargets,
          mutableReference: segment.mutableReference,
        }));
      };
      const markdownRoots = allMarkdownRoots.filter(markdownRoot => !activitySummaryRoots.has(markdownRoot)).map(markdownRoot => {
        const renderedIndex = renderedRoots.indexOf(markdownRoot);
        const rootIsComplete = renderedIndex >= 0 && renderedIndex < renderedRoots.length - 1;
        const content = chatGptMarkdownContent(markdownRoot, rememberClone);
        return {
          nodeId: nodeId(markdownRoot),
          ownership: commentaryRoots.includes(markdownRoot) ? "commentary" as const : "final" as const,
          toolEpoch: root.querySelectorAll("[data-item-anchor]").length,
          text: markdownText(content),
          html: content.innerHTML,
          segments: segmentsFor(content, rootIsComplete),
        };
      });
      const markdownSegments = markdownRoots
        .filter(markdownRoot => markdownRoot.ownership === "final")
        .flatMap(markdownRoot => markdownRoot.segments);
      const rendered = renderedRoots.at(-1);
      const projection = rendered ? (() => {
        const signature = renderedRoots.map(nodeId).join("\0");
        let rootSet = runtimeWindow.__codexFinalProjectionRootSets!.get(root);
        if (!rootSet) {
          rootSet = { signature, lastChangedAt: Date.now() };
          runtimeWindow.__codexFinalProjectionRootSets!.set(root, rootSet);
        } else if (rootSet.signature !== signature) {
          rootSet.signature = signature;
          rootSet.lastChangedAt = Date.now();
        }
        const projectionStates = renderedRoots.map(answerRoot => {
          let state = runtimeWindow.__codexFinalProjectionStates!.get(answerRoot);
          if (!state) {
            const created = {
              lastMutationAt: Date.now(),
              observer: undefined as unknown as MutationObserver,
            };
            created.observer = new MutationObserver(() => { created.lastMutationAt = Date.now(); });
            created.observer.observe(answerRoot, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true,
              attributeFilter: ["data-start", "data-end", "data-is-last-node"],
            });
            runtimeWindow.__codexFinalProjectionStates!.set(answerRoot, created);
            state = created;
          }
          return state;
        });
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
          rootSetSignature: rootSet.signature,
          boundaryProtocolPresent: lastNodes.length > 0,
          lastNodePresent: lastNode !== undefined,
          boundaryStart: lastNode?.getAttribute("data-start") ?? undefined,
          boundaryEnd: lastNode?.getAttribute("data-end") ?? undefined,
          lastMutationAt: Math.max(rootSet.lastChangedAt, ...projectionStates.map(state => state.lastMutationAt)),
          animations,
        };
      })() : { boundaryProtocolPresent: false, lastNodePresent: false, animations: [] };
      const completionActions = [...root.querySelectorAll<HTMLElement>(completionActionSelector)]
        .filter(renderedThroughRoot)
        .filter(candidate => {
          const contentUnit = candidate.closest("[data-content-search-unit-key]");
          return !contentUnit?.querySelector("[data-user-message-bubble]");
        });
      // The bound assistant turn already excludes every older response. ChatGPT may place this
      // turn's footer controls before its final Markdown in DOM order while painting them below it.
      const completionAction = rendered
        ? completionActions.find(candidate => !rendered.contains(candidate)
          && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
          ?? (!options.running ? completionActions.at(-1) : undefined)
        : completionActions.at(-1);
      const structuredResponsePresent = root.querySelector(".markdown, .puik-root.not-markdown") !== null;
      const plainTextFallback = renderedRoots.length === 0 && !structuredResponsePresent && completionAction ? (() => {
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
      activitySummaryRoots.forEach(candidate => candidates.set(candidate, "status"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const overlapsActivitySummary = (candidate: HTMLElement): boolean => [...activitySummaryRoots].some(summary => (
        candidate.contains(summary) || summary.contains(candidate)
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
      const hasFollowingRenderedSibling = (candidate: HTMLElement): boolean => {
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        for (
          let sibling = itemAnchor?.nextElementSibling;
          sibling;
          sibling = sibling.nextElementSibling
        ) {
          if (sibling instanceof HTMLElement && renderedThroughRoot(sibling) && sibling.innerText.trim()) {
            return true;
          }
        }
        return false;
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
          && !overlapsActivitySummary(semantic)
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
        .filter(([candidate]) => renderedThroughRoot(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          ...(kind === "commentary" ? { complete: hasFollowingRenderedSibling(candidate) } : {}),
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
        ...(block.kind === "commentary" ? {
          complete: block.complete === true || index < blocks.length - 1,
        } : {}),
      }));
      const stoppedThinkingVisible = (() => {
        const labels = new Set<string>(options.stoppedThinkingLabels);
        const isStoppedLabel = (value: string | null): boolean => (
          labels.has(value?.replace(/\s+/g, " ").trim() ?? "")
        );
        const isStatus = (candidate: HTMLElement): boolean => {
          if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)
            || candidate.closest("pre, code, blockquote")) return false;
          for (let element: HTMLElement | null = candidate; element; element = element.parentElement) {
            if (!renderedInDom(element)) return false;
          }
          return true;
        };
        if ([...root.querySelectorAll<HTMLElement>("[aria-label]")]
          .some(candidate => isStoppedLabel(candidate.getAttribute("aria-label")) && isStatus(candidate))) return true;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!isStoppedLabel(node.textContent)) continue;
          const parent = node.parentElement;
          if (parent && isStatus(parent)) return true;
        }
        return false;
      })();
      const nativeToolCandidates = [...root.querySelectorAll<HTMLElement>([
        '[data-testid="cot-v5-favicon"]',
        '[data-testid="cot-v5-native-tool-icon"]',
        '[data-testid="cot-v5-tool-icon-pile"]',
      ].join(", "))].flatMap(marker => {
        const status = marker.closest<HTMLElement>("[data-streaming-response-status]");
        if (!status || !root.contains(status)) return [];
        const activityAnimations = typeof status.getAnimations === "function"
          ? status.getAnimations({ subtree: true })
          : [];
        const runningFiniteAnimation = activityAnimations.some(animation => {
          const timing = animation.effect?.getTiming();
          const endTime = animation.effect?.getComputedTiming().endTime;
          return timing?.iterations !== Infinity
            && typeof endTime === "number"
            && Number.isFinite(endTime)
            && (animation.playState === "running" || animation.pending === true);
        });
        const testId = marker.getAttribute("data-testid");
        return [{
          kind: testId === "cot-v5-favicon" ? "web_search" as const : "native_tool" as const,
          withinStreamingStatus: true,
          ancestorsVisible: renderedThroughRoot(marker),
          ariaBusy: status.matches('[aria-busy="true"]')
            || status.querySelector('[aria-busy="true"]') !== null,
          runningFiniteAnimation,
        }];
      });
      return {
        responsePresent: true,
        visibleText: markdownRoots.filter(candidate => candidate.ownership === "final").map(candidate => candidate.text).filter(Boolean).join("\n\n") || plainTextFallback,
        fullHtml: markdownRoots.filter(candidate => candidate.ownership === "final").map(candidate => candidate.html).join("") || plainTextFallback,
        plainTextFallback,
        markdownSegments,
        markdownRoots,
        completionActionVisible: completionAction !== undefined
          && (renderedRoots.length > 0 || plainTextFallback.length > 0),
        // Retained tabs keep old turns' copy buttons. Only a later turn can conflict.
        globalCompletionActionVisible: [...document.querySelectorAll<HTMLElement>(completionActionSelector)]
          .some(candidate => renderedInDom(candidate)
            && Boolean(root.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)
            && !root.contains(candidate)),
        stoppedThinkingVisible,
        projection,
        traceBlocks,
        nativeToolCandidates,
      };
    }, {
      completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
      stoppedThinkingLabels: [...CHATGPT_STOPPED_THINKING_LABELS],
      running,
    }, { timeout: 2_000 }).catch(() => {
      if (responseTurn.page().isClosed()) {
        throw chatGptBrowserTabClosedError();
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
    const nativeConnector = turn.nativeConnector === true || localTools;
    const helperProcess = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS === "1";
    const canWarm = helperProcess
      && turn.allowStartupPreparation === true && nativeConnector && Boolean(turn.modelFamily) && !turn.compaction;
    const startup = canWarm ? this.startupPages.take(this.startupPageKey(turn)) : undefined;
    if (helperProcess && !startup && !turn.compaction) await this.startupPages.cancel();
    let startupInput: CompiledChatGptWebPrompt | undefined;
    const observedTurn: BrowserTurn = canWarm ? {
      ...turn,
      prepare: async () => { const prepared = await turn.prepare(); startupInput = prepared; return prepared; },
      onSubmitted: async () => {
        await turn.onSubmitted?.();
        if (startupInput && lease.startupAllowed === true) primeStartup();
      },
      ...(turn.prepareResume ? { prepareResume: async () => {
        const prepared = await turn.prepareResume!(); startupInput = prepared; return prepared;
      } } : {}),
    } : turn;

    const primeStartup = () => {
      void this.primeStartupPage(turn, startupInput!, lease.trackUsage === true).catch(error => {
        console.info(`[chatgpt-web] startup preparation unavailable (${error instanceof Error ? error.name : "unknown"}); the next request will use normal preparation`);
      });
    };

    const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
      ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
      ...(nativeConnector ? { connectorIdentity: this.config.appName } : {}),
      ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
      ...(startup ? { startupSurfaceId: startup.surfaceId } : {}),
      ...(canWarm ? { allowStartupPreparation: true } : {}),
    }, undefined, turn.abortSignal).catch(async error => {
      const acquisitionError = error instanceof LauncherBrowserTurnCancelledError ? chatGptBrowserTabClosedError() : error;
      try { if (startup) await this.startupPages.releaseClaim(startup); }
      catch (cleanupError) {
        throw new AggregateError([acquisitionError, cleanupError], "Launcher acquisition failed with unacknowledged startup cleanup", { cause: acquisitionError });
      }
      throw acquisitionError;
    });
    const surfaceId = lease.surfaceId;
    let startupConnection: LauncherBrowserConnection | undefined;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight: Promise<unknown> | undefined;
    let heartbeatPending = false;
    let activityFinished = false;
    let lastHeartbeatFailureAt = 0;
    let activityStage: "preparing" | "sending" | "chatgpt" = "preparing";
    const sendHeartbeat = () => {
      if (activityFinished) return;
      if (heartbeatInFlight) { heartbeatPending = true; return; }
      heartbeatInFlight = notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
        progress: { stage: activityStage, activeToolCalls: turn.externalProgress?.snapshot().activeToolCalls ?? 0 },
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        if (activityFinished) return;
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = undefined;
        if (heartbeatPending) { heartbeatPending = false; sendHeartbeat(); }
      });
    };
    try {
      if (lease.startupPrepared === true && startup && startup.surfaceId === surfaceId) startupConnection = startup.takeConnection?.();
      if (startup) await this.startupPages.releaseClaim(startup);
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      if (turn.requireRetainedConversation && lease.reused !== true) {
        throw new Error("The retained ChatGPT conversation is no longer available");
      }
      const reuseConversation = lease.reused === true && (!nativeConnector || lease.connectorBound === true);
      await turn.onPreparedSelected?.(reuseConversation && turn.prepareResume !== undefined);
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      sendHeartbeat();
      return await this.runBrowserTurn(
        {
          ...observedTurn,
          onSendActivated: async () => {
            activityStage = "sending";
            sendHeartbeat();
            await observedTurn.onSendActivated?.();
          },
          onSubmitted: async () => {
            activityStage = "chatgpt";
            sendHeartbeat();
            await observedTurn.onSubmitted?.();
          },
        },
        surfaceId,
        undefined,
        reuseConversation,
        lease.trackUsage === true,
        lease.startupPrepared === true ? startup : undefined,
        startupConnection,
      );
    } catch (error) {
      originalError = error;
      const retainCompactionBoundary = turn.retainConversation === true
        && this.compactionBoundaryRetentions.has(turn.traceId)
        && error instanceof ChatGptWebAdapterError
        && error.code === "chatgpt_completion_evidence_missing"
        && error.retryable === true;
      terminal = error instanceof ChatGptCompactionHandoffAccepted || retainCompactionBoundary
        ? "completed"
        : (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
        ? "aborted"
        : "failed";
      if (retainCompactionBoundary) {
        console.info(`[chatgpt-web] browser turn ${turn.traceId} retained after settling at the active compaction boundary`);
      }
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      activityFinished = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeatInFlight;
      // Also covers failures before runBrowserTurn reaches its connection owner.
      await (startupConnection ? closeLauncherBrowserConnection(startupConnection.browser) : undefined)?.catch(error => {
        console.warn(`[chatgpt-web] prepared transport cleanup failed (${error instanceof Error ? error.name : "unknown"})`);
      });
      try {
        const release = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminal === "completed" && turn.retainConversation ? { retain: true } : {}),
          ...(terminal === "completed" && nativeConnector ? { connectorBound: true } : {}),
          ...(terminalMessage ? { message: terminalMessage } : {}),
        });
        if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
        if (release.authenticationRequired && terminal !== "aborted") {
          throw new ChatGptWebAdapterError(
            "ChatGPT requested sign-in. Open sign in in the launcher, then retry.",
            { status: 401, errorType: "authentication_error", code: "chatgpt_sign_in_required", retryable: false },
          );
        }
        const startupBlocked = originalError instanceof ChatGptWebAdapterError
          && ([401, 403, 429].includes(originalError.status) || originalError.code === "client_cancelled");
        if (terminal !== "aborted" && !turn.abortSignal?.aborted && !startupBlocked
          && canWarm && startupInput && lease.startupAllowed === true) {
          primeStartup();
        }
      } catch (controlError) {
        if (controlError instanceof ChatGptWebAdapterError
          && ["client_cancelled", "chatgpt_sign_in_required"].includes(controlError.code)) {
          throw controlError;
        }
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
    trackUsage = false,
    startup?: PreparedChatGptStartupPage,
    startupConnection?: LauncherBrowserConnection,
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
    const diagnostics = new ChatGptBrowserDiagnostics(
      turn.traceId,
      this.config.browserDiagnosticsPath,
      turn.tunneledOutput !== undefined,
    );
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    const usageWrites: Promise<void>[] = [];
    const originalAbortSignal = turn.abortSignal;
    const rejectionAbort = new AbortController();
    const submissionRejection = new ChatGptSubmissionRejectionObserver(error => rejectionAbort.abort(error));
    turn = { ...turn, abortSignal: originalAbortSignal
      ? AbortSignal.any([originalAbortSignal, rejectionAbort.signal])
      : rejectionAbort.signal };
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      assertChatGptPromptAttachments(prepared);
      const multipartTransport = prepareChatGptWebMultipartTransport(
        prepared,
        turn.modelId,
        turn.capabilities,
        requestedMode.effort,
        turn.modelFamily,
        this.config.useEnhancedWebSessionMode === true,
      );
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      // Only an identical single message can share its exact count. Archive canonical
      // history and multipart acknowledgements still require their separate accounting.
      const estimatedInputTokens = !prepared.multipart
        && (!prepared.modelInputText || prepared.modelInputText === prepared.text)
        ? CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + estimatedMessageTokens + estimateChatGptWebImageTokens(prepared)
        : estimateCompiledChatGptWebInputTokens(
          prepared.modelInputText ? { ...prepared, text: prepared.modelInputText } : prepared,
          turn.modelId,
        );
      if (!multipartTransport) {
        assertChatGptWebInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          turn.capabilities,
          prepared.text.length,
          turn.retainConversation === true,
          turn.modelFamily,
        );
      }
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      let launcherTargetId: string | undefined;
      let page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
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
          startupConnection,
        );
        if (abortSignal.aborted) {
          await closeLauncherBrowserConnection(connection.browser).catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        launcherTargetId = connection.descriptor.surfaceTargets[launcherSurfaceId];
        await waitForOperationalChatGptViewport(connection.page, abortSignal);
        return connection.page;
      });
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      const rebindLauncherPage = async (
        attempt: number, cause: Error, callerSignal?: AbortSignal, episodeRemainingMs?: () => number,
      ): Promise<void> => {
        if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause;
        const rebindSignal = callerSignal && turn.abortSignal
          ? AbortSignal.any([callerSignal, turn.abortSignal])
          : callerSignal ?? turn.abortSignal;
        rebindSignal?.throwIfAborted();
        const remaining = () => Math.max(0, Math.min(
          episodeRemainingMs?.() ?? browserStageTimeouts.browserPage,
          deadline === undefined ? Infinity : deadline - Date.now(),
        ));
        let active = true;
        const check = () => {
          rebindSignal?.throwIfAborted();
          if (!active || remaining() <= 0) throw new Error("ChatGPT same-page acquisition deadline expired");
        };
        console.warn(`[chatgpt-web] browser turn ${turn.traceId} same-page recovery attempt=${attempt} phase=acquire`);
        submissionRejection.noteRebind();
        try {
          check();
          await this.runStage(turn.traceId, `response_page_rebind_${attempt}`, remaining(), async (stageSignal, stageRemainingMs) => {
            const signal = rebindSignal ? AbortSignal.any([stageSignal, rebindSignal]) : stageSignal;
            const budget = () => Math.min(remaining(), stageRemainingMs());
            const checkCurrent = () => { signal.throwIfAborted(); check(); };
            const previousConnection = turnConnection;
            const connection = await connectAfterClosingBrowserConnection(previousConnection, async () => {
              checkCurrent();
              turnConnection = undefined;
              await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
                phase: "heartbeat", traceId: turn.traceId, helperPid: process.pid, refreshViewport: true,
              }, Math.min(LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS, budget()));
              checkCurrent();
              const rebound = await connectLauncherBrowserHost(
                this.config.browserHostDescriptorPath!, budget(), launcherSurfaceId, signal,
              );
              try {
                checkCurrent();
                if (!launcherTargetId || rebound.descriptor.surfaceTargets[launcherSurfaceId] !== launcherTargetId) {
                  throw new Error("ChatGPT launcher target ownership changed during same-page acquisition");
                }
              } catch (error) {
                // A late connect may outlive cancellation; it never replaces the next owner.
                await closeLauncherBrowserConnection(rebound.browser).catch(() => {});
                throw error;
              }
              // Own the transport before viewport preparation can fail or be cancelled.
              turnConnection = rebound.browser;
              diagnosticPage = rebound.page;
              await waitForOperationalChatGptViewport(rebound.page, signal, Math.min(10_000, budget()));
              checkCurrent();
              return rebound;
            });
            checkCurrent();
            page = connection.page;
            diagnosticPage = page;
          }, rebindSignal);
          check();
          console.warn(`[chatgpt-web] browser turn ${turn.traceId} same-page recovery attempt=${attempt} phase=ready`);
        } finally { active = false; }
      };
      const toolTurnObservationRecovery = launcherSurfaceId !== undefined && this.config.browserHostDescriptorPath !== undefined
        ? async (attempt: number, cause: ChatGptBrowserObservationTimeoutError, signal?: AbortSignal, remainingMs?: () => number) => {
          await rebindLauncherPage(attempt, cause, signal, remainingMs);
          await diagnostics.capture(page, "submission-page-rebound");
          return page;
        }
        : undefined;
      await diagnostics.capture(page, "browser-page-acquired");
      const notifyApprovalPending = async (pending: boolean) => {
        if (!launcherSurfaceId) return;
        await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "approval", traceId: turn.traceId, helperPid: process.pid, pending,
        });
      };
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${multipartTransport
          ? `multipart-${prepared.multipart!.parts.length}`
          : prepared.transport ?? "inline"},`
        + ` inlineChars=${prepared.inlineChars ?? prepared.text.length}, archiveChars=${prepared.archiveChars ?? 0},`
        + ` archiveSha256=${prepared.archiveSha256 ?? "none"},`
        + ` maxMessageChars=${compiledChatGptWebMaxMessageChars(prepared)},`
        + ` estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length},`
        + ` compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () => this.prepareChatSurface(
            page,
            checkpoint => diagnostics.capture(page, checkpoint),
            this.config.useSavedChats,
            turn.abortSignal,
          ),
        );
      }
      // A retained lease proves the connector binding, not the current model selection.
      // Reconcile the live control before every submission, including retained continuations.
      if (startup) {
        const account = await readChatGptUsageAccount(page).catch(() => undefined);
        if (!account || account.accountKey !== startup.account.accountKey || account.planType !== startup.account.planType
          || account.personal !== startup.account.personal || account.needsAttention) {
          startup = undefined;
          this.lastSelectedModel = undefined;
          await this.clearChatGptComposerState(page);
        }
      }
      const stagingFamily = multipartTransport && turn.modelFamily === "6"
        && requestedMode.effort === "max" && multipartTransport.stagingMode.effort !== "max"
          ? "5.6" : turn.modelFamily;
      const selectStagingMode = () => (
        this.selectModelAndEffort(
          page,
          turn.modelId,
          multipartTransport?.stagingMode.effort ?? turn.reasoning,
          turn.capabilities,
          checkpoint => diagnostics.capture(page, checkpoint),
          trackUsage,
          stagingFamily,
        )
      );
      let mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, async () => {
        if (startup && !multipartTransport) {
          try { await this.assertSelectedEffort(page, startup.selection, true, turn.traceId); return startup.selection; }
          catch (error) {
            if (!(error instanceof ChatGptWebAdapterError)
              || !["upstream_server_error", "model_version_unavailable"].includes(error.code)) throw error;
            startup = undefined;
          }
        }
        return selectStagingMode();
      });
      await diagnostics.capture(page, "effort-selection-complete");

      // One receipt per physical Send, not per native tool call or stream attachment.
      // The ID survives observation recovery; a new actual Send receives a new ID.
      const usageSubmission = async () => {
        if (!trackUsage) return undefined;
        const model = mode.usageModel ?? (mode.effort === "max" ? "pro-unknown" : "other");
        const submission = await prepareChatGptLimitsSubmission(page, model);
        return () => {
          // Do not spend the Send observation deadline waiting for optional local accounting.
          // Drain these bounded writes before releasing this turn's launcher lease.
          const write = notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "usage", traceId: turn.traceId, helperPid: process.pid,
            ...submission(),
          }).then(() => {}, () => {
            // Approximate accounting must not turn an already accepted model message into a retry.
            console.warn(`[chatgpt-web] Limits could not persist a submission receipt for ${turn.traceId}`);
          });
          usageWrites.push(write);
        };
      };

      let catalogRefreshAvailable = !reuseConversation && (turn.nativeConnector === true || mode.localTools);
      const connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 };
      const acknowledgedStages: ChatGptAcknowledgedMultipartStage[] = [];
      if (multipartTransport) {
        for (let index = 0; index < multipartTransport.stages.length; index += 1) {
          const stage = multipartTransport.stages[index]!;
          if (index > 0) mode = await this.runStage(
            turn.traceId, `multipart_stage_${index + 1}_effort_selection`,
            browserStageTimeouts.effortSelection, selectStagingMode,
          );
          const stageInsertionPlan = planChatGptPromptInsertion(stage.text, {
            largeStructuredDirect: true,
            candidatePlainText: this.config.experimentalComposerPlainText === true,
          });
          console.info(`[chatgpt-web] multipart_stage_prepared ${JSON.stringify({
            traceId: turn.traceId, part: index + 1, total: prepared.multipart!.parts.length,
            effort: mode.effort, modelFamily: mode.modelFamily,
            messageChars: stage.text.length, estimatedMessageTokens: multipartTransport.stageMessageTokens[index],
          })}`);
          const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
          const initialResponseTurn = await readChatGptAssistantTurnState(responseTurns);
          const initialTurnIdentities = initialResponseTurn.knownTurnIdentities ?? [];
          const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
          const baseline: ChatGptSubmissionBaseline = {
            userTurns,
            responseTurns,
            initialUserTurnCount: await userTurns.count(),
            initialResponseTurnCount: initialResponseTurn.count,
            initialTurnIdentities,
            initialPageUrl: page.url(),
            submissionRequestObserved: () => submissionRejection.ownedSubmissionRequestObserved(),
            activateSubmissionRequestObservation: () => submissionRejection.activate(),
            initialResponseTurn,
            submittedText: stage.text,
            acknowledgedStages,
          };
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            chatGptPromptAttachmentTimeoutMs(stage.text.length, this.config.experimentalNoAutoCompact),
            (stageSignal, remainingMs) => this.attachPrompt(
              page,
              stage.text,
              false,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
              false, connectorAttemptBudget, false, true, false, undefined,
              { traceId: turn.traceId, stage: `multipart_stage_${index + 1}_attachment`,
                operation: new ChatGptPromptOperation(stageSignal, remainingMs), insertionPlan: stageInsertionPlan },
            ),
            turn.abortSignal,
            chatGptSuspensionClock,
            true,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-attachment-complete`);
          const recordStageUsage = await usageSubmission();
          const evidence = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_send`,
            browserStageTimeouts.multipartStageSend,
            stageSignal => this.sendAttachedPrompt(
              page,
              baseline,
              initialResponseTurn,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
              async () => {
                await this.assertSelectedEffort(page, mode, true, turn.traceId);
                Object.assign(baseline, await this.captureSubmissionBaseline(page, stage.text, baseline));
                submissionRejection.begin(page);
              },
              undefined,
              toolTurnObservationRecovery,
              stage.text,
              stageInsertionPlan,
            ),
            turn.abortSignal,
          );
          recordStageUsage?.();
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart part ${index + 1}/${prepared.multipart!.parts.length} submission accepted evidence=${evidence}`,
          );
          const acknowledgedResponse = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_acknowledgement`,
            browserStageTimeouts.multipartStageAcknowledgement,
            async stageSignal => {
              const acknowledgementSignal = turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal;
          const responseTurn = await this.waitForNewAssistantTurn(
            page,
            baseline,
            deadline,
            acknowledgementSignal,
            undefined,
            CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
            toolTurnObservationRecovery,
          );
          await this.waitForMultipartAcknowledgement(
            page,
            responseTurn.locator,
            stage,
            deadline,
            acknowledgementSignal,
            undefined,
          );
          return responseTurn;
            },
            turn.abortSignal,
            chatGptSuspensionClock,
          );
          const stageRejection = await submissionRejection.failure();
          if (stageRejection) throw stageRejection;
          acknowledgedStages.push({text: stage.text, acknowledgement: stage.acknowledgement, identities: [acknowledgedResponse.identity]});
          await turn.onMultipartStageAcknowledged?.(index + 1);
          await diagnostics.capture(page, `multipart-stage-${index + 1}-acknowledged`);
        }
        // The first saved message changes / to /c/<id>. Re-prove the selection on
        // that conversation even when staging and final effort are identical.
        if (mode.effort !== requestedMode.effort || (mode.selection && mode.selection.url !== page.url())) {
          mode = await this.runStage(
            turn.traceId,
            "final_part_effort_selection",
            browserStageTimeouts.effortSelection,
            () => this.selectModelAndEffort(
              page,
              turn.modelId,
              requestedMode.effort,
              turn.capabilities,
              checkpoint => diagnostics.capture(page, `final-part-${checkpoint}`),
              trackUsage,
              turn.modelFamily,
            ),
            turn.abortSignal,
          );
          await diagnostics.capture(page, "final-part-effort-selected");
        }
        // Reloading after staged acknowledgements would discard the transaction from the active
        // Temporary Chat. Connector lookup therefore fails closed instead of refreshing here.
        catalogRefreshAvailable = false;
      }
      const answerBuffer = new ChatGptAnswerBuffer();
      let responsePrompt = multipartTransport?.finalPrompt ?? prepared.text;
      let retrySubmitted: (() => void) | undefined;
      let preemptiveRetryPrompt: string | undefined;
      let preemptiveStop: PreemptiveRetryStopState | undefined;
      let tunneledOutputSequence = 0;
      let beforeRecoveryInsertion: ((composer: Locator) => Promise<boolean | void>) | undefined;
      let activateRecoverySubmission: ((composer: Locator) => Promise<Omit<ChatGptOwnedSendGuard, "deadlineAt"> | undefined>) | undefined;
      let recoverySubmissionGuard: Omit<ChatGptOwnedSendGuard, "deadlineAt"> | undefined;
      let recoveryExpectedActivityRevision: number | undefined;
      let recoveryToolBatchRevision: number | undefined;
      let recoveryObservationBaseline: ChatGptAssistantTurnState | undefined;
      let recoveryCompletionTracker: ChatGptCompletionTracker | undefined;
      let recoveryInsertionCancelled = false;
      for (let responseAttempt = 1; ; responseAttempt += 1) {
        recoveryInsertionCancelled = false;
        if (responseAttempt > 1 && mode.selection && mode.selection.url !== page.url()) {
          // A submitted Temporary Chat may acquire /c/<id>. Re-prove the same
          // selection there; never transfer it between existing conversations.
          if (!isTemporaryChatGptUrl(mode.selection.url) || !isTemporaryChatGptTurnUrl(page.url())) {
            throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the selected model's browser surface before retry");
          }
          mode = await this.runStage(
            turn.traceId, "retry_effort_selection", browserStageTimeouts.effortSelection,
            () => this.selectModelAndEffort(
              page, turn.modelId, mode.effort, turn.capabilities,
              checkpoint => diagnostics.capture(page, `retry-${checkpoint}`), trackUsage, turn.modelFamily,
            ),
            turn.abortSignal,
          );
        }
        let completedRetryPrompt: ChatGptRetryPrompt | undefined;
        let responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
        let initialResponseTurn = await readChatGptAssistantTurnState(responseTurns);
        const initialTurnIdentities = initialResponseTurn.knownTurnIdentities ?? [];
        let responseTurn = responseTurns.nth(initialResponseTurn.count);
        let responseTurnBinding: ChatGptAssistantTurnBinding | undefined;
        let activityTurnBinding: ChatGptActivityTurnBinding | undefined;
        let completionTracker = new ChatGptCompletionTracker();
        let initialToolBatchRevision = 0;
        let userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
        let initialUserTurnCount = await userTurns.count();
        let submissionBaseline: ChatGptSubmissionBaseline = {
          userTurns,
          responseTurns,
          initialUserTurnCount,
          initialResponseTurnCount: initialResponseTurn.count,
          initialTurnIdentities,
          initialPageUrl: page.url(),
          submissionRequestObserved: () => submissionRejection.ownedSubmissionRequestObserved(),
          activateSubmissionRequestObservation: () => submissionRejection.activate(),
          initialResponseTurn,
          submittedText: responsePrompt,
          acknowledgedStages,
        };
        let tunneledDomFallback = false;
        let recoveryObservationOnly = false;
        let recoveryFinalizationActivated = false;
        const cancelRecoveryFinalization = async (): Promise<void> => {
          const expectedRevision = recoveryExpectedActivityRevision;
          if (expectedRevision === undefined
            || await turn.cancelFinalizationOnly?.(expectedRevision + 1) !== true) {
            throw chatGptWebSurfaceError("ChatGPT recovery finalization could not be cancelled before submission", false);
          }
          turn.finalAnswerAdmission?.reopen();
          this.finalizingRuns.delete(turn.traceId);
          recoveryFinalizationActivated = false;
        };
        const resumeRecoveryObservation = (): void => {
          recoveryObservationOnly = true;
          // No new response was sent: retain the original post-tool projection proof.
          completionTracker = recoveryCompletionTracker ?? completionTracker;
          recoveryCompletionTracker = undefined;
          initialResponseTurn = recoveryObservationBaseline ?? initialResponseTurn;
          responseTurn = responseTurns.nth(initialResponseTurn.count);
          initialToolBatchRevision = recoveryToolBatchRevision ?? initialToolBatchRevision;
          beforeRecoveryInsertion = undefined;
          activateRecoverySubmission = undefined;
          recoverySubmissionGuard = undefined;
          recoveryExpectedActivityRevision = undefined;
          recoveryToolBatchRevision = undefined;
        };
        try {
        for (;;) {
          try {
            let candidateAttachment: {
              insertionPlan: ChatGptPromptInsertionPlan;
              candidateBudget: ChatGptCandidateAttachmentBudget;
            } | undefined;
            await this.retryPromptAttachmentAfterRebind(
              () => this.runStage(
                turn.traceId,
                "prompt_attachment",
                chatGptPromptAttachmentTimeoutMs(responsePrompt.length, this.config.experimentalNoAutoCompact),
                (stageSignal, remainingMs) => {
                  const operation = new ChatGptPromptOperation(stageSignal, remainingMs);
                  // App selection belongs to a message, not the retained conversation.
                  // Every owned Send needing Native2 must re-prove its current composer pill.
                  const localTools = turn.nativeConnector === true || mode.localTools;
                  if (!candidateAttachment) {
                    const insertionPlan = planChatGptPromptInsertion(localTools ? ` ${responsePrompt}` : responsePrompt, {
                      largeStructuredDirect: Boolean(multipartTransport) || prepared.transport === "inline",
                      forceStructuredDirect: turn.compaction === true && turn.requireRetainedConversation === true,
                      candidatePlainText: true,
                    });
                    candidateAttachment = {
                      insertionPlan,
                      candidateBudget: new ChatGptCandidateAttachmentBudget(insertionPlan, operation.now),
                    };
                  }
                  return this.attachPromptWithCompactionRetry(
                    page,
                    responsePrompt,
                    localTools,
                    turn.compaction === true,
                    submissionBaseline,
                    checkpoint => diagnostics.capture(page, checkpoint),
                    stageSignal,
                    catalogRefreshAvailable,
                    connectorAttemptBudget,
                    mode.thinkEnabled,
                    Boolean(multipartTransport) || prepared.transport === "inline",
                    turn.compaction === true && turn.requireRetainedConversation === true,
                    beforeRecoveryInsertion,
                    { traceId: turn.traceId, stage: "prompt_attachment", operation, ...candidateAttachment,
                      ...(startup && responseAttempt === 1 && !multipartTransport ? { preparedPrefix: startup.prefix } : {}) },
                  );
                },
                turn.abortSignal,
                chatGptSuspensionClock,
                true,
              ),
              launcherSurfaceId && this.config.browserHostDescriptorPath
                ? async cause => {
                  await diagnostics.capture(page, "prompt-attachment-timeout");
                  await rebindLauncherPage(1, cause, turn.abortSignal);
                  responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
                  responseTurn = responseTurns.nth(initialResponseTurn.count);
                  userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
                  submissionBaseline = {
                    userTurns,
                    responseTurns,
                    initialUserTurnCount,
                    initialResponseTurnCount: initialResponseTurn.count,
                    initialTurnIdentities,
                    initialPageUrl: page.url(),
                    submissionRequestObserved: () => submissionRejection.ownedSubmissionRequestObserved(),
                    activateSubmissionRequestObservation: () => submissionRejection.activate(),
                    initialResponseTurn,
                    submittedText: responsePrompt,
                  };
                  connectorAttemptBudget.triggerAttempts = 0;
                  await diagnostics.capture(page, "prompt-attachment-page-rebound");
                }
                : undefined,
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
                await this.prepareChatSurface(
                  page,
                  checkpoint => diagnostics.capture(page, checkpoint),
                  this.config.useSavedChats,
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
                trackUsage,
                turn.modelFamily,
              ),
              turn.abortSignal,
            );
            await diagnostics.capture(page, "connector-catalog-refreshed");
          }
        }
        if (recoveryInsertionCancelled) resumeRecoveryObservation();
        if (!recoveryObservationOnly) await diagnostics.capture(page, "prompt-attachment-complete");
        if (!recoveryObservationOnly) {
        if (responseAttempt === 1) {
          await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
            this.attachFiles(page, prepared)
          ));
          await diagnostics.capture(page, "file-attachment-complete");
        }
        const recordFinalUsage = await usageSubmission();
        await this.runStage(
          turn.traceId,
          "send",
          prepared.multipart ? browserStageTimeouts.multipartStageSend : browserStageTimeouts.send,
          async (stageSignal, remainingMs) => {
        const composer = await this.activeComposer(page);
        const sendButton = composer
          .locator("xpath=ancestor::form[1]")
          .locator(CHATGPT_SEND_BUTTON_SELECTOR);
        await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
        let sendEnableDeadline: number | undefined;
        for (;;) {
          if (stageSignal.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
          if (page.isClosed()) throw chatGptBrowserTabClosedError();
          await throwIfChatGptSessionFailureAlert(page);
          await throwIfChatGptRateLimitDialog(page);
          if (await sendButton.isEnabled()) break;
          if (sendEnableDeadline !== undefined && Date.now() >= sendEnableDeadline) {
            await diagnostics.capture(page, "send-disabled");
            throw new Error("ChatGPT send button remained disabled after the complete prompt was attached");
          }
          await settleChatGptUi();
          sendEnableDeadline ??= Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
        }
        const localToolsAtSend = turn.nativeConnector === true || mode.localTools;
        const insertionText = localToolsAtSend ? ` ${responsePrompt}` : responsePrompt;
        const sendPlan = planChatGptPromptInsertion(insertionText, {
          largeStructuredDirect: Boolean(multipartTransport) || prepared.transport === "inline",
          forceStructuredDirect: turn.compaction === true && turn.requireRetainedConversation === true,
          candidatePlainText: this.config?.experimentalComposerPlainText === true,
        });
        const preserveLeading = chatGptPromptPreservesLeading(sendPlan);
        await this.assertPromptAttached(page, preserveLeading ? insertionText : responsePrompt,
          stageSignal, undefined, preserveLeading);
        if ((turn.nativeConnector === true || mode.localTools)
          && !await this.connectorIsSelected(composer, stageSignal)) {
          throw chatGptWebSurfaceError("ChatGPT connector was lost before prompt submission", false);
        }
        await diagnostics.capture(page, "send-ready");
        await this.assertSelectedEffort(page, mode, true, turn.traceId);
        if (recoveryExpectedActivityRevision !== undefined) {
          if ((await this.attachedPromptText(page, stageSignal)) !== responsePrompt) {
            throw chatGptWebSurfaceError("ChatGPT recovery composer changed before submission", false);
          }
          if (!await activateRecoverySubmission?.(composer)) {
            await clearOwnedChatGptComposerControl(composer, responsePrompt, stageSignal);
            resumeRecoveryObservation();
            return;
          }
          if ((await this.attachedPromptText(page, stageSignal)) !== responsePrompt) {
            resumeRecoveryObservation();
            return;
          }
          const activated = await turn.beginFinalizationOnly?.(recoveryExpectedActivityRevision) === true;
          if (!activated) {
            await clearOwnedChatGptComposerControl(composer, responsePrompt, stageSignal);
            resumeRecoveryObservation();
            return;
          }
          this.finalizingRuns.add(turn.traceId);
          const admissionSealed = turn.finalAnswerAdmission?.seal() ?? true;
          if (!admissionSealed) {
            await cancelRecoveryFinalization();
            await clearOwnedChatGptComposerControl(composer, responsePrompt, stageSignal);
            resumeRecoveryObservation();
            return;
          }
          try {
            recoverySubmissionGuard = await activateRecoverySubmission?.(composer);
          } catch (error) {
            await cancelRecoveryFinalization();
            throw error;
          }
          if (!recoverySubmissionGuard) {
            await cancelRecoveryFinalization();
            await clearOwnedChatGptComposerControl(composer, responsePrompt, stageSignal);
            resumeRecoveryObservation();
            return;
          }
          recoveryFinalizationActivated = true;
        }
        submissionRejection.begin(page);
        if (!recoveryFinalizationActivated) await turn.onSendActivated?.();
        // IPC activation acknowledgement can restore virtualized history too. Refresh only
        // after it settles, while the terminal anchor and retained identity order are proven.
        if (recoveryExpectedActivityRevision === undefined) {
          const refreshed = await this.captureSubmissionBaseline(page, responsePrompt, submissionBaseline);
          submissionBaseline = { ...submissionBaseline, ...refreshed };
          initialResponseTurn = refreshed.initialResponseTurn!;
          initialUserTurnCount = refreshed.initialUserTurnCount;
          responseTurn = responseTurns.nth(initialResponseTurn.count);
        }
        const initialProgress = turn.externalProgress?.snapshot();
        initialToolBatchRevision = initialProgress?.lastToolBatchRevision ?? 0;
        const initialBrokerActivityRevision = initialProgress?.lastBrokerActivityRevision ?? 0;
        if (recoveryFinalizationActivated) {
          submissionRejection.activate();
          let recoverySent: boolean | undefined;
          try {
            recoverySent = await activateOwnedChatGptSendControl(
              composer,
              responsePrompt,
              CHATGPT_SEND_BUTTON_SELECTOR,
              { ...recoverySubmissionGuard!, deadlineAt: Date.now() + Math.max(0, remainingMs()) },
              stageSignal,
            );
          } catch (error) {
            if (!(error instanceof ChatGptOwnedSendStateUnknownError)) {
              await cancelRecoveryFinalization();
              throw error;
            }
          }
          if (recoverySent === false) {
            await cancelRecoveryFinalization();
            if ((await this.attachedPromptText(page, stageSignal)) !== responsePrompt) {
              throw chatGptWebSurfaceError("ChatGPT recovery composer changed at submission", false);
            }
            await clearOwnedChatGptComposerControl(composer, responsePrompt, stageSignal);
            resumeRecoveryObservation();
            return;
          }
          let outputArmed = false;
          try {
            outputArmed = await turn.armFinalizationOutput?.(recoveryExpectedActivityRevision! + 1) === true;
          } finally {
            turn.finalAnswerAdmission?.reopen();
            this.finalizingRuns.delete(turn.traceId);
          }
          if (!outputArmed) {
            throw chatGptWebSurfaceError("ChatGPT recovery final output could not be armed after submission", false);
          }
          recoveryExpectedActivityRevision = undefined;
        } else {
          console.info(`[chatgpt-web] browser turn ${turn.traceId} send_control phase=activating`);
          await activateChatGptSendControl(sendButton, stageSignal, () => submissionRejection.activate());
          console.info(`[chatgpt-web] browser turn ${turn.traceId} send_control phase=settled`);
        }
        const evidence = await this.waitForSubmissionAccepted(
          page,
          userTurns,
          responseTurns,
          responseTurn,
          initialUserTurnCount,
          initialResponseTurn,
          submissionBaseline.initialTurnIdentities,
          stageSignal,
          turn.externalProgress,
          initialToolBatchRevision,
          initialBrokerActivityRevision,
          toolTurnObservationRecovery,
          submissionBaseline,
        );
        responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
        responseTurn = responseTurns.nth(initialResponseTurn.count);
        console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${evidence}`);
        recordFinalUsage?.();
        await turn.onSubmitted?.();
        retrySubmitted?.();
        retrySubmitted = undefined;
        beforeRecoveryInsertion = undefined;
        recoveryObservationBaseline = undefined;
          },
          turn.abortSignal,
        );
        await diagnostics.capture(page, "send-accepted");
        }

        const responseProgress = new ChatGptResponseProgressTracker();
        const observeResponseProgress = (snapshot: ChatGptResponseDomSnapshot, running: boolean): void => {
          const { progressed, nativeEvents } = responseProgress.observe(snapshot, running);
          for (const event of nativeEvents) console.info(formatChatGptNativeToolActivityTelemetry(turn.traceId, event));
          if (progressed) turn.onProgress?.();
        };

        // Both output paths must reach the shared answer-retry handling below.
        responseObservation: {
        if (turn.tunneledOutput) {
          const tunneledObservationRecovery = new ChatGptObservationRecoveryEpisode(
            () => deadline === undefined ? Infinity : deadline - Date.now(),
          );
          const tunneled = await runChatGptTunneledOutputTurn({
            output: turn.tunneledOutput,
            waitForPoll: () => this.pauseObservation(),
            afterSequence: tunneledOutputSequence,
            attempt: responseAttempt,
            completionFence: turn.completionFence,
            completionAdmission: turn.finalAnswerAdmission,
            retryPromptForAnswer: turn.retryPromptForAnswer,
            beforeDomFallback: async stoppedMs => {
              const current = await readChatGptAssistantTurnState(responseTurns);
              const binding = bindChatGptAssistantTurn(initialResponseTurn, current);
              if (!binding) throw chatGptWebSurfaceError("ChatGPT lost the stopped response binding", false);
              const running = await chatGptStopButton(page).isVisible();
              const snapshot = await this.responseDomSnapshot(locateChatGptAssistantTurn(responseTurns, binding), undefined, running);
              if (snapshot.stoppedThinkingVisible) {
                throw chatGptStoppedThinkingError();
              }
              const progress = turn.externalProgress?.snapshot();
              if (!snapshot.responsePresent || running || chatGptExternalToolCallsAreInFlight(progress)) return "observe";
              let missingAnswerMessage: string | undefined;
              if (snapshot.visibleText.trim()) {
                try {
                  const completion = completionTracker.update({
                    responsePresent: true, running: false,
                    currentText: snapshot.visibleText, currentHtml: snapshot.fullHtml,
                    completionActionVisible: snapshot.completionActionVisible,
                    projection: snapshot.projection,
                  });
                  if (completion.status === "stalled") {
                    throw new ChatGptWebAdapterError(
                      `ChatGPT final Markdown projection stopped before completion (${JSON.stringify(completion.diagnostic)})`,
                      { status: 502, errorType: "server_error", code: "chatgpt_final_projection_stalled",
                        retryable: false, retireSession: true },
                    );
                  }
                  if (completion.status === "complete") return undefined;
                  return snapshot.completionActionVisible ? "terminal" : "nonterminal";
                } catch (error) {
                  if (!(error instanceof ChatGptMissingPostToolAnswerError)) throw error;
                  // A pre-tool projection is not a final. Keep the tunnel open for the same
                  // guarded, single-shot recovery used by an empty stopped response.
                  missingAnswerMessage = error.message;
                }
              }
              // Recent completed tools protect an empty DOM, not a bound visible final answer.
              if (chatGptExternalProgressSuppressesDomHealth(progress, Date.now())) return "observe";
              if (stoppedMs < CHATGPT_COMPLETION_ACTION_GRACE_MS) return "observe";
              const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
              const composerVisibleCount = await composers.count();
              const failure = chatGptCompletionEvidenceFailure(
                missingAnswerMessage ?? "ChatGPT stopped after native tool work without a final answer or usable completion evidence",
                answerBuffer.deliveredChars() > 0,
                {
                  responsePresent: snapshot.responsePresent, bindingPresent: true,
                  completionActionVisible: snapshot.completionActionVisible,
                  globalCompletionActionVisible: snapshot.globalCompletionActionVisible,
                  composerVisibleCount,
                  composerTextChars: composerVisibleCount === 1 ? [(await composers.first().textContent() ?? "").length] : [],
                  running, aborted: turn.abortSignal?.aborted === true,
                },
              );
              const retry = failure.readiness.eligible
                && responsePrompt !== activeCompactionToolResultInstruction()
                ? await withBrowserTurnAbort(Promise.resolve(turn.retryPromptForError?.(failure.error, responseAttempt)), turn.abortSignal)
                : undefined;
              console.warn(`[chatgpt-web] browser turn ${turn.traceId} missing final recovery`
                + ` decision=${retry ? "same_conversation" : "surface_error"} reason=${failure.readiness.reason} stoppedMs=${stoppedMs} attempt=${responseAttempt}`);
              if (!retry) {
                if (responseAttempt > 1 && failure.error instanceof ChatGptWebAdapterError) {
                  throw new ChatGptWebAdapterError(
                    `${failure.error.message} (same-surface final recovery was already attempted)`,
                    {
                      status: failure.error.status,
                      errorType: failure.error.errorType,
                      code: failure.error.code,
                      retryable: false,
                      retireSession: true,
                      cause: failure.error,
                    },
                  );
                }
                throw failure.error;
              }
              const recoveryText = snapshot.visibleText;
              beforeRecoveryInsertion = async composer => {
                const latest = await readChatGptAssistantTurnState(responseTurns);
                const running = await chatGptStopButton(page).isVisible();
                const snapshot = await this.responseDomSnapshot(locateChatGptAssistantTurn(responseTurns, binding), undefined, running);
                const count = await page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).count();
                const check = chatGptCompletionEvidenceFailure("ChatGPT recovery surface changed before prompt insertion", false, {
                  responsePresent: snapshot.responsePresent,
                  bindingPresent: latest.lastId === current.lastId && latest.count === current.count,
                  completionActionVisible: snapshot.completionActionVisible,
                  globalCompletionActionVisible: snapshot.globalCompletionActionVisible,
                  composerVisibleCount: count, composerTextChars: [(await composer.textContent() ?? "").length],
                  running, aborted: turn.abortSignal?.aborted === true,
                });
                if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
                const progress = turn.externalProgress?.snapshot();
                const pendingSteering = this.takePreemptiveRetry(turn.traceId);
                if (pendingSteering) preemptiveRetryPrompt ??= pendingSteering;
                if (snapshot.visibleText !== recoveryText || snapshot.stoppedThinkingVisible || running
                  || chatGptExternalToolCallsAreInFlight(progress) || pendingSteering) {
                  recoveryInsertionCancelled = true;
                  return false;
                }
                if (!check.readiness.eligible) throw check.error;
                return true;
              };
              activateRecoverySubmission = async () => {
                const latest = await readChatGptAssistantTurnState(responseTurns);
                const running = await chatGptStopButton(page).isVisible();
                const response = locateChatGptAssistantTurn(responseTurns, binding);
                const responseHtml = await response.evaluate(element => element.innerHTML);
                const snapshot = await this.responseDomSnapshot(response, undefined, running);
                const confirmedResponseHtml = await response.evaluate(element => element.innerHTML);
                const pendingSteering = this.takePreemptiveRetry(turn.traceId);
                if (pendingSteering) preemptiveRetryPrompt ??= pendingSteering;
                return latest.lastId === current.lastId && latest.count === current.count
                  && snapshot.responsePresent && snapshot.visibleText === recoveryText && !snapshot.stoppedThinkingVisible
                  && !running && !pendingSteering && turn.abortSignal?.aborted !== true
                  && responseHtml === confirmedResponseHtml
                  ? {
                      responseSelector: chatGptAssistantTurnSelector(binding.id),
                      responseHtml: confirmedResponseHtml,
                      stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
                    }
                  : undefined;
              };
              return typeof retry === "string" ? { text: retry } : retry;
            },
            takePreemptiveRetry: () => preemptiveRetryPrompt ?? this.takePreemptiveRetry(turn.traceId),
            stopForRetry: async () => {
              const stop = chatGptStopButton(page);
              if (await stop.isVisible().catch(() => false)) await stop.press("Enter");
            },
            observe: async () => {
              if (page.isClosed()) throw chatGptBrowserTabClosedError();
              if (!isTemporaryChatGptTurnUrl(page.url())) {
                const currentUrl = new URL(page.url());
                throw chatGptWebSurfaceError(
                  `ChatGPT left the isolated Temporary Chat surface while the tunneled turn was active `
                    + `(origin=${currentUrl.origin}, pathRoot=${currentUrl.pathname.split("/")[1] || "/"}, `
                    + `temporary=${currentUrl.searchParams.get("temporary-chat")})`,
                  false,
                );
              }
              await throwIfChatGptSessionFailureAlert(page);
              await throwIfChatGptRateLimitDialog(page);
              if (await resolveChatGptToolConfirmation(
                page, this.config.appName,
                this.config.autoApproveToolCalls,
                turn.abortSignal,
                CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS, () => diagnostics.capture(page, "tool-confirmation-visible"),
                notifyApprovalPending,
              )) turn.onProgress?.();
              let current: ChatGptAssistantTurnState;
              for (;;) {
                if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
                if (deadline !== undefined && Date.now() >= deadline) throw new Error("ChatGPT web turn timed out");
                try {
                  const observed = await observeChatGptTurnIdentityAfterSend(
                    () => withChatGptBrowserObservationTimeout(readChatGptAssistantTurnState(responseTurns)),
                    settleChatGptUi,
                    turn.abortSignal,
                  );
                  if (!observed) continue;
                  current = observed;
                  tunneledObservationRecovery.resetAfterObservation();
                  break;
                } catch (error) {
                  if (!(error instanceof ChatGptBrowserObservationTimeoutError)) throw error;
                  await tunneledObservationRecovery.recover(error, rebindLauncherPage, turn.abortSignal);
                  responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
                }
              }
              const responsePresent = chatGptAssistantTurnChanged(initialResponseTurn, current);
              if (responsePresent && current.lastId) {
                await throwIfChatGptTerminalErrorAlert(page.locator(chatGptAssistantTurnSelector(current.lastId)));
              }
              const running = await chatGptStopButton(page).isVisible().catch(() => false);
              const progress = turn.externalProgress?.snapshot();
              const needsToolBoundary = !!progress && progress.lastToolBatchRevision > initialToolBatchRevision
                && completionTracker.needsToolBatchObservation(progress.lastToolBatchRevision);
              // The tunnel owns text delivery, but visible progress in this bound response
              // must renew the same stall budget as the ordinary DOM output path.
              // A stopped explicit native final still needs no rich DOM traversal.
              const binding = responsePresent && (running || needsToolBoundary)
                ? bindChatGptAssistantTurn(initialResponseTurn, current) : undefined;
              const snapshot = binding
                ? await this.responseDomSnapshot(locateChatGptAssistantTurn(responseTurns, binding), undefined, running)
                : absentResponseDomSnapshot();
              observeResponseProgress(snapshot, running);
              if (turn.externalProgress && progress && needsToolBoundary) {
                if (!responsePresent || binding) {
                  // A tool may arrive before the new assistant turn is projected. An incomplete
                  // pre-tool projection cannot prove that later text was produced after the tool.
                  const baseline = binding ? snapshot : undefined;
                  turn.abortSignal?.throwIfAborted();
                  completionTracker.observeToolBatch(progress.lastToolBatchRevision,
                    settledPreToolAnswerText(baseline, running));
                  await turn.externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
                }
              }
              return {
                responsePresent,
                running,
                toolCallsInFlight: chatGptExternalToolCallsAreInFlight(turn.externalProgress?.snapshot()),
              };
            },
            onReasoning: text => turn.onReasoningSummary?.(text),
            onCommentary: text => turn.onCommentary?.(text),
            onFinal: text => {
              answerBuffer.append(text);
              const deliverable = answerBuffer.takeDeliverable(true);
              if (deliverable) turn.onTextDelta(deliverable);
            },
            onProgress: turn.onProgress,
            onHeartbeat: turn.onHeartbeat,
            onFinalTiming: timing => console.info(`[chatgpt-web] browser turn ${turn.traceId} native_final_timing=${JSON.stringify(timing)}`),
            signal: turn.abortSignal,
            deadline,
          });
          if (tunneled.status === "complete") {
            console.info(`[chatgpt-web] browser turn ${turn.traceId} completed outputSource=tunnel finalChars=${tunneled.answer.length}`);
            const deliverable = answerBuffer.finalizeCandidate(tunneled.answer);
            if (deliverable) turn.onTextDelta(deliverable);
            break responseObservation;
          }
          tunneledOutputSequence = tunneled.lastSequence;
          if (tunneled.status === "retry") {
            recoveryObservationBaseline = initialResponseTurn;
            completedRetryPrompt = tunneled.retry;
            if (tunneled.retry.expectedActivityRevision === undefined
              && tunneled.retry.text === preemptiveRetryPrompt) preemptiveRetryPrompt = undefined;
            break responseObservation;
          }
          tunneledDomFallback = true;
          // Classify only the exact internal control prompt; completion validation stays unchanged.
          if (responsePrompt === activeCompactionToolResultInstruction()) {
            console.info(`[chatgpt-web] browser turn ${turn.traceId} output observation path=dom reason=compaction_source_settlement`);
          } else {
            console.warn(`[chatgpt-web] browser turn ${turn.traceId} output recovery path=dom reason=tunnel_final_missing`);
          }
        }

        let lastHeartbeat = 0;
        let sawRunning = false;
        let loggedCompletionWait = false;
        let capturedResponse = false;
        let sentAt = Date.now();
        const latency = new ChatGptTurnLatencyDiagnostics(turn.traceId, sentAt);
        const visibleTrace = new ChatGptVisibleTraceTracker();
        const markdownOwnership = new ChatGptMarkdownOwnershipTracker();
        const markdownBuffer = new ChatGptMarkdownBuffer(
          undefined,
          undefined,
          turn.outputFormat,
          turn.compaction !== true,
        );
        const checkpointStream = turn.captureLunaCheckpoint
          ? new ChatGptLunaCheckpointStream()
          : undefined;
        const emitVisibleAnswerDelta = (delta: string): void => {
          if (!delta) return;
          answerBuffer.append(delta);
          const deliverable = answerBuffer.takeDeliverable(!turn.retryPromptForAnswer);
          if (deliverable) turn.onTextDelta(deliverable);
        };
        const emitMarkdownDelta = (delta: string): void => {
          const visible = checkpointStream ? checkpointStream.push(delta) : delta;
          emitVisibleAnswerDelta(visible);
        };
        const throwMarkdownConsistencyError = (error: unknown): never => {
          if (!(error instanceof ChatGptMarkdownConsistencyError)) throw error;
          throw new ChatGptWebAdapterError(error.message, {
            status: 502,
            errorType: "server_error",
            code: "browser_stream_inconsistent",
            retryable: false,
          });
        };
        const domHealthTracker = new ChatGptTurnDomHealthTracker();
        let completionFenceRevision: number | undefined;
        const responseObservationRecovery = new ChatGptObservationRecoveryEpisode(
          () => deadline === undefined ? Infinity : deadline - Date.now(),
        );
        let internalObservationFaults = 0;
        for (;;) {
          if (Date.now() - lastHeartbeat >= 10_000) {
            turn.onHeartbeat?.();
            lastHeartbeat = Date.now();
          }
          let observedThisIteration = false;
          try {

        if (page.isClosed()) {
          throw chatGptWebSurfaceError("ChatGPT browser tab was closed while the turn was active", answerBuffer.deliveredChars() > 0);
        }
        if (turn.abortSignal?.aborted) {
          const stop = chatGptStopButton(page);
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        if (!isTemporaryChatGptTurnUrl(page.url())) {
          throw chatGptWebSurfaceError(
            `ChatGPT left the isolated Temporary Chat surface while the turn was active (${page.url()})`,
            answerBuffer.deliveredChars() > 0,
          );
        }

        let currentResponseTurn: ChatGptAssistantTurnState;
        try {
          const observed = await observeChatGptTurnIdentityAfterSend(
            () => withChatGptBrowserObservationTimeout(readChatGptAssistantTurnState(responseTurns)),
            settleChatGptUi,
            turn.abortSignal,
          );
          if (!observed) continue;
          currentResponseTurn = observed;
          responseObservationRecovery.resetAfterObservation();
        } catch (error) {
          if (!(error instanceof ChatGptBrowserObservationTimeoutError)) throw error;
          await responseObservationRecovery.recover(error, rebindLauncherPage, turn.abortSignal);
          responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
          responseTurn = responseTurnBinding
            ? locateChatGptAssistantTurn(responseTurns, responseTurnBinding)
            : responseTurns.nth(initialResponseTurn.count);
          if (responseTurnBinding && activityTurnBinding) {
            activityTurnBinding = { ...activityTurnBinding, locator: responseTurn };
          }
          await diagnostics.capture(page, "response-page-rebound");
          continue;
        }
        const responseTurnAttached = await responseTurn.count().catch(() => 0) > 0;
        if (!responseTurnBinding) {
          const binding = bindChatGptAssistantTurn(initialResponseTurn, currentResponseTurn);
          if (binding) {
            responseTurnBinding = binding;
            responseTurn = locateChatGptAssistantTurn(responseTurns, binding);
            activityTurnBinding = {
              identity: binding.id,
              locator: responseTurn,
              acceptedTurnIdentities: currentResponseTurn.knownTurnIdentities ?? submissionBaseline.initialTurnIdentities,
            };
            diagnostics.bindAssistantTurn(binding);
          }
        } else if (!responseTurnAttached) {
          const rebound = await this.reconcileAssistantTurnBinding(
            page,
            submissionBaseline,
            activityTurnBinding ?? {
              identity: responseTurnBinding.id,
              locator: responseTurn,
              acceptedTurnIdentities: currentResponseTurn.knownTurnIdentities ?? submissionBaseline.initialTurnIdentities,
            },
            turn.abortSignal,
          );
          if (rebound.identity !== responseTurnBinding.id) {
            responseTurnBinding = {
              id: rebound.identity,
              ordinal: currentResponseTurn.identities?.indexOf(rebound.identity)
                ?? Math.max(0, currentResponseTurn.count - 1),
              generation: responseTurnBinding.generation + 1,
            };
            responseTurn = rebound.locator;
            activityTurnBinding = rebound;
            diagnostics.bindAssistantTurn(responseTurnBinding);
            await diagnostics.capture(page, "response-dom-rebound");
          }
        }


        await throwIfChatGptSessionFailureAlert(page);
        if ((turn.nativeConnector === true || mode.localTools) && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
          notifyApprovalPending,
        )) {
          internalObservationFaults = 0;
          await this.pauseObservation();
          continue;
        }

        const stop = chatGptStopButton(page);
        const running = await stop.isVisible().catch(() => false);
        const requestedPreemption = tunneledDomFallback || preemptiveRetryPrompt
          ? undefined : this.takePreemptiveRetry(turn.traceId);
        if (requestedPreemption) {
          preemptiveRetryPrompt = requestedPreemption;
          preemptiveStop = beginPreemptiveRetryStop(Date.now(), CHATGPT_PREEMPTIVE_RETRY_STOP_TIMEOUT_MS);
        }
        if (preemptiveRetryPrompt && preemptiveStop) {
          const stopDecision = advancePreemptiveRetryStop(preemptiveStop, running, Date.now());
          preemptiveStop = stopDecision.state;
          if (stopDecision.action === "timed_out") {
            throw new ChatGptWebAdapterError(
              "ChatGPT did not stop the active generation for structured compaction checkpoint continuation.",
              {
                status: 502,
                errorType: "server_error",
                code: "chatgpt_compaction_preemption_failed",
                retryable: false,
                retireSession: false,
              },
            );
          }
          if (stopDecision.action === "press_stop") {
            await stop.press("Enter");
            console.info(`[chatgpt-web] browser turn ${turn.traceId} stopped the active generation for same-surface checkpoint continuation`);
          }
          if (stopDecision.action !== "proceed") {
            await this.pauseObservation();
            continue;
          }
          if (!responseTurnBinding) {
            completedRetryPrompt = { text: preemptiveRetryPrompt };
            preemptiveRetryPrompt = undefined;
            preemptiveStop = undefined;
            break;
          }
        }
        // An ordinal locator is live and can silently retarget a historical turn after ChatGPT DOM
        // virtualization. Do not inspect response content until the submitted turn has a stable ID.
        const snapshot = responseTurnBinding
          ? await this.responseDomSnapshot(responseTurn, markdownOwnership, running)
          : undefined;
        const externalProgressSnapshot = turn.externalProgress?.snapshot();
        if (turn.externalProgress
          && externalProgressSnapshot
          && externalProgressSnapshot.lastToolBatchRevision > initialToolBatchRevision
          && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
          completionTracker.observeToolBatch(
            externalProgressSnapshot.lastToolBatchRevision,
            settledPreToolAnswerText(snapshot, running),
          );
          turn.abortSignal?.throwIfAborted();
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
        }
        if (!snapshot) {
          await this.pauseObservation();
          continue;
        }
        internalObservationFaults = 0;
        observedThisIteration = true;
        const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
          externalProgressSnapshot,
          Date.now(),
        );
        if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
        if (!snapshot.responsePresent && externalProgressLive) {
          domHealthTracker.suspendForProgress();
          await this.waitForTurnDomOrExternalProgress(
            page,
            externalProgressSnapshot?.revision ?? 0,
            turn.externalProgress,
            turn.abortSignal,
          );
          continue;
        }
        observeResponseProgress(snapshot, running);
        await throwIfChatGptTerminalErrorAlert(
          responseTurn,
          snapshot.completionActionVisible && snapshot.visibleText.length > 0,
        );
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          if (!capturedResponse) {
            capturedResponse = true;
            latency.responseVisible();
            await diagnostics.capture(page, "response-visible");
          }
          latency.observe(snapshot.traceBlocks);
          const textDelta = (() => {
            try {
              return markdownBuffer.observe(snapshot.markdownSegments);
            } catch (error) {
              return throwMarkdownConsistencyError(error);
            }
          })();
          for (const trace of tunneledDomFallback ? [] : visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") { latency.commentaryEmitted(); turn.onCommentary?.(trace.text, trace.continuation === true); }
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
            externalProgressLive,
            activityText: JSON.stringify(snapshot.traceBlocks),
          });
          if (domError) {
            if (domHealthTracker.failureKind() === "completion_evidence") {
              // The footer action can mount between the polling snapshot and failure handling.
              // Re-read this same bound turn once so a late terminal control still proceeds through
              // the normal projection-stability proof instead of retiring a completed response.
              const refreshedCompletionEvidence = await this.responseDomSnapshot(
                responseTurn,
                markdownOwnership,
                running,
              );
              if (chatGptCompletionEvidenceRecovered(refreshedCompletionEvidence)) {
                domHealthTracker.update({
                  responsePresent: refreshedCompletionEvidence.responsePresent,
                  running,
                  currentText: refreshedCompletionEvidence.visibleText,
                  completionActionVisible: refreshedCompletionEvidence.completionActionVisible,
                  externalProgressLive,
                });
                console.info(`[chatgpt-web] browser turn ${turn.traceId} observed its completed-turn action on failure-boundary recheck`);
                continue;
              }
              const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
              const composerVisibleCount = await composers.count().catch(() => 0);
              const composerTextChars = composerVisibleCount === 1
                ? [((await composers.first().textContent().catch(() => null)) ?? "").length]
                : [];
              const failure = chatGptCompletionEvidenceFailure(
                domError,
                answerBuffer.deliveredChars() > 0,
                {
                  responsePresent: snapshot.responsePresent,
                  bindingPresent: responseTurnBinding !== undefined,
                  completionActionVisible: snapshot.completionActionVisible,
                  globalCompletionActionVisible: snapshot.globalCompletionActionVisible,
                  composerVisibleCount,
                  composerTextChars,
                  running,
                  aborted: turn.abortSignal?.aborted === true,
                },
              );
              console.warn(
                `[chatgpt-web] browser turn ${turn.traceId} same-surface readiness eligible=${failure.readiness.eligible}`
                + ` reason=${failure.readiness.reason} boundAction=${snapshot.completionActionVisible}`
                + ` globalAction=${snapshot.globalCompletionActionVisible}`
                + ` composers=${composerVisibleCount}`,
              );
              throw failure.error;
            }
            throw chatGptWebSurfaceError(domError, answerBuffer.deliveredChars() > 0);
          }
          const completion = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            projection: snapshot.projection,
            externalProgressLive,
            externalToolCallsInFlight: chatGptExternalToolCallsAreInFlight(externalProgressSnapshot),
          });
          if (completion.status !== "complete") completionFenceRevision = undefined;
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
            if (turn.completionFence) {
              if (completionFenceRevision === undefined) {
                completionFenceRevision = await turn.completionFence.begin();
                if (completionFenceRevision === undefined) continue;
                continue;
              }
            }

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
            const candidate = prepareChatGptFinalAnswer({
              markdown: markdownBuffer,
              checkpoint: checkpointStream,
              visibleText: snapshot.visibleText,
              plainTextFallback: snapshot.plainTextFallback,
              emitMarkdownDelta,
              onTextDelta: emitVisibleAnswerDelta,
              onCheckpoint: turn.onLunaCheckpoint,
              onMissingCheckpoint: () => console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`),
              normalizeMarkdownError: throwMarkdownConsistencyError,
            });
            this.finalizingRuns.add(turn.traceId);
            if (!tunneledDomFallback) preemptiveRetryPrompt ??= this.takePreemptiveRetry(turn.traceId);
            const finalOptions = {
              answer: candidate.preview,
              attempt: responseAttempt,
              preemptiveRetryPrompt,
              retryPromptForAnswer: turn.retryPromptForAnswer,
              completionFence: turn.completionFence,
              completionFenceRevision,
              completionAdmission: turn.finalAnswerAdmission,
              abortSignal: turn.abortSignal,
              finalizeAnswer: candidate.finalize,
            };
            const finalDecision = await (tunneledDomFallback
              ? decideTunneledDomFallbackFinal(finalOptions)
              : decideChatGptFinalAnswer(finalOptions));
            preemptiveRetryPrompt = undefined;
            preemptiveStop = undefined;
            if (finalDecision.status === "observe") {
              this.finalizingRuns.delete(turn.traceId);
              completionFenceRevision = undefined;
              continue;
            }
            if (finalDecision.status === "retry") {
              this.finalizingRuns.delete(turn.traceId);
              completedRetryPrompt = finalDecision.retry;
            } else {
              const deliverable = answerBuffer.finalizeCandidate(finalDecision.answer);
              if (deliverable) turn.onTextDelta(deliverable);
            }
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 60_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-60s");
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
            externalProgressLive,
          });
          if (domError) throw chatGptResponseIncompleteError(domError);
        }
          await this.waitForTurnDomOrExternalProgress(
            page,
            externalProgressSnapshot?.revision ?? 0,
            turn.externalProgress,
            turn.abortSignal,
          );
          } catch (observationError) {
            if (!(observationError instanceof TypeError) || observedThisIteration) throw observationError;
            internalObservationFaults += 1;
            if (internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS) {
              throw new Error(
                `ChatGPT browser observation failed ${internalObservationFaults} times in a row: ${observationError.message}`,
                { cause: observationError },
              );
            }
            console.warn(
              `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault`
              + ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${observationError.message}`,
            );
            await diagnostics.capture(page, "internal-observation-fault");
            await this.pauseObservation();
          }
        }
        }
        } catch (error) {
          this.finalizingRuns.delete(turn.traceId);
          if (error instanceof ChatGptFinalAnswerDecisionError) {
            if (!error.completionCommitted) turn.finalAnswerAdmission?.reopen();
            const recoverable = recoverableFinalAnswerDecisionError(error, turn.tunneledOutput !== undefined);
            if (!recoverable) throw error.original;
            error = recoverable;
          }
          turn.finalAnswerAdmission?.reopen();
          const failure = error instanceof Error ? error : new Error(String(error));
          if (failure instanceof ChatGptWebAdapterError && failure.retireSession) throw failure;
          if (turn.tunneledOutput) throw error;
          const retryPrompt = await chatGptBrowserErrorRetryPrompt({
            error: failure,
            attempt: responseAttempt,
            emittedText: answerBuffer.value(),
            compaction: turn.compaction === true,
            ...(turn.retryPromptForError ? { sessionRetry: turn.retryPromptForError } : {}),
          });
          if (!retryPrompt) throw error;
          if (turn.captureLunaCheckpoint) throw new Error("ChatGPT Luna checkpoint turns cannot retry browser failures");
          const stop = chatGptStopButton(page);
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          const retry = typeof retryPrompt === "string" ? { text: retryPrompt } : retryPrompt;
          responsePrompt = retry.text;
          answerBuffer.retryAfterError(retry.replaceCandidate === true);
          retrySubmitted = retry.onSubmitted;
          const reason = failure instanceof ChatGptWebAdapterError
            ? `${failure.name}:${failure.code}`
            : failure.name;
          console.warn(`[chatgpt-web] browser turn ${turn.traceId} retrying response failure attempt=${responseAttempt + 1} reason=${reason}`);
          continue;
        }
        const retryPrompt = completedRetryPrompt;
        if (!retryPrompt) {
          const deliverable = answerBuffer.takeDeliverable(true);
          if (deliverable) turn.onTextDelta(deliverable);
          break;
        }
        if (turn.captureLunaCheckpoint && retryPrompt.allowLunaCheckpointRetry !== true) {
          throw new Error("ChatGPT Luna checkpoint turns cannot retry their final answer");
        }
        responsePrompt = retryPrompt.text;
        answerBuffer.retryReplacement();
        retrySubmitted = retryPrompt.onSubmitted;
        recoveryExpectedActivityRevision = retryPrompt.expectedActivityRevision;
        recoveryToolBatchRevision = retryPrompt.expectedActivityRevision === undefined
          ? undefined
          : initialToolBatchRevision;
        recoveryCompletionTracker = retryPrompt.expectedActivityRevision === undefined ? undefined : completionTracker;
        if (responsePrompt === activeCompactionToolResultInstruction()) {
          console.info(`[chatgpt-web] browser turn ${turn.traceId} compaction source settlement action=send_control_response attempt=${responseAttempt + 1}`);
        } else {
          console.warn(`[chatgpt-web] browser turn ${turn.traceId} retrying final answer attempt=${responseAttempt + 1}`);
        }

      }

      const finalRejection = await submissionRejection.failure();
      if (finalRejection) throw finalRejection;
      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      const answer = answerBuffer.value();
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${answer.length})`);
      return answer;
    } catch (error) {
      if (rejectionAbort.signal.aborted && !originalAbortSignal?.aborted
        && !(error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")) {
        error = rejectionAbort.signal.reason;
      } else if (!(error instanceof DOMException && error.name === "AbortError")
        && !(error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")) {
        error = await submissionRejection.failure() ?? error;
      }
      if (error instanceof ChatGptWebAdapterError && error.code === "upstream_server_error") {
        const ui = diagnosticPage && !diagnosticPage.isClosed()
          ? await readChatGptUpstreamFailureUiState(diagnosticPage).catch(() => null) : null;
        console.warn(`[chatgpt-web] browser turn ${turn.traceId} upstream_failure ${JSON.stringify({
          submission: submissionRejection.diagnosticSummary(), ui,
        })}`);
      }
      if (error instanceof DOMException && error.name === "AbortError"
        && turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted) {
        console.info(`[chatgpt-web] browser turn ${turn.traceId} ended after accepted structured compaction handoff`);
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnostics.capture(diagnosticPage, "compaction-handoff-accepted");
        }
        throw turn.abortSignal.reason;
      }
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:`
        + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      submissionRejection.dispose();
      await Promise.all(usageWrites);
      prepared.release();
      if (turnConnection) {
        await closeLauncherBrowserConnection(turnConnection).catch(error => {
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
