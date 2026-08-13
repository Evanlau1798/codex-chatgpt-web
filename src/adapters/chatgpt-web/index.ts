import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expandUserPath } from "../../config";
import { withStallTimeout } from "../../stall-timeout";
import { type AdapterEvent, type CodexParsedRequest, type CodexProviderConfig } from "../../types";
import type { ProviderAdapter } from "../base";
import { ChatGptWebAdapterError, chatGptSessionFailureDisposition } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import { claudeBrowserTurnOptions, claudeRootSessionThreadId } from "./claude-subagent";
import { prepareChatGptWebContext } from "./context-bootstrap";
import { canonicalizeCompactionHandoff, codexToolResultsById, createActiveCompactionHandoffPrompts, recoverCompactionHandoff } from "./compaction-handoff";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { compileChatGptWebPrompt } from "./prompt";
import { brokerSocketPath, deferred, recoverableToolSurfaceResultCount, withAbort } from "./runtime-lifecycle";
import { TurnBroker } from "./turn-broker";
import { ChatGptSteeringFeed, ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptConversationKey, chatGptTurnExecutionKey, chatGptTurnSessions, chatGptTurnTraceId, type ChatGptTraceEvent, type ChatGptTurnRuntime } from "./turn-execution";
import { appendCompactionUserPrompt, emitBrowserCompletion, emitProContextWarning, emitTextDeltas, emitToolBatch, emitTraceEvents, replayEvents, runtimeUsageInput } from "./turn-events";
import { estimateChatGptWebUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import { inheritSpawnedCodexEnvironment, resolveTrustedCodexEnvironment } from "./trusted-environment-lifecycle";
import { browserSteeringRetry, deliverPendingChatGptSteering, retainedConversationResumeRequest, sessionForChatGptRequest, validateBatchTools } from "./steering";
import { completeChatGptToolResults } from "./tool-result-delivery";
import { submittedBrowserFailure, submittedStallFailure } from "./submitted-turn";
import { ChatGptLunaCheckpointStore, type CapturedChatGptLunaCheckpoint } from "./rolling-checkpoint";
import { requestCompactionHandoff } from "./retained-compaction-handoff";
export function createChatGptWebAdapter(provider: CodexProviderConfig): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const useNewCompactMode = provider.chatgptWeb?.useNewCompactMode === true;
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const executionNamespace = createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (!capturedCheckpoint) throw new Error("ChatGPT Luna completed without a captured rolling checkpoint");
      lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    const contextTtlMs = timeoutMs === undefined ? undefined : timeoutMs + 60_000;
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const steering = captureLunaCheckpoint ? undefined : new ChatGptSteeringFeed();
    let activeToken: string | undefined;
    let toolResultDelivered = false;
    const submission = { accepted: false };
    const handoffPrompts = useNewCompactMode ? createActiveCompactionHandoffPrompts() : undefined;
    const { retainConversation, retryPromptForAnswer: upstreamRetry } = claudeBrowserTurnOptions(
      checkpointInput.parsed,
      handoffPrompts?.retryPromptForAnswer,
      {
        toolResultDelivered: () => toolResultDelivered,
        turnToken: () => activeToken,
      },
    );
    const conversationKey = retainConversation ? chatGptConversationKey(checkpointInput.parsed, executionNamespace) : undefined;
    const resumeInput = conversationKey ? retainedConversationResumeRequest(checkpointInput.parsed) : undefined;
    const retryPromptForAnswer = parsed._compactionRequest || !steering ? upstreamRetry : browserSteeringRetry(steering, traceId, upstreamRetry, () => activeToken ? broker.takeUndeliveredSteering(activeToken) : undefined, Boolean(claudeRootSessionThreadId(checkpointInput.parsed)));
    if (!mode.localTools) {
      const base = {
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => prepareChatGptWebContext(broker, compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            { captureLunaCheckpoint },
          ), useNewCompactMode, contextTtlMs, traceId),
        ...(resumeInput ? {
          prepareResume: async () => prepareChatGptWebContext(broker,
            compileChatGptWebPrompt(resumeInput, turnCapabilities, undefined, { captureLunaCheckpoint }),
            useNewCompactMode, contextTtlMs, traceId),
        } : {}),
        ...(retainConversation ? { retainConversation: true } : {}),
        ...(conversationKey ? { conversationKey } : {}),
        abortSignal: browserAbort.signal,
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      };
      const browserRun = worker.run({
        ...base,
        traceId,
        onReasoningSummary: (value, continuation) => trace.push({ kind: "reasoning", text: value, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (value, continuation) => trace.push({ kind: "commentary", text: value, ...(continuation ? { continuation: true } : {}) }),
        onProgress: () => trace.signalProgress(),
        onSubmitted: () => { submission.accepted = true; },
        onTextDelta: delta => text.push(delta),
        ...(retryPromptForAnswer ? { retryPromptForAnswer } : {}),
        ...(handoffPrompts ? { retryPromptForError: handoffPrompts.retryPromptForError } : {}),
      });
      const browser = finalizeCheckpoint(browserRun);
      return {
        mode: "read-only",
        browser,
        trace,
        text,
        ...(steering ? { steering } : {}),
        usageInput: checkpointInput.parsed,
        submission,
        ...(handoffPrompts ? { requestHandoff: handoffPrompts.request } : {}),
        cancel: () => browserAbort.abort(),
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    let tokenSettled = false;
    const prepareWith = async (input: CodexParsedRequest) => {
      const turnToken = activeToken ?? await broker.register(
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
          compileChatGptWebPrompt(input, turnCapabilities, turnToken, { captureLunaCheckpoint }),
          useNewCompactMode, contextTtlMs, traceId);
      } catch (error) {
        broker.revoke(turnToken);
        throw error;
      }
    };
    const browser = finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: () => prepareWith(checkpointInput.parsed),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput) } : {}),
      ...(retainConversation ? { retainConversation: true } : {}),
      ...(conversationKey ? { conversationKey } : {}),
      abortSignal: browserAbort.signal,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onProgress: () => trace.signalProgress(),
      onSubmitted: () => { submission.accepted = true; },
      onTextDelta: delta => text.push(delta),
      ...(retryPromptForAnswer ? { retryPromptForAnswer } : {}),
      ...(handoffPrompts ? { retryPromptForError: handoffPrompts.retryPromptForError } : {}),
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    }));
    // Let an active runTurn observe the authoritative browser outcome before revoking its broker
    // waiter. Detached browser failures still release the token on the next event-loop turn.
    void browser.catch(() => setTimeout(() => activeToken && broker.revoke(activeToken), 0));
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
      text,
      ...(steering ? { steering } : {}),
      usageInput: checkpointInput.parsed,
      submission,
      onToolResultDelivered: () => { toolResultDelivered = true; },
      ...(handoffPrompts ? { requestHandoff: handoffPrompts.request } : {}),
      cancel: () => {
        browserAbort.abort();
        if (activeToken) broker.revoke(activeToken);
      },
    };
  };
  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "ChatGPT Web subagents currently require a V1-rooted task. "
          + "Refresh the Codex model catalog and start a new task; an existing V2 task cannot migrate surfaces. "
          + "Codex MultiAgent V2 encrypts cross-backend task payloads.",
        );
      }
      const turnCapabilities = parsed._compactionRequest
        ? { ...configuredCapabilities, localToolsEnabled: false }
        : configuredCapabilities;
      const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
      if (mode.localTools) {
        environment = resolveTrustedCodexEnvironment(environmentStore, parsed);
      }
      if (parsed._compactionRequest) {
        const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
        if (useNewCompactMode) {
          const sourceSession = chatGptTurnSessions.find(responseExecutionKey); const activeHandoff = sourceSession ? await requestCompactionHandoff(
            worker, parsed, sourceSession, broker, executionNamespace, turnCapabilities,
            createHash("sha256").update(`${responseExecutionKey}:handoff`).digest("hex").slice(0, 12), incoming.abortSignal, timeoutMs,
          ) : undefined;
          const handoff = canonicalizeCompactionHandoff(
            parsed,
            activeHandoff ?? recoverCompactionHandoff(parsed) ?? "",
          );
          await chatGptTurnSessions.retireAndWait(responseExecutionKey);
          if (handoff) {
            console.info("[chatgpt-web] compact mode=beta path=active_handoff result=completed");
            emit({ type: "text_delta", text: handoff, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: handoff },
              estimateChatGptWebUsage(parsed, { answer: handoff, reasoning: [] }, turnCapabilities),
              emit,
            );
            return;
          }
          console.warn("[chatgpt-web] compact mode=beta path=active_handoff result=unavailable");
          throw new ChatGptWebAdapterError(
            "The beta compact mode could not obtain a checkpoint from the active ChatGPT Web conversation. Retry the compact request or disable the beta mode to use the original compact path.",
            {
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_handoff_unavailable",
              retryable: false,
            },
          );
        }
        console.info("[chatgpt-web] compact mode=original path=upstream_compact result=started");
        await chatGptTurnSessions.retireAndWait(responseExecutionKey);
      }
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      await chatGptTurnSessions.waitForRetirement(executionKey);
      const traceId = chatGptTurnTraceId(parsed, executionNamespace);
      let session = await sessionForChatGptRequest(
        chatGptTurnSessions,
        executionKey,
        parsed,
        () => startRuntime(parsed, environment, traceId, turnCapabilities),
      );
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      let surfaceRecoveries = 0;
      try {
        emit({ type: "heartbeat" });
        for (;;) {
          let recoveredResultCount: number | undefined;
          await session.runExclusive(async () => {
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") {
              recoveredResultCount = recoverableToolSurfaceResultCount(
                settled.error,
                session,
                parsed,
                surfaceRecoveries,
                incoming.abortSignal,
              );
              if (recoveredResultCount !== undefined) return;
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
            const answer = appendCompactionUserPrompt(parsed, settled.answer, emit, useNewCompactMode);
            emitBrowserCompletion(
              { ...settled, answer },
              estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { answer, reasoning }, turnCapabilities),
              emit,
            );
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            broker.updateEnvironment(turnToken, environment);
            deliverPendingChatGptSteering(session, broker, turnToken, traceId);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = [...codexToolResultsById(parsed, session).values()];
              if (results.length === 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(outstanding, estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { reasoning, toolRequests: outstanding }, turnCapabilities), emit);
                return;
              }
              completeChatGptToolResults(session, broker, turnToken, results, {
                onSpawnedCodexAgent: childThreadId => inheritSpawnedCodexEnvironment(environmentStore, parsed, childThreadId),
              });
            }
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
              ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(requests => ({ type: "tools" as const, requests }))
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              const next = await withAbort(
                withStallTimeout(Promise.race([
                  ...(nextTools ? [nextTools] : []),
                  browserOutcome,
                  nextTrace,
                  nextText,
                ])),
                incoming.abortSignal,
              );
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
                if (turnToken) broker.revoke(turnToken);
                if (next.outcome.type === "error") {
                  const submittedError = submittedBrowserFailure(session, incoming.abortSignal?.aborted === true, next.outcome.error);
                  if (submittedError) throw submittedError;
                  recoveredResultCount = recoverableToolSurfaceResultCount(
                    next.outcome.error,
                    session,
                    parsed,
                    surfaceRecoveries,
                    incoming.abortSignal,
                  );
                  if (recoveredResultCount !== undefined) return;
                  throw next.outcome.error;
                }
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                const answer = appendCompactionUserPrompt(
                  parsed,
                  next.outcome.answer,
                  emitRound,
                  useNewCompactMode,
                );
                emitBrowserCompletion(
                  { ...next.outcome, answer },
                  estimateChatGptWebUsage(runtimeUsageInput(parsed, session), { answer, reasoning: roundReasoning }, turnCapabilities),
                  emit,
                );
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
          session = await sessionForChatGptRequest(
            chatGptTurnSessions,
            executionKey,
            parsed,
            () => startRuntime(parsed, environment, traceId, turnCapabilities),
          );
        }
      } catch (error) {
        error = submittedStallFailure(session, incoming.abortSignal?.aborted === true, error) ?? error;
        if (chatGptSessionFailureDisposition(error) === "replay") {
          // A deterministic request failure remains replayable so a native reconnect cannot burn
          // another browser attempt. Every other failure retires the browser session: client
          // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
          // instead of replaying one rejected browser outcome for the registry's full TTL.
          session.cancel();
        } else {
          chatGptTurnSessions.retire(executionKey, session);
        }
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
        }
        if (error instanceof ChatGptWebAdapterError) {
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
      }
    },
  };
}
