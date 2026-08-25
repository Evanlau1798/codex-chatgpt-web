import { resolve } from "node:path";
import { expandUserPath } from "../../config";
import { withStallTimeout } from "../../stall-timeout";
import { type AdapterEvent, type CodexParsedRequest, type CodexProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ChatGptWebAdapterError, chatGptSessionFailureDisposition } from "./adapter-error";
import { chatGptAdapterRuntimeConfig, retainedConversationRelease } from "./adapter-runtime-config";
import { ChatGptBrowserWorker } from "./browser-worker";
import { claudeBrowserTurnOptions, isClaudeClientSession } from "./claude-subagent";
import { prepareChatGptWebContext } from "./context-bootstrap";
import { activeCompactionRuntimeHooks, codexToolResultsById, createActiveCompactionHandoffPrompts } from "./compaction-handoff";
import { runEnhancedCompaction } from "./enhanced-compaction";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { reportChatGptPreparationFailure } from "./preparation-diagnostics";
import { compileChatGptWebPrompt } from "./prompt";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { brokerSocketPath, ChatGptSurfaceRecoveryTracker, deferred, withAbort } from "./runtime-lifecycle";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptSteeringFeed, ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptConversationKey, chatGptTurnExecutionKey, chatGptTurnSessions, chatGptTurnTraceId, type ChatGptTraceEvent, type ChatGptTurnRuntime } from "./turn-execution";
import { chatGptTurnRetryKey } from "./turn-retry-identity";
import { appendCompactionUserPrompt, emitBrowserCompletion, emitProContextWarning, emitTextDeltas, emitToolBatch, emitTraceEvents, replayEvents, runtimeUsageInput } from "./turn-events";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { resolveTrustedCodexEnvironment } from "./trusted-environment-lifecycle";
import { browserSteeringRetry, deliverPendingChatGptSteering, retainedConversationResumeRequest, sessionForChatGptRequest, validateBatchTools } from "./steering";
import { completeChatGptToolResults } from "./tool-result-delivery";
import { assertChatGptToolRequirementSatisfied, effectiveChatGptToolPolicy } from "./tool-policy";
import { chatGptAgentLifecycleOptions } from "./agent-session-lifecycle";
import { submittedBrowserFailure, submittedStallFailure } from "./submitted-turn";
import { ChatGptLunaCheckpointStore, type CapturedChatGptLunaCheckpoint } from "./rolling-checkpoint";
import { createChatGptSameSurfaceRetry } from "./same-surface-recovery";
import { ChatGptToolEvidenceGuard } from "./tool-evidence-guard";
export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return chatGptAdapterRuntimeConfig(provider).executionNamespace;
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  return chatGptTurnTraceId(parsed, chatGptWebExecutionNamespace(provider));
}

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: { broker?: TurnBrokerOwner } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
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
  const startRuntime = (parsed: CodexParsedRequest, environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string, turnCapabilities: ChatGptWebCapabilities): ChatGptTurnRuntime => {
    const toolPolicy = effectiveChatGptToolPolicy(parsed);
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const nativeControlConnector = useEnhancedWebSessionMode && configuredCapabilities.localToolsEnabled;
    if (toolPolicy.requireTool && !mode.localTools) throw new Error("ChatGPT tool_choice requires local tools that this Web mode cannot expose");
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint ? lunaCheckpointStore.apply(parsed) : { parsed, applied: false };
    const experimentalMultipartParts = experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(checkpointInput.parsed, turnCapabilities)
      : undefined;
    const compileOptions = {
      captureLunaCheckpoint,
      nativeControlConnector,
      ...(experimentalMultipartParts === undefined ? {} : { experimentalMultipartParts }),
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) { checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint"); return; }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    const contextTtlMs = timeoutMs === undefined ? undefined : timeoutMs + 60_000;
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const steering = captureLunaCheckpoint || !useEnhancedWebSessionMode ? undefined : new ChatGptSteeringFeed();
    let activeToken: string | undefined;
    let toolResultDelivered = false;
    const toolEvidence = mode.localTools && !parsed._compactionRequest ? new ChatGptToolEvidenceGuard() : undefined;
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    const handoffPrompts = useEnhancedWebSessionMode ? createActiveCompactionHandoffPrompts() : undefined;
    const runtimeExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
    const { retainConversation: requestedRetention, retryPromptForAnswer: upstreamRetry } = claudeBrowserTurnOptions(
      checkpointInput.parsed, handoffPrompts?.retryPromptForAnswer,
      { toolResultDelivered: () => toolResultDelivered, turnToken: () => activeToken },
    );
    const evidenceRetry = toolEvidence
      ? async (answer: string, attempt: number) => (
        await upstreamRetry?.(answer, attempt) ?? toolEvidence.retryPromptForAnswer(answer)
      )
      : upstreamRetry;
    const retainConversation = useEnhancedWebSessionMode && requestedRetention;
    const conversationKey = retainConversation ? chatGptConversationKey(checkpointInput.parsed, executionNamespace) : undefined;
    const releaseRetainedConversation = retainedConversationRelease(provider, conversationKey);
    const resumeInput = conversationKey ? retainedConversationResumeRequest(checkpointInput.parsed) : undefined;
    const retryPromptForAnswer = parsed._compactionRequest || !steering ? evidenceRetry : browserSteeringRetry(steering, traceId, evidenceRetry, () => activeToken ? broker.takeUndeliveredSteering(activeToken) : undefined, isClaudeClientSession(checkpointInput.parsed));
    const retryPromptForError = createChatGptSameSurfaceRetry({ traceId, executionKey: runtimeExecutionKey, enhancedMode: useEnhancedWebSessionMode, abortSignal: browserAbort.signal, upstream: handoffPrompts?.retryPromptForError });
    const emitCommentary = (value: string, continuation?: boolean): void => {
      if (toolEvidence && !toolEvidence.shouldEmitCommentary(value)) return;
      trace.push({ kind: "commentary", text: value, ...(continuation ? { continuation: true } : {}) });
    };
    if (!mode.localTools) {
      const base = {
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => prepareChatGptWebContext(broker,
          compileChatGptWebPrompt(checkpointInput.parsed, turnCapabilities, undefined, compileOptions),
          useEnhancedWebSessionMode, contextTtlMs, traceId),
        ...(resumeInput ? {
          prepareResume: async () => prepareChatGptWebContext(
            broker,
            compileChatGptWebPrompt(resumeInput, turnCapabilities, undefined, compileOptions),
            useEnhancedWebSessionMode,
            contextTtlMs,
            traceId,
          ),
        } : {}),
        ...(retainConversation ? { retainConversation: true } : {}),
        ...(conversationKey ? { conversationKey } : {}),
        abortSignal: browserAbort.signal,
        ...(captureLunaCheckpoint ? { captureLunaCheckpoint: true, onLunaCheckpoint: captureCheckpoint } : {}),
      };
      const browserRun = worker.run({
        ...base,
        traceId,
        ...(nativeControlConnector ? { nativeConnector: true } : {}),
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        onReasoningSummary: (value, continuation) => trace.push({ kind: "reasoning", text: value, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: emitCommentary,
        onProgress: () => trace.signalProgress(),
        onSendActivated: () => { submission.phase = "send_activated"; },
        onSubmitted: () => { submission.phase = "accepted"; },
        onTextDelta: delta => text.push(delta),
        ...(retryPromptForAnswer ? { retryPromptForAnswer } : {}),
        ...(retryPromptForError ? { retryPromptForError } : {}),
      });
      const browser = finalizeCheckpoint(browserRun);
      return {
        mode: "read-only",
        browser,
        trace,
        text, conversationKey,
        ...(steering ? { steering } : {}),
        usageInput: checkpointInput.parsed,
        submission,
        ...(handoffPrompts ? activeCompactionRuntimeHooks(handoffPrompts, instruction => worker.requestPreemptiveRetry(traceId, instruction)) : {}),
        cancel: () => browserAbort.abort(),
        ...(releaseRetainedConversation ? { release: releaseRetainedConversation } : {}),
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    let tokenSettled = false;
    const prepareWith = async (input: CodexParsedRequest, source: "full" | "resume") => {
      const turnToken = activeToken ?? await brokerOwner.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
        () => trace.signalProgress(),
      );
      activeToken = turnToken;
      if (!tokenSettled) {
        tokenSettled = true;
        token.resolve(turnToken);
      }
      try {
        return await prepareChatGptWebContext(broker,
          compileChatGptWebPrompt(input, turnCapabilities, turnToken, compileOptions),
          useEnhancedWebSessionMode, contextTtlMs, traceId);
      } catch (error) {
        const failure = reportChatGptPreparationFailure(traceId, source, input, error);
        throw failure;
      }
    };
    const browserRun = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      prepare: () => prepareWith(checkpointInput.parsed, "full"),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput, "resume") } : {}),
      ...(retainConversation ? { retainConversation: true } : {}),
      ...(conversationKey ? { conversationKey } : {}),
      abortSignal: browserAbort.signal,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: emitCommentary,
      onProgress: () => trace.signalProgress(),
      onSendActivated: () => { submission.phase = "send_activated"; },
      onSubmitted: () => { submission.phase = "accepted"; },
      onTextDelta: delta => text.push(delta),
      ...(retryPromptForAnswer ? { retryPromptForAnswer } : {}),
      ...(retryPromptForError ? { retryPromptForError } : {}),
      ...(captureLunaCheckpoint ? { captureLunaCheckpoint: true, onLunaCheckpoint: captureCheckpoint } : {}),
    });
    const browser = finalizeCheckpoint(toolPolicy.requireTool ? browserRun.then(answer => {
      assertChatGptToolRequirementSatisfied(toolPolicy, toolResultDelivered); return answer;
    }) : browserRun);
    // Let an active runTurn observe the authoritative browser outcome before revoking its broker
    // waiter. Detached browser failures still release the token on the next event-loop turn.
    void browser.catch(() => setTimeout(() => activeToken && void Promise.resolve(brokerOwner.revoke(activeToken)).catch(() => {}), 0));
    void browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      browser,
      trace,
      text, conversationKey,
      ...(steering ? { steering } : {}),
      usageInput: checkpointInput.parsed,
      submission,
      onToolResultDelivered: result => {
        toolResultDelivered = true;
        if (result) toolEvidence?.observeToolResult(result);
      },
      ...(handoffPrompts ? activeCompactionRuntimeHooks(handoffPrompts, instruction => worker.requestPreemptiveRetry(traceId, instruction)) : {}),
      cancel: (reason?: Error) => {
        browserAbort.abort(reason);
        if (activeToken) void Promise.resolve(brokerOwner.revoke(activeToken, reason)).catch(error => {
          console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      ...(releaseRetainedConversation ? { release: releaseRetainedConversation } : {}),
    };
  };
  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
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
          });
          if (enhancedCompaction === "completed") return;
          console.info("[chatgpt-web] Web session mode=enhanced path=reconstructed_compact result=started");
        } else {
          console.info("[chatgpt-web] compact mode=original path=upstream_compact result=started");
          await chatGptTurnSessions.retireAndWait(responseExecutionKey);
        }
      }
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      await chatGptTurnSessions.waitForRetirement(executionKey);
      const traceId = chatGptTurnTraceId(parsed, executionNamespace);
      let session = await sessionForChatGptRequest(chatGptTurnSessions, executionKey, parsed,
        () => startRuntime(parsed, environment, traceId, turnCapabilities), executionNamespace, useEnhancedWebSessionMode, traceId);
      if (session.runtime.mode === "tools" && !environment) {
        environment = resolveTrustedCodexEnvironment(environmentStore, parsed);
      }
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      let surfaceRecoveries = 0;
      const surfaceRecovery = new ChatGptSurfaceRecoveryTracker(traceId);
      try {
        emit({ type: "heartbeat" });
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
              emitTextDeltas(session.runtime.text.drain(), emitCaptured);
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
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
            const emitNewText = (deltas: string[]) => emitTextDeltas(deltas, emitRound);
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
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, next.requests);
              session.setOutstanding(next.requests, roundReasoning, roundEvents);
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
          await chatGptTurnSessions.retireAndWait(executionKey);
          session = await sessionForChatGptRequest(chatGptTurnSessions, executionKey, parsed,
            () => startRuntime(parsed, environment, traceId, turnCapabilities), executionNamespace, useEnhancedWebSessionMode, traceId);
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
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
