import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { providerConfig } from "../provider-config";
import { availableChatGptWebModelRoutes, requireChatGptWebModelRoute, CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../chatgpt-web-models";
import { estimateTokens } from "../lib/token-estimate";
import { ChatGptBrowserWorker, assertChatGptWebInputWithinLimits, type BrowserTurn } from "../adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../adapters/chatgpt-web/adapter-error";
import { ChatGptPersistentBrowserStateError } from "../browser-mutation";
import { chatGptTurnSessions } from "../adapters/chatgpt-web/turn-execution";
import { chatGptAccountSafety, ChatGptAccountSafety, CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT, DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT } from "../adapters/chatgpt-web/account-safety";
import { boundedChatText, ChatCompletionError, compileChatCompletion, wellFormedText, type ChatCompletionInput } from "./contract";
import type { CodexProviderConfig } from "../types";

export type ChatCompletionExecutor = (input: ChatCompletionInput, config: AppConfig, signal: AbortSignal,
  onText: (delta: string) => void) => Promise<{ answer: string; limited?: boolean }>;
export interface ChatCompletionRuntimeDependencies {
  worker?: (provider: CodexProviderConfig) => Pick<ChatGptBrowserWorker, "run">;
  safety?: ChatGptAccountSafety;
}
const active = new Set<string>();
export const activeChatCompletionTurns = (): number => active.size;

export function chatCompletionRoutes(config: AppConfig) {
  if (config.browserInteractionMode === "manual") return [];
  return availableChatGptWebModelRoutes(config).filter(route => route.interactionMode === "automatic");
}

/** Preflight is also called by HTTP before headers or browser work are started. */
export function prepareChatCompletion(input: ChatCompletionInput, config: AppConfig) {
  let route;
  try { route = requireChatGptWebModelRoute(input.model, config); }
  catch { throw new ChatCompletionError("Model is not available to this API", 400, "model_not_found", "model"); }
  if (route.interactionMode !== "automatic") throw new ChatCompletionError("Manual browser interaction is not supported by this API", 400, "model_not_found", "model");
  const capabilities = { localToolsEnabled: false, solAvailable: config.solAvailable,
    extraHighAvailable: config.extraHighAvailable, proAvailable: config.proAvailable };
  const prompt = compileChatCompletion(input);
  const tokens = estimateTokens(prompt, route.backendModel);
  try { assertChatGptWebInputWithinLimits(tokens + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, tokens,
    route.backendModel, route.adapterEffort, capabilities, prompt.length, false); }
  catch { throw new ChatCompletionError("Conversation exceeds this Web model's supported input limit", 400, "context_length_exceeded", "messages"); }
  return { route, capabilities, prompt };
}

/** Non-consuming preflight; the execution owner still performs authoritative admission. */
export function requireChatCompletionAvailability(config: AppConfig, safety = chatGptAccountSafety()): void {
  const minutes = config.automaticWebSessionLimitMinutes;
  const count = minutes === undefined ? undefined : config.automaticWebSessionLimitCount ?? DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT;
  const status = safety.status(count, minutes, safety.activeTraceIds(chatGptTurnSessions.activeTraceIds()));
  if (status.state !== "NORMAL") throw new ChatCompletionError("Automatic Web requests are paused by the account-safety guard", 429, "account_safety_paused");
}

/** No native parser, fake environment, broker, connector, retained binding or alternate browser engine. */
export function createChatCompletionExecutor(dependencies: ChatCompletionRuntimeDependencies = {}): ChatCompletionExecutor {
  return async (input, config, signal, onText) => {
    const { route, capabilities, prompt } = prepareChatCompletion(input, config);
    signal.throwIfAborted();
    const traceId = `chat-api-${randomUUID()}`;
    const safety = dependencies.safety ?? chatGptAccountSafety();
    const minutes = config.automaticWebSessionLimitMinutes;
    const count = minutes === undefined ? undefined : config.automaticWebSessionLimitCount ?? DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT;
    const traces = () => safety.activeTraceIds(chatGptTurnSessions.activeTraceIds());
    const steer = (ids: readonly string[]) => {
      for (const id of ids) if (chatGptTurnSessions.steerSafetyTrace(id, CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT)) safety.markSteeringQueued(id);
    };
    const admit = () => {
      const admission = safety.admit(traceId, traceId, count, minutes, traces());
      steer(admission.steeringTraceIds);
      if (!admission.allowed) throw new ChatCompletionError("Automatic Web requests are paused by the account-safety guard", 429, "account_safety_paused");
    };
    admit();
    // Usage admission is counted once by trace/session ID, including a queued attempt.
    safety.retainTrace(traceId); active.add(traceId);
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    const limitReached = new Error("Chat Completions visible output budget reached");
    let limited = false;
    let finished = false;
    let delivered = "";
    let observed = "";
    let nextTokenProbeLength = 1;
    const functionMode = input.tools.length > 0 && input.toolChoice !== "none";
    const provider = providerConfig(config);
    provider.chatgptWeb = { ...provider.chatgptWeb,
      localToolsEnabled: false, useEnhancedWebSessionMode: false, useEnhancedOutputTunnel: false,
      experimentalBiggerContext: false, experimentalSkillAttachments: false, experimentalNoAutoCompact: false,
      autoApproveToolCalls: false, turnTimeoutMs: provider.chatgptWeb?.turnTimeoutMs || 600_000 };
    // Finite request lifetime includes queueing; worker retains its own settlement/cleanup responsibility.
    const deadline = setTimeout(() => abort.abort(new ChatCompletionError("Web request exceeded its deadline", 504, "request_timeout")), provider.chatgptWeb.turnTimeoutMs);
    deadline.unref?.();
    let safetyFailure: ChatCompletionError | undefined;
    const safetyCheck = () => {
      if (finished) return;
      const status = safety.status(count, minutes, traces());
      // An admitted request may finish when the rolling window has reached its session count.
      if (status.state === "HARD_STOP" || status.state === "DRAINING" || (status.state === "PAUSED" && status.reason !== "duration_limit")) {
        safetyFailure ??= new ChatCompletionError("Automatic Web requests are stopped by the account-safety guard", 429, "account_safety_paused");
        abort.abort(safetyFailure);
      }
    };
    const safetyTimer = setInterval(safetyCheck, 1_000); safetyTimer.unref?.();
    const turn: BrowserTurn = {
      traceId, modelId: route.backendModel, reasoning: route.adapterEffort, capabilities,
      ...(functionMode ? { outputFormat: "visible-text" as const } : {}),
      abortSignal: combined,
      prepare: async () => { combined.throwIfAborted(); admit(); return { text: prompt, images: [], transport: "inline", inlineChars: prompt.length, release() {} }; },
      // No retained surface or capabilities are set: normal worker acquisition uses a fresh Temporary Chat.
      onTextDelta(delta) {
        if (finished || combined.aborted) return;
        observed += delta;
        if (observed.length > 2 * 1024 * 1024) {
          abort.abort(new ChatCompletionError("Model output exceeded the response limit", 502, "model_output_limit")); return;
        }
        if (functionMode) return; // Buffer the complete bound assistant output; never emit partial executable arguments.
        const lastUnit = observed.charCodeAt(observed.length - 1);
        const publishable = lastUnit >= 0xD800 && lastUnit <= 0xDBFF ? observed.slice(0, -1) : observed;
        if (!wellFormedText(publishable)) { abort.abort(new ChatCompletionError("Model output contained invalid Unicode", 502, "model_protocol_error")); return; }
        if (publishable.length < nextTokenProbeLength) return;
        const allowed = boundedChatText(publishable, input.maxTokens, delivered);
        if (allowed.length > delivered.length) { const next = allowed.slice(delivered.length); delivered = allowed; onText(next); }
        if (allowed.length < publishable.length) { limited = true; abort.abort(limitReached); return; }
        // Geometric checkpoints retain exact token accounting without re-tokenizing the full prefix per delta.
        nextTokenProbeLength = Math.max(publishable.length + 1, publishable.length * 2);
      },
      onHeartbeat: safetyCheck,
    };
    try {
      let answer: string;
      try { answer = await (dependencies.worker?.(provider) ?? ChatGptBrowserWorker.forProvider(provider)).run(turn); }
      catch (error) {
        // Cancellation is not settlement. run() must finish cleanup; persistent-state errors must remain failures.
        if (limited && !signal.aborted && !safetyFailure && !(error instanceof ChatGptPersistentBrowserStateError)
          && (error === limitReached || (error instanceof Error && error.name === "AbortError"))) return { answer: delivered, limited: true };
        if (combined.aborted && error instanceof Error && error.name === "AbortError") throw combined.reason;
        throw error;
      }
      if (signal.aborted) signal.throwIfAborted();
      if (combined.aborted && !limited) combined.throwIfAborted();
      if (!functionMode) {
        if (!answer.startsWith(delivered)) throw new ChatCompletionError("Model output changed after streaming began", 502, "model_output_changed");
        const allowed = boundedChatText(answer, input.maxTokens, delivered);
        if (allowed.length > delivered.length) onText(allowed.slice(delivered.length));
        limited ||= allowed.length < answer.length;
        return { answer: allowed, limited };
      }
      return { answer };
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) {
        const reason = error.code === "rate_limit_exceeded" ? "rate_limit"
          : error.code === "chatgpt_account_safety_stop" ? "account_security" : undefined;
        if (reason) steer(safety.trigger(reason, traces()));
      }
      if (safetyFailure) throw safetyFailure;
      throw error;
    } finally {
      finished = true; clearTimeout(deadline); clearInterval(safetyTimer);
      active.delete(traceId); safety.releaseTrace(traceId); safety.status(count, minutes, traces());
    }
  };
}
