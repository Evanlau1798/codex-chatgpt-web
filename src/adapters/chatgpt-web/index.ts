import { dirname, join, resolve } from "node:path";
import { CHATGPT_WEB_BACKEND_MODEL, isChatGptWebZeroRiskBackendModel, resolveChatGptWebContextLimits } from "../../chatgpt-web-models";
import { expandUserPath } from "../../config";
import { withStallTimeout } from "../../stall-timeout";
import { type AdapterEvent, type CodexParsedRequest, type CodexProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ChatGptWebAdapterError, chatGptSessionFailureDisposition, isChatGptPromptIntegrityMismatch } from "./adapter-error";
import { chatGptAdapterRuntimeConfig, chatGptAutomaticUsagePromptOptions } from "./adapter-runtime-config";
import { createChatGptRuntimeStarter, type ChatGptRuntimeWorker } from "./adapter-runtime-factory";
import { ChatGptBrowserWorker, discardChatGptStartupPages } from "./browser-worker";
import { codexToolResultsById } from "./compaction-handoff";
import { runEnhancedCompaction } from "./enhanced-compaction";
import { runManualCompaction } from "./manual-compaction";
import { extractChatGptTurnEnvironment } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode } from "./model";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { reportChatGptPreparationFailure } from "./preparation-diagnostics";
import { chatGptNoContextStallTimeoutMs } from "./prompt-attachment-budget";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { brokerSocketPath, ChatGptSurfaceRecoveryTracker, withAbort } from "./runtime-lifecycle";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { chatGptCompactionSourceExecutionKey, chatGptConversationKey, chatGptTurnExecutionKey, chatGptTurnRoundKey, chatGptTurnSessions, chatGptTurnTraceId, type ChatGptTraceEvent } from "./turn-execution";
import { chatGptTurnRetryKey, chatGptPromptFailureKey } from "./turn-retry-identity";
import { appendCompactionUserPrompt, emitBrowserCompletion, emitProContextWarning, emitTextDeltas, emitToolBatch, emitTraceEvents, replayEvents, runtimeUsageInput } from "./turn-events";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { resolveTrustedCodexEnvironment } from "./trusted-environment-lifecycle";
import { deliverPendingChatGptSteering, sessionForChatGptRequest, validateBatchTools } from "./steering";
import { completeChatGptToolResults } from "./tool-result-delivery";
import { effectiveChatGptToolPolicy } from "./tool-policy";
import { chatGptAgentLifecycleOptions } from "./agent-session-lifecycle";
import { submittedBrowserFailure, submittedStallFailure } from "./submitted-turn";
import { ChatGptLunaCheckpointStore } from "./rolling-checkpoint";
import { EnhancedRecoveryCheckpointStore } from "./enhanced-recovery-checkpoint";
import { passiveRecoveryCheckpointInstruction } from "./native-compaction-control";
import {
  CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT,
  DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT,
  ChatGptAccountSafety,
  chatGptAccountSafety,
} from "./account-safety";
import {
  createZeroRiskRuntimeStarter,
  launcherZeroRiskManualControl,
  type ChatGptZeroRiskManualControl,
} from "./zero-risk-runtime";
export type { ChatGptZeroRiskManualControl } from "./zero-risk-runtime";
export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return chatGptAdapterRuntimeConfig(provider).executionNamespace;
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  return chatGptTurnTraceId(parsed, chatGptWebExecutionNamespace(provider));
}

export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

function finalizationRecoveryRequest(parsed: CodexParsedRequest): CodexParsedRequest {
  return {
    ...parsed,
    context: { ...parsed.context, tools: [] },
    options: { ...parsed.options, toolChoice: "none" },
    _chatgptFinalizationOnly: true,
  };
}

class ChatGptObserverDisconnected extends DOMException {
  constructor(readonly cause: unknown) { super("The Codex response stream disconnected", "AbortError"); }
}

class ChatGptAccountSafetyAdmissionError extends ChatGptWebAdapterError {}

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    worker?: ChatGptRuntimeWorker;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
    accountSafety?: ChatGptAccountSafety;
    environmentStore?: ChatGptThreadEnvironmentStore;
    enhancedRecoveryCheckpointStore?: EnhancedRecoveryCheckpointStore;
  } = {},
): ProviderAdapter {
  const worker = dependencies.worker ?? ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const brokerOwner = dependencies.broker ?? broker;
  const runtimeConfig = chatGptAdapterRuntimeConfig(provider);
  const {
    timeoutMs,
    useEnhancedWebSessionMode,
    useEnhancedOutputTunnel,
    experimentalBiggerContext,
    experimentalSkillAttachments,
    experimentalFreshConversationPerTurn,
    configuredCapabilities,
    executionNamespace,
  } = runtimeConfig;
  const environmentStore = dependencies.environmentStore ?? new ChatGptThreadEnvironmentStore(provider.chatgptWeb?.threadEnvironmentStatePath ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath)) : undefined);
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(provider.chatgptWeb?.lunaCheckpointStatePath ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath)) : undefined);
  const enhancedRecoveryCheckpointStore = dependencies.enhancedRecoveryCheckpointStore
    ?? new EnhancedRecoveryCheckpointStore(provider.chatgptWeb?.lunaCheckpointStatePath
      ? join(dirname(resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))), "enhanced-recovery-checkpoints.json")
      : undefined);
  const automaticStartRuntime = createChatGptRuntimeStarter({
    provider,
    worker,
    broker,
    brokerOwner,
    timeoutMs,
    useEnhancedWebSessionMode,
    useEnhancedOutputTunnel,
    experimentalFreshConversationPerTurn,
    experimentalBiggerContext,
    experimentalSkillAttachments,
    configuredCapabilities,
    executionNamespace,
    lunaCheckpointStore,
    enhancedRecoveryCheckpointStore,
    allowStartupPreparation: () => !manualInteraction
      && accountSafety.status(automaticWebSessionLimitCount, automaticWebSessionLimitMinutes, activeSafetyTraceIds()).state === "NORMAL",
  });
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const accountSafety = dependencies.accountSafety ?? chatGptAccountSafety();
  const automaticWebSessionLimitMinutes = provider.chatgptWeb?.automaticWebSessionLimitMinutes;
  const automaticWebSessionLimitCount = automaticWebSessionLimitMinutes === undefined
    ? undefined
    : provider.chatgptWeb?.automaticWebSessionLimitCount ?? DEFAULT_CHATGPT_AUTOMATIC_WEB_SESSION_LIMIT;
  const activeSafetyTraceIds = () => accountSafety.activeTraceIds(chatGptTurnSessions.activeTraceIds());
  const automaticSessionId = (parsed: CodexParsedRequest, traceId: string) => useEnhancedWebSessionMode
    ? chatGptConversationKey(parsed, executionNamespace) ?? traceId
    : traceId;
  const queueSafetySteering = (traceIds: readonly string[]) => {
    for (const targetTraceId of traceIds) {
      if (chatGptTurnSessions.steerSafetyTrace(targetTraceId, CHATGPT_ACCOUNT_SAFETY_DRAIN_PROMPT)) {
        accountSafety.markSteeringQueued(targetTraceId);
      }
    }
  };
  const applyAutomaticSafetyFailure = (error: ChatGptWebAdapterError) => {
    if (manualInteraction) return;
    const reason = error.code === "rate_limit_exceeded"
      ? "rate_limit"
      : error.code === "chatgpt_account_safety_stop"
        ? "account_security"
        : undefined;
    if (reason) {
      queueSafetySteering(accountSafety.trigger(reason, activeSafetyTraceIds()));
      void discardChatGptStartupPages().catch(() => console.warn("[chatgpt-web] startup cleanup after safety stop failed"));
    }
  };
  const requireAutomaticAdmission = (parsed: CodexParsedRequest, targetTraceId: string) => {
    const admission = accountSafety.admit(
      targetTraceId,
      automaticSessionId(parsed, targetTraceId),
      automaticWebSessionLimitCount,
      automaticWebSessionLimitMinutes,
      activeSafetyTraceIds(),
    );
    queueSafetySteering(admission.steeringTraceIds);
    if (admission.allowed) return;
    const hardStop = admission.status.state === "HARD_STOP";
    const rollingLimit = admission.status.reason === "duration_limit";
    throw new ChatGptAccountSafetyAdmissionError(
      hardStop
        ? "Automatic ChatGPT Web is stopped because ChatGPT reported an account-safety warning. Acknowledge the warning in the launcher before resuming."
        : rollingLimit
          ? "Automatic ChatGPT Web reached the rolling session limit. Wait for the usage window to reset or use Reset usage in the launcher before starting a new session."
          : "Automatic ChatGPT Web is paused by the local account-safety guard. Resume it in the launcher before starting new work.",
      {
        status: hardStop ? 403 : 429,
        errorType: hardStop ? "authentication_error" : "rate_limit_error",
        code: hardStop ? "chatgpt_account_safety_stop" : "chatgpt_account_safety_paused",
        retryable: false,
      },
    );
  };
  const guardedAutomaticStartRuntime: typeof automaticStartRuntime = (...args) => {
    requireAutomaticAdmission(args[0], args[2]);
    return automaticStartRuntime(...args);
  };
  const automaticUsagePromptOptions = chatGptAutomaticUsagePromptOptions(runtimeConfig, manualInteraction);
  const startRuntime = manualInteraction
    ? createZeroRiskRuntimeStarter({
        provider,
        broker: brokerOwner,
        capabilities: configuredCapabilities,
        executionNamespace,
        control: dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl,
        timeoutMs,
      })
    : guardedAutomaticStartRuntime;
  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const observerAbort = new AbortController();
      incoming = { ...incoming, abortSignal: incoming.abortSignal
        ? AbortSignal.any([incoming.abortSignal, observerAbort.signal]) : observerAbort.signal };
      const write = emit;
      emit = event => {
        if (observerAbort.signal.aborted) throw observerAbort.signal.reason;
        try { write(event); } catch (cause) {
          const error = new ChatGptObserverDisconnected(cause);
          observerAbort.abort(error);
          throw error;
        }
      };
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "ChatGPT Web cannot read this legacy or provider-private encrypted agent message. "
          + "Start a new enhanced Web task so Codex can use direct plaintext Multi-Agent V2 transport.",
        );
      }
      let traceId: string;
      try {
        traceId = chatGptTurnTraceId(parsed, executionNamespace);
      } catch (error) {
        throw reportChatGptPreparationFailure("unavailable", "full", parsed, error);
      }
      let stallTimeoutMs: number | undefined;
      try {
        stallTimeoutMs = provider.chatgptWeb?.experimentalNoAutoCompact === true
          ? chatGptNoContextStallTimeoutMs(
              JSON.stringify(parsed.context).length,
              provider.chatgptWeb?.stallTimeoutSec,
              timeoutMs,
            )
          : undefined;
      } catch (error) {
        throw reportChatGptPreparationFailure(
          traceId, "full", parsed, error,
        );
      }
      const heartbeat = setInterval(() => {
        try { emit({ type: "heartbeat" }); } catch { /* Detaches the observer and wakes its pending waits. */ }
        if (!manualInteraction) {
          queueSafetySteering(accountSafety.tick(
            automaticWebSessionLimitCount,
            automaticWebSessionLimitMinutes,
            activeSafetyTraceIds(),
          ));
        }
      }, CHATGPT_WEB_ADAPTER_HEARTBEAT_MS);
      emit({ type: "heartbeat" });
      let retainedSafetyTraceId: string | undefined;
      let promptFailureKey: string | undefined;
      try {
      const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
      if (manualRequest !== manualInteraction) {
        throw new ChatGptWebAdapterError(
          manualInteraction
            ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
            : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
          { status: 409, errorType: "invalid_request_error", code: "browser_interaction_mode_mismatch", retryable: false },
        );
      }
      const compactionSourceExecutionKey = parsed._compactionRequest
        ? `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`
        : undefined;
      const admissionTraceId = !manualInteraction && compactionSourceExecutionKey
        ? chatGptTurnSessions.find(compactionSourceExecutionKey)?.traceId ?? traceId
        : traceId;
      if (!manualInteraction) {
        requireAutomaticAdmission(parsed, admissionTraceId);
        accountSafety.retainTrace(admissionTraceId);
        retainedSafetyTraceId = admissionTraceId;
      }
      const startRuntimeForTurn = !manualInteraction && parsed._compactionRequest
        ? (...args: Parameters<typeof automaticStartRuntime>) => {
            requireAutomaticAdmission(parsed, admissionTraceId);
            return automaticStartRuntime(...args);
          }
        : startRuntime;
      const browserCompaction = parsed._compactionRequest === true || parsed._localCompactionRequest === true;
      const toolPolicy = effectiveChatGptToolPolicy(parsed); const turnCapabilities = manualRequest
        ? configuredCapabilities
        : browserCompaction
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : { ...configuredCapabilities, localToolsEnabled: configuredCapabilities.localToolsEnabled && toolPolicy.tools.length > 0 };
      const mode = manualRequest
        ? { localTools: true }
        : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      if (toolPolicy.requireTool && !mode.localTools) throw new Error("ChatGPT tool_choice requires local tools that this Web mode cannot expose");
      const structuredOutputValidator = browserCompaction
        ? undefined
        : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
      const bufferStructuredOutput = structuredOutputValidator !== undefined;
      const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
      try {
        promptFailureKey = `${executionNamespace}:${chatGptPromptFailureKey(parsed)}`;
      } catch (error) {
        throw reportChatGptPreparationFailure(traceId, "full", parsed, error);
      }
      const exhaustedRetry = chatGptWebTurnRetryPolicy.promptIntegrityFailure(promptFailureKey)
        ?? chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
      if (exhaustedRetry) {
        emit({
          type: "error",
          message: exhaustedRetry.message,
          status: exhaustedRetry.status,
          errorType: exhaustedRetry.errorType,
          code: exhaustedRetry.code,
          retryable: false,
        });
        return;
      }
      let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      if (mode.localTools) {
        environment = await resolveTrustedCodexEnvironment(environmentStore, parsed, executionKey);
      }
      if (parsed._compactionRequest) {
        const responseExecutionKey = compactionSourceExecutionKey!;
        if (manualRequest) {
          const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
          await runManualCompaction({ parsed, executionKey, sourceKey: responseExecutionKey, traceId,
            timeoutMs, abortSignal: incoming.abortSignal, capabilities: turnCapabilities, emit,
            start: signal => sessionForChatGptRequest(chatGptTurnSessions, executionKey, parsed,
              () => { signal.throwIfAborted(); return startRuntimeForTurn(parsed, environment, traceId, turnCapabilities); },
              // Let prior physical cleanup settle, then check cancellation before creating a checkpoint.
              executionNamespace, useEnhancedWebSessionMode, traceId),
          });
          return;
        }
        if (useEnhancedWebSessionMode) {
          const enhancedCompaction = await runEnhancedCompaction({
            worker, parsed, broker, executionNamespace, capabilities: turnCapabilities,
            responseExecutionKey, nativeConnectorAvailable: configuredCapabilities.localToolsEnabled,
            abortSignal: incoming.abortSignal, timeoutMs,
            requireAutomaticAdmission: () => requireAutomaticAdmission(parsed, admissionTraceId), emit,
            startFallback: async (fallbackTraceId, signal, onCompactionProgress, retainOwnershipUntil, compactionControlInstruction) => {
              const runtime = startRuntimeForTurn(parsed, undefined, fallbackTraceId, turnCapabilities, {
                onCompactionProgress,
                compactionControlInstruction,
              });
              const settlement = runtime.physicalSettlement ?? runtime.browser.then(() => undefined, () => undefined);
              retainOwnershipUntil(settlement);
              try {
                const summary = await withAbort(runtime.browser, signal);
                await withAbort(settlement, signal);
                return summary;
              } catch (error) {
                const reason = signal.aborted && signal.reason instanceof Error ? signal.reason : error;
                runtime.cancel(reason instanceof Error ? reason : new Error(String(reason)));
                throw reason;
              }
            },
          });
          if (enhancedCompaction === "completed") return;
          console.info("[chatgpt-web] Web session mode=enhanced path=reconstructed_compact result=started");
        } else {
          console.info("[chatgpt-web] compact mode=original path=upstream_compact result=started");
          const previous = chatGptTurnSessions.find(responseExecutionKey);
          if (experimentalFreshConversationPerTurn && previous?.settledOutcome()?.type === "final") {
            // Fresh compaction rebuilds from native history; a committed answer remains replayable.
            await withAbort(previous.physicalSettlement, incoming.abortSignal);
          } else {
            const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
            if (sourceConversationKey) {
              await withAbort(chatGptTurnSessions.retireConversationAndWait(sourceConversationKey), incoming.abortSignal);
            }
            await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
          }
        }
      }
      await chatGptTurnSessions.waitForRetirement(executionKey, incoming.abortSignal);
      let session = await sessionForChatGptRequest(chatGptTurnSessions, executionKey, parsed,
        () => startRuntimeForTurn(parsed, environment, traceId, turnCapabilities), executionNamespace, useEnhancedWebSessionMode, traceId, incoming.abortSignal);
      if (session.runtime.mode === "tools" && !environment) {
        environment = await resolveTrustedCodexEnvironment(environmentStore, parsed, executionKey);
      }
      let surfaceRecoveries = 0;
      const surfaceRecovery = new ChatGptSurfaceRecoveryTracker(traceId);
      const roundKey = chatGptTurnRoundKey(parsed);
      const emitRoundEvents = (events: readonly AdapterEvent[]) => {
        // Persist the whole drained batch before writing any part to the HTTP observer.
        session.appendRoundEvents(roundKey, events);
        if (events.some(event => event.type === "done" || event.type === "error")) session.completeRound(roundKey);
        replayEvents([...events], emit);
      };
      const emitRoundBatch = (produce: (buffer: (event: AdapterEvent) => void) => void) => {
        const events: AdapterEvent[] = [];
        produce(event => events.push(event));
        emitRoundEvents(events);
      };
      let awaitingRuntime = false;
      const durableRecoveryCheckpoint = () => useEnhancedWebSessionMode
        && provider.chatgptWeb?.experimentalNoAutoCompact === true
        && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
        && enhancedRecoveryCheckpointStore.apply(parsed).applied;
      try {
        await session.runExclusive(async () => { session.observeCanonicalRequest(parsed); });
        for (;;) {
          let recoveryPlan: ReturnType<ChatGptSurfaceRecoveryTracker["recoveryPlan"]>;
          await session.runExclusive(async () => {
          const replayed = session.roundEvents(roundKey);
          replayEvents(replayed, emit);
          if (session.roundCompleted(roundKey)) {
            const failure = session.roundFailure(roundKey);
            if (failure) throw failure;
            if (session.outstanding().length > 0) session.markOutstandingPublished();
            return;
          }
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") {
              recoveryPlan = surfaceRecovery.recoveryPlan(
                settled.error, session, parsed, surfaceRecoveries, incoming.abortSignal,
                durableRecoveryCheckpoint(),
              );
              if (recoveryPlan !== undefined) return;
              const submittedError = submittedBrowserFailure(
                session,
                incoming.abortSignal?.aborted === true,
                settled.error,
              );
              if (submittedError) throw submittedError;
              throw settled.error;
            }
            const trace = session.runtime.trace.drain();
            const completedTextDeltas = session.runtime.text.drain();
            const finalReplay = replayed.length === 0 && trace.length === 0 && completedTextDeltas.length === 0
              ? session.eventsForFinalReplay() : [];
            if (finalReplay.length > 0) {
              session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
              emitRoundEvents(finalReplay);
            } else {
              session.appendRoundReasoning(roundKey, trace.map(event => event.text));
              if (replayed.length === 0 && !parsed._compactionRequest && !manualRequest) {
                emitRoundBatch(buffer => emitProContextWarning(parsed, turnCapabilities, buffer));
              }
              emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
            }
            if (session.runtime.text.value() !== settled.answer) {
              throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
            }
            structuredOutputValidator?.(settled.answer);
            if (bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
            const reasoning = session.roundReasoning(roundKey);
            session.setFinalReasoning(reasoning);
            session.setFinalEvents(session.roundEvents(roundKey));
            emitRoundBatch(buffer => {
              const answer = appendCompactionUserPrompt(
                parsed,
                settled.answer,
                buffer,
                useEnhancedWebSessionMode || manualRequest,
              );
              emitBrowserCompletion(
                { ...settled, answer },
                estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { answer, reasoning }, turnCapabilities,
                  experimentalBiggerContext, automaticUsagePromptOptions),
                buffer,
              );
            });
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            try { await brokerOwner.updateEnvironment(turnToken, environment); } catch (error) {
              // A failed manual owner can retire its token before this observer updates it.
              if (!session.runtime.manualControl) throw error;
              const owner = await withAbort(session.browserOutcome, incoming.abortSignal);
              if (owner.type === "error") throw owner.error;
            }

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = [...codexToolResultsById(parsed, session).values()];
              if (results.length === 0) {
                const steering = useEnhancedWebSessionMode
                  ? deliverPendingChatGptSteering(session, broker, turnToken, traceId)
                  : undefined;
                if (!steering) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replayed.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(outstanding, estimateChatGptWebUsage(runtimeUsageInput(parsed, session),
                    { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext,
                    automaticUsagePromptOptions), buffer));
                  session.markOutstandingPublished();
                  return;
                }
              } else {
                const recoveryCheckpointEnabled = useEnhancedWebSessionMode
                  && provider.chatgptWeb?.experimentalNoAutoCompact === true
                  && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
                  && !parsed._compactionRequest && parsed._canonicalContextComplete === true
                  && session.unresolvedSupersededResultIds().length === 0;
                const recoveryLimits = recoveryCheckpointEnabled
                  ? resolveChatGptWebContextLimits(
                      CHATGPT_WEB_BACKEND_MODEL,
                      resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities).effort,
                      { ...turnCapabilities, experimentalBiggerContext: false }, true, parsed._chatgptModelFamily,
                    )
                  : undefined;
                const recoveryInput = recoveryLimits ? enhancedRecoveryCheckpointStore.apply(parsed) : undefined;
                const recoveryBudget = recoveryInput?.applied && recoveryLimits
                  ? {
                      inputTokens: estimateChatGptWebInputTokens(
                        recoveryInput.parsed, turnCapabilities, automaticUsagePromptOptions),
                      contextWindow: recoveryLimits.contextWindow,
                    }
                  : undefined;
                const recoveryLimit = recoveryLimits ? Math.min(100_000, recoveryLimits.autoCompactTokenLimit) : undefined;
                const checkpoint = recoveryLimit !== undefined
                  && enhancedRecoveryCheckpointStore.shouldCheckpoint(parsed, recoveryLimit, recoveryBudget)
                  ? await broker.beginRecoveryCheckpoint(traceId, 5 * 60_000,
                      summary => enhancedRecoveryCheckpointStore.commit(parsed, summary))
                  : undefined;
                try {
                  await completeChatGptToolResults(session, brokerOwner, turnToken, results, {
                    ...chatGptAgentLifecycleOptions(environmentStore, parsed, chatGptTurnSessions, executionNamespace),
                    ...(checkpoint ? { recoveryCheckpointInstruction: passiveRecoveryCheckpointInstruction(checkpoint) } : {}),
                  });
                  if (checkpoint) {
                    if (session.runtime.externalProgress?.snapshot().activeToolCalls !== 0) {
                      throw new Error("Passive recovery checkpoint requires a settled tool batch");
                    }
                    await withAbort(Promise.race([
                      broker.waitForCompactionHandoff(checkpoint.token, incoming.abortSignal),
                      session.browserOutcome.then(outcome => {
                        throw outcome.type === "error" ? outcome.error
                          : new Error("Web response ended before submitting its recovery checkpoint");
                      }),
                    ]), incoming.abortSignal);
                    console.info(`[chatgpt-web] passive recovery checkpoint durable trace=${traceId} limitTokens=${recoveryLimit}`);
                  }
                } finally {
                  if (checkpoint) broker.abortCompactionTransaction(checkpoint.token);
                }
                if (useEnhancedWebSessionMode) deliverPendingChatGptSteering(session, broker, turnToken, traceId);
              }
            } else if (useEnhancedWebSessionMode) deliverPendingChatGptSteering(session, broker, turnToken, traceId);
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
          }
          const toolWaitAbort = new AbortController();
          try {
            const roundReasoning = session.roundReasoning(roundKey);
            const emitRound = (event: AdapterEvent) => emitRoundEvents([event]);
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
              roundReasoning.push(...trace.map(event => event.text));
              session.appendRoundReasoning(roundKey, trace.map(event => event.text));
              emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
            };
            const emitNewText = (deltas: string[]) => {
              if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
            };
            if (replayed.length === 0 && !parsed._compactionRequest && !manualRequest) {
              emitRoundBatch(buffer => emitProContextWarning(parsed, turnCapabilities, buffer));
            }
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            const nextTools = turnToken
              ? brokerOwner.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => (
                session.runtime.manualControl && requests.length === 0
                  ? browserOutcome
                  : { type: "tools" as const, requests }
              )).catch(error => {
                // Manual completion/failure owns the final outcome; broker retirement is cleanup.
                if (session.runtime.manualControl) return browserOutcome;
                throw error;
              })
              : undefined;
            let nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              let next: Awaited<typeof browserOutcome | NonNullable<typeof nextTools> | typeof nextTrace | typeof nextText>;
              try {
                awaitingRuntime = true;
                next = await withAbort(withStallTimeout(
                  Promise.race([...(nextTools ? [nextTools] : []), browserOutcome, nextTrace, nextText]),
                  stallTimeoutMs,
                ), incoming.abortSignal);
                awaitingRuntime = false;
              } catch (error) {
                if (observerAbort.signal.aborted) throw observerAbort.signal.reason;
                const failure = session.settledOutcome();
                if (failure?.type === "error") error = failure.error;
                recoveryPlan = surfaceRecovery.recoveryPlan(error, session, parsed,
                  surfaceRecoveries, incoming.abortSignal, durableRecoveryCheckpoint());
                if (recoveryPlan !== undefined) return;
                throw error;
              }
              if (next.type === "trace") {
                emitNewTrace(session.runtime.trace.drain());
                nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
                continue;
              }
              if (next.type === "text") {
                emitNewText(session.runtime.text.drain());
                nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                continue;
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "tools" && next.requests.length > 0) {
                validateBatchTools(parsed, next.requests);
                const revision = session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                if (!session.runtime.manualControl && revision !== undefined && session.runtime.externalProgress) {
                  // Preserve the DOM boundary without a second deadline. The owned browser
                  // outcome or native cancellation must still settle this observation wait.
                  const batch = next;
                  next = await withAbort(Promise.race([
                    session.runtime.externalProgress.waitForToolBatchObservation(revision, toolWaitAbort.signal)
                      .then(() => batch),
                    browserOutcome,
                  ]).then(outcome => {
                    if (outcome.type === "tools") session.runtime.externalProgress!.assertToolBatchActive(revision);
                    return outcome;
                  }), incoming.abortSignal).catch(error => {
                    throw submittedBrowserFailure(session, incoming.abortSignal?.aborted === true, error) ?? error;
                  });
                }
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "browser") {
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (turnToken) await brokerOwner.revoke(turnToken);
                if (next.outcome.type === "error") {
                  recoveryPlan = surfaceRecovery.recoveryPlan(
                    next.outcome.error, session, parsed, surfaceRecoveries, incoming.abortSignal,
                    durableRecoveryCheckpoint(),
                  );
                  if (recoveryPlan !== undefined) return;
                  const submittedError = submittedBrowserFailure(session, incoming.abortSignal?.aborted === true, next.outcome.error);
                  if (submittedError) throw submittedError;
                  throw next.outcome.error;
                }
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                structuredOutputValidator?.(next.outcome.answer);
                if (bufferStructuredOutput) emitTextDeltas([next.outcome.answer], emitRound);
                const answer = appendCompactionUserPrompt(
                  parsed,
                  next.outcome.answer,
                  emitRound,
                  useEnhancedWebSessionMode || manualRequest,
                );
                emitRoundBatch(buffer => emitBrowserCompletion(
                  { type: "final", answer },
                  estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { answer, reasoning: roundReasoning },
                    turnCapabilities, experimentalBiggerContext, automaticUsagePromptOptions),
                  buffer,
                ));
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              session.setOutstandingEvents(roundReasoning, session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitToolBatch(
                next.requests,
                estimateChatGptWebUsage(runtimeUsageInput(parsed, session),
                  { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities,
                  experimentalBiggerContext, automaticUsagePromptOptions),
                buffer,
              ));
              session.markOutstandingPublished();
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
          });
          if (recoveryPlan === undefined) break;
          surfaceRecoveries += 1;
          const recoveryInput = recoveryPlan.finalizationOnly ? finalizationRecoveryRequest(parsed) : parsed;
          console.warn(
            `[chatgpt-web] browser turn ${traceId} rebuilding surface from canonical state`
            + ` generation=${surfaceRecoveries} contextMessages=${parsed.context.messages.length}`
            + ` completedResults=${recoveryPlan.canonicalResultCount}`
            + ` finalizationOnly=${recoveryPlan.finalizationOnly}`,
          );
          await chatGptTurnSessions.retireAndWait(executionKey, incoming.abortSignal);
          session = await sessionForChatGptRequest(chatGptTurnSessions, executionKey, recoveryInput,
            () => startRuntimeForTurn(recoveryInput, environment, traceId, turnCapabilities), executionNamespace, useEnhancedWebSessionMode, traceId, incoming.abortSignal);
          await session.runExclusive(async () => { session.observeCanonicalRequest(parsed); });
        }
        if (useEnhancedWebSessionMode && parsed._localCompactionRequest) { const key = chatGptConversationKey(parsed, executionNamespace); if (key) await chatGptTurnSessions.retireConversationAndWait(key); }
      } catch (error) {
        if (observerAbort.signal.aborted && !session.runtime.manualControl) throw observerAbort.signal.reason;
        const failure = awaitingRuntime ? session.settledOutcome() : undefined;
        if (failure?.type === "error") error = failure.error;
        error = submittedStallFailure(session, incoming.abortSignal?.aborted === true, error) ?? error;
        if (parsed._compactionRequest && !incoming.abortSignal?.aborted) {
          error = new ChatGptWebAdapterError(error instanceof Error ? error.message : String(error), {
            status: error instanceof ChatGptWebAdapterError ? error.status : 409,
            errorType: error instanceof ChatGptWebAdapterError ? error.errorType : "invalid_request_error",
            code: error instanceof ChatGptWebAdapterError ? error.code : "compaction_handoff_failed",
            retryable: false, cause: error,
          });
        }
        const handledError = error instanceof ChatGptWebAdapterError && error.retryable
          ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, error)
          : error;
        if (handledError instanceof ChatGptWebAdapterError) {
          applyAutomaticSafetyFailure(handledError);
          if (promptFailureKey) chatGptWebTurnRetryPolicy.recordPromptIntegrityFailure(promptFailureKey, handledError);
        }
        if (!(error instanceof ChatGptWebAdapterError && error.retryable)) {
          chatGptWebTurnRetryPolicy.clear(retryKey);
        }
        if (chatGptSessionFailureDisposition(handledError) === "replay") {
          // A deterministic request failure remains replayable so a native reconnect cannot burn
          // another browser attempt. Every other failure retires the browser session: client
          // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
          // instead of replaying one rejected browser outcome for the registry's full TTL.
          session.cancel();
        } else {
          chatGptTurnSessions.retire(executionKey, session);
        }
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => brokerOwner.revoke(turnToken)).catch(() => {});
        }
        if (handledError instanceof ChatGptWebAdapterError) {
          emitRoundEvents([{
            type: "error",
            message: handledError.message,
            status: handledError.status,
            errorType: handledError.errorType,
            code: handledError.code,
            retryable: handledError.retryable,
          }]);
          return;
        }
        chatGptWebTurnRetryPolicy.clear(retryKey);
        session.failRound(roundKey, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      } catch (error) {
        if (error instanceof ChatGptWebAdapterError) applyAutomaticSafetyFailure(error);
        if (promptFailureKey && isChatGptPromptIntegrityMismatch(error)) {
          chatGptWebTurnRetryPolicy.recordPromptIntegrityFailure(promptFailureKey, error);
        }
        if (isChatGptPromptIntegrityMismatch(error) || error instanceof ChatGptAccountSafetyAdmissionError
          || (error instanceof ChatGptWebAdapterError
            && (error.code === "rate_limit_exceeded" || error.code === "chatgpt_account_safety_stop"))) {
          emit({
            type: "error",
            message: error.message,
            status: error.status,
            errorType: error.errorType,
            code: error.code,
            retryable: error.retryable,
          });
          return;
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
        if (!manualInteraction) {
          if (retainedSafetyTraceId) accountSafety.releaseTrace(retainedSafetyTraceId);
          accountSafety.status(automaticWebSessionLimitCount, automaticWebSessionLimitMinutes, activeSafetyTraceIds());
        }
      }
    },
  };
}
