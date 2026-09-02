import { resolve } from "node:path";
import { expandUserPath } from "../../config";
import { withStallTimeout } from "../../stall-timeout";
import { type AdapterEvent, type CodexParsedRequest, type CodexProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ChatGptWebAdapterError, chatGptSessionFailureDisposition } from "./adapter-error";
import { chatGptAdapterRuntimeConfig } from "./adapter-runtime-config";
import { createChatGptRuntimeStarter, type ChatGptRuntimeWorker } from "./adapter-runtime-factory";
import { ChatGptBrowserWorker } from "./browser-worker";
import { codexToolResultsById } from "./compaction-handoff";
import { runEnhancedCompaction } from "./enhanced-compaction";
import { extractChatGptTurnEnvironment } from "./environment";
import { resolveChatGptWebModelMode } from "./model";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { brokerSocketPath, ChatGptSurfaceRecoveryTracker, withAbort } from "./runtime-lifecycle";
import { CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS } from "./turn-progress";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { chatGptCompactionSourceExecutionKey, chatGptConversationKey, chatGptTurnExecutionKey, chatGptTurnSessions, chatGptTurnTraceId, type ChatGptTraceEvent } from "./turn-execution";
import { chatGptTurnRetryKey } from "./turn-retry-identity";
import { appendCompactionUserPrompt, emitBrowserCompletion, emitProContextWarning, emitTextDeltas, emitToolBatch, emitTraceEvents, replayEvents, runtimeUsageInput } from "./turn-events";
import { estimateChatGptWebUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { resolveTrustedCodexEnvironment } from "./trusted-environment-lifecycle";
import { deliverPendingChatGptSteering, sessionForChatGptRequest, validateBatchTools } from "./steering";
import { completeChatGptToolResults } from "./tool-result-delivery";
import { effectiveChatGptToolPolicy } from "./tool-policy";
import { chatGptAgentLifecycleOptions } from "./agent-session-lifecycle";
import { submittedBrowserFailure, submittedStallFailure } from "./submitted-turn";
import { ChatGptLunaCheckpointStore } from "./rolling-checkpoint";
export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return chatGptAdapterRuntimeConfig(provider).executionNamespace;
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  return chatGptTurnTraceId(parsed, chatGptWebExecutionNamespace(provider));
}

export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: { broker?: TurnBrokerOwner; worker?: ChatGptRuntimeWorker } = {},
): ProviderAdapter {
  const worker = dependencies.worker ?? ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const brokerOwner = dependencies.broker ?? broker;
  const {
    timeoutMs,
    useEnhancedWebSessionMode,
    experimentalBiggerContext,
    configuredCapabilities,
    executionNamespace,
  } = chatGptAdapterRuntimeConfig(provider);
  const environmentStore = new ChatGptThreadEnvironmentStore(provider.chatgptWeb?.threadEnvironmentStatePath ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath)) : undefined);
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(provider.chatgptWeb?.lunaCheckpointStatePath ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath)) : undefined);
  const startRuntime = createChatGptRuntimeStarter({
    provider,
    worker,
    broker,
    brokerOwner,
    timeoutMs,
    useEnhancedWebSessionMode,
    experimentalBiggerContext,
    configuredCapabilities,
    executionNamespace,
    lunaCheckpointStore,
  });
  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      emit({ type: "heartbeat" });
      try {
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "ChatGPT Web cannot read this legacy or provider-private encrypted agent message. "
          + "Start a new enhanced Web task so Codex can use direct plaintext Multi-Agent V2 transport.",
        );
      }
      const toolPolicy = effectiveChatGptToolPolicy(parsed); const turnCapabilities = parsed._compactionRequest ? { ...configuredCapabilities, localToolsEnabled: false }
        : { ...configuredCapabilities, localToolsEnabled: configuredCapabilities.localToolsEnabled && toolPolicy.tools.length > 0 };
      const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      if (toolPolicy.requireTool && !mode.localTools) throw new Error("ChatGPT tool_choice requires local tools that this Web mode cannot expose");
      const structuredOutputValidator = parsed._compactionRequest
        ? undefined
        : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
      const bufferStructuredOutput = structuredOutputValidator !== undefined;
      const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
      const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
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
      if (mode.localTools) {
        environment = resolveTrustedCodexEnvironment(environmentStore, parsed);
      }
      if (parsed._compactionRequest) {
        const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`; if (useEnhancedWebSessionMode) {
          const enhancedCompaction = await runEnhancedCompaction({
            worker, parsed, broker, executionNamespace, capabilities: turnCapabilities,
            responseExecutionKey, nativeConnectorAvailable: configuredCapabilities.localToolsEnabled,
            abortSignal: incoming.abortSignal, timeoutMs, emit,
            startFallback: async (fallbackTraceId, signal) => {
              const runtime = startRuntime(parsed, undefined, fallbackTraceId, turnCapabilities);
              try {
                return await withAbort(runtime.browser, signal);
              } catch (error) {
                runtime.cancel(error instanceof Error ? error : new Error(String(error)));
                await runtime.browser.catch(() => {});
                throw error;
              }
            },
          });
          if (enhancedCompaction === "completed") return;
          console.info("[chatgpt-web] Web session mode=enhanced path=reconstructed_compact result=started");
        } else {
          console.info("[chatgpt-web] compact mode=original path=upstream_compact result=started");
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
      }
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      await chatGptTurnSessions.waitForRetirement(executionKey, incoming.abortSignal);
      const traceId = chatGptTurnTraceId(parsed, executionNamespace);
      let session = await sessionForChatGptRequest(chatGptTurnSessions, executionKey, parsed,
        () => startRuntime(parsed, environment, traceId, turnCapabilities), executionNamespace, useEnhancedWebSessionMode, traceId, incoming.abortSignal);
      if (session.runtime.mode === "tools" && !environment) {
        environment = resolveTrustedCodexEnvironment(environmentStore, parsed);
      }
      let surfaceRecoveries = 0;
      const surfaceRecovery = new ChatGptSurfaceRecoveryTracker(traceId);
      try {
        await session.runExclusive(async () => { session.observeCanonicalRequest(parsed); });
        for (;;) {
          let recoveredResultCount: number | undefined;
          await session.runExclusive(async () => {
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") {
              recoveredResultCount = surfaceRecovery.recoverableResultCount(
                settled.error, session, parsed, surfaceRecoveries, incoming.abortSignal,
              );
              if (recoveredResultCount !== undefined) return;
              const submittedError = submittedBrowserFailure(
                session,
                incoming.abortSignal?.aborted === true,
                settled.error,
              );
              if (submittedError) throw submittedError;
              throw settled.error;
            }
            let reasoning = session.reasoningForFinalReplay();
            const replay = session.eventsForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
            } else {
              const events: AdapterEvent[] = [];
              const emitCaptured = (event: AdapterEvent) => {
                events.push(event);
                emit(event);
              };
              if (!parsed._compactionRequest) emitProContextWarning(parsed, turnCapabilities, emitCaptured);
              const trace = session.runtime.trace.drain();
              reasoning = trace.map(event => event.text);
              emitTraceEvents(trace, emitCaptured);
              const completedTextDeltas = session.runtime.text.drain();
              if (!bufferStructuredOutput) emitTextDeltas(completedTextDeltas, emitCaptured);
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) emitTextDeltas([settled.answer], emitCaptured);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(events);
            }
            const answer = appendCompactionUserPrompt(parsed, settled.answer, emit, useEnhancedWebSessionMode);
            emitBrowserCompletion(
              { ...settled, answer },
              estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { answer, reasoning }, turnCapabilities),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            await brokerOwner.updateEnvironment(turnToken, environment);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = [...codexToolResultsById(parsed, session).values()];
              if (results.length === 0) {
                const steering = useEnhancedWebSessionMode
                  ? deliverPendingChatGptSteering(session, broker, turnToken, traceId)
                  : undefined;
                if (!steering) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  replayEvents(session.eventsForOutstandingReplay(), emit);
                  emitToolBatch(outstanding, estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { reasoning, toolRequests: outstanding }, turnCapabilities), emit);
                  return;
                }
              } else {
                await completeChatGptToolResults(session, brokerOwner, turnToken, results,
                  chatGptAgentLifecycleOptions(environmentStore, parsed, chatGptTurnSessions, executionNamespace));
                if (useEnhancedWebSessionMode) deliverPendingChatGptSteering(session, broker, turnToken, traceId);
              }
            } else if (useEnhancedWebSessionMode) deliverPendingChatGptSteering(session, broker, turnToken, traceId);
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
          }
          const toolWaitAbort = new AbortController();
          try {
            const roundReasoning: string[] = [];
            const roundEvents: AdapterEvent[] = [];
            const emitRound = (event: AdapterEvent) => {
              roundEvents.push(event);
              emit(event);
            };
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
              roundReasoning.push(...trace.map(event => event.text));
              emitTraceEvents(trace, emitRound);
            };
            const emitNewText = (deltas: string[]) => {
              if (!bufferStructuredOutput) emitTextDeltas(deltas, emitRound);
            };
            if (!parsed._compactionRequest) emitProContextWarning(parsed, turnCapabilities, emitRound);
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            const nextTools = turnToken
              ? brokerOwner.nextToolBatch(turnToken, toolWaitAbort.signal).then(requests => ({ type: "tools" as const, requests }))
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              let next: Awaited<typeof browserOutcome | NonNullable<typeof nextTools> | typeof nextTrace | typeof nextText>;
              try {
                next = await withAbort(withStallTimeout(Promise.race([
                  ...(nextTools ? [nextTools] : []), browserOutcome, nextTrace, nextText,
                ])), incoming.abortSignal);
              } catch (error) {
                recoveredResultCount = surfaceRecovery.recoverableResultCount(error, session, parsed, surfaceRecoveries, incoming.abortSignal);
                if (recoveredResultCount !== undefined) return;
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
              if (next.type === "browser") {
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                if (turnToken) await brokerOwner.revoke(turnToken);
                if (next.outcome.type === "error") {
                  recoveredResultCount = surfaceRecovery.recoverableResultCount(
                    next.outcome.error, session, parsed, surfaceRecoveries, incoming.abortSignal,
                  );
                  if (recoveredResultCount !== undefined) return;
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
                  useEnhancedWebSessionMode,
                );
                emitBrowserCompletion(
                  { ...next.outcome, answer },
                  estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { answer, reasoning: roundReasoning }, turnCapabilities),
                  emit,
                );
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, next.requests);
              const toolBatchRevision = session.setOutstanding(next.requests, roundReasoning, roundEvents);
              if (toolBatchRevision !== undefined && session.runtime.externalProgress) {
                const observationTimeout = new AbortController();
                const timer = setTimeout(
                  () => observationTimeout.abort(),
                  CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS,
                );
                try {
                  await session.runtime.externalProgress.waitForToolBatchObservation(
                    toolBatchRevision,
                    AbortSignal.any([toolWaitAbort.signal, observationTimeout.signal]),
                  );
                } catch (error) {
                  if (observationTimeout.signal.aborted && !toolWaitAbort.signal.aborted) {
                    throw new Error(
                      `ChatGPT browser did not acknowledge Codex tool batch ${toolBatchRevision}`
                      + ` within ${CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS}ms`,
                      { cause: error },
                    );
                  }
                  throw error;
                } finally {
                  clearTimeout(timer);
                }
              }
              emitToolBatch(
                next.requests,
                estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities),
                emit,
              );
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
          });
          if (recoveredResultCount === undefined) break;
          surfaceRecoveries += 1;
          console.warn(
            `[chatgpt-web] browser turn ${traceId} rebuilding tool surface from canonical state`
            + ` generation=${surfaceRecoveries} contextMessages=${parsed.context.messages.length}`
            + ` completedResults=${recoveredResultCount}`,
          );
          await chatGptTurnSessions.retireAndWait(executionKey, incoming.abortSignal);
          session = await sessionForChatGptRequest(chatGptTurnSessions, executionKey, parsed,
            () => startRuntime(parsed, environment, traceId, turnCapabilities), executionNamespace, useEnhancedWebSessionMode, traceId, incoming.abortSignal);
          await session.runExclusive(async () => { session.observeCanonicalRequest(parsed); });
        }
        if (useEnhancedWebSessionMode && parsed._localCompactionRequest) { const key = chatGptConversationKey(parsed, executionNamespace); if (key) await chatGptTurnSessions.retireConversationAndWait(key); }
      } catch (error) {
        error = submittedStallFailure(session, incoming.abortSignal?.aborted === true, error) ?? error;
        const handledError = error instanceof ChatGptWebAdapterError && error.retryable
          ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, error)
          : error;
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
          emit({
            type: "error",
            message: handledError.message,
            status: handledError.status,
            errorType: handledError.errorType,
            code: handledError.code,
            retryable: handledError.retryable,
          });
          return;
        }
        chatGptWebTurnRetryPolicy.clear(retryKey);
        throw error;
      }
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
