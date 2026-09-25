import type { CodexParsedRequest, CodexProviderConfig } from "../../types";
import { retainedConversationRelease } from "./adapter-runtime-config";
import { ChatGptBrowserWorker } from "./browser-worker";
import { claudeBrowserTurnOptions, isClaudeClientSession } from "./claude-subagent";
import { observeCapabilityRetirement } from "./capability-retirement";
import { prepareChatGptWebContext } from "./context-bootstrap";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { reportChatGptPreparationFailure } from "./preparation-diagnostics";
import { shouldUseEnhancedOutputTunnel } from "./native-output-control";
import { compileChatGptWebPrompt } from "./prompt";
import { ChatGptLunaCheckpointStore, type CapturedChatGptLunaCheckpoint } from "./rolling-checkpoint";
import { EnhancedRecoveryCheckpointStore } from "./enhanced-recovery-checkpoint";
import { deferred } from "./runtime-lifecycle";
import { createChatGptSameSurfaceRetry } from "./same-surface-recovery";
import { browserSteeringRetry, retainedConversationResumeRequest } from "./steering";
import { ChatGptToolEvidenceGuard } from "./tool-evidence-guard";
import { assertChatGptToolRequirementSatisfied, effectiveChatGptToolPolicy } from "./tool-policy";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptConversationKey,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
  type ChatGptTurnRuntime,
} from "./turn-execution";
import { resolveBiggerContextMultipartParts } from "./usage";

interface ChatGptRuntimeFactoryOptions {
  provider: CodexProviderConfig;
  worker: ChatGptRuntimeWorker;
  broker: TurnBroker;
  brokerOwner: TurnBroker | TurnBrokerOwner;
  timeoutMs?: number;
  useEnhancedWebSessionMode: boolean;
  useEnhancedOutputTunnel: boolean;
  experimentalFreshConversationPerTurn: boolean;
  experimentalBiggerContext: boolean;
  experimentalSkillAttachments: boolean;
  configuredCapabilities: ChatGptWebCapabilities;
  executionNamespace: string;
  lunaCheckpointStore: ChatGptLunaCheckpointStore;
  enhancedRecoveryCheckpointStore: EnhancedRecoveryCheckpointStore;
}

export type ChatGptRuntimeWorker = Pick<ChatGptBrowserWorker, "run">
  & Partial<Pick<ChatGptBrowserWorker, "requestPreemptiveRetry">>;

export function createChatGptRuntimeStarter(options: ChatGptRuntimeFactoryOptions) {
  const {
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
  } = options;
  return (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: { onCompactionProgress?: () => void } = {},
  ): ChatGptTurnRuntime => {
    const toolPolicy = effectiveChatGptToolPolicy(parsed);
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const nativeControlConnector = useEnhancedWebSessionMode && configuredCapabilities.localToolsEnabled;
    if (toolPolicy.requireTool && !mode.localTools) throw new Error("ChatGPT tool_choice requires local tools that this Web mode cannot expose");
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest && Boolean(identity.threadId && identity.turnId);
    const captureEnhancedCheckpoint = useEnhancedWebSessionMode
      && provider.chatgptWeb?.experimentalNoAutoCompact === true
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest;
    const checkpointInput = captureLunaCheckpoint ? lunaCheckpointStore.apply(parsed)
      : captureEnhancedCheckpoint ? enhancedRecoveryCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const experimentalMultipartParts = experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(checkpointInput.parsed, turnCapabilities, experimentalSkillAttachments)
      : undefined;
    const tunneledOutput = shouldUseEnhancedOutputTunnel(parsed, {
      requested: nativeControlConnector && useEnhancedOutputTunnel,
      localTools: mode.localTools,
      toolCount: toolPolicy.tools.length,
      luna: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID,
      captureLunaCheckpoint,
      multipart: experimentalMultipartParts !== undefined,
    });
    const compileOptions = {
      captureLunaCheckpoint,
      ...(experimentalSkillAttachments ? { experimentalSkillAttachments: true } : {}),
      nativeControlConnector,
      ...(tunneledOutput ? { useEnhancedOutputTunnel: true } : {}),
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
    const externalProgress = new ChatGptExternalTurnProgress();
    const steering = captureLunaCheckpoint ? undefined : new ChatGptSteeringFeed();
    const lunaSafetySteering = captureLunaCheckpoint ? new ChatGptSteeringFeed() : undefined;
    const finalAnswerAdmissionFeed = steering ?? lunaSafetySteering;
    const finalAnswerAdmission = finalAnswerAdmissionFeed ? {
      seal: () => finalAnswerAdmissionFeed.sealCompletion(),
      reopen: () => finalAnswerAdmissionFeed.reopenCompletion(),
    } : undefined;
    let activeToken: string | undefined;
    let browserOwnerSettled = false;
    let toolResultDelivered = false;
    const toolEvidence = mode.localTools && !parsed._compactionRequest ? new ChatGptToolEvidenceGuard() : undefined;
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    let runtimeExecutionKey: string;
    try {
      runtimeExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
    } catch (error) {
      throw reportChatGptPreparationFailure(traceId, "full", checkpointInput.parsed, error);
    }
    const { retainConversation: requestedRetention, retryPromptForAnswer: upstreamRetry } = claudeBrowserTurnOptions(
      checkpointInput.parsed, undefined,
      { toolResultDelivered: () => toolResultDelivered, turnToken: () => activeToken },
    );
    const evidenceRetry = toolEvidence
      ? async (answer: string, attempt: number) => (
        await upstreamRetry?.(answer, attempt) ?? toolEvidence.retryPromptForAnswer(answer)
      )
      : upstreamRetry;
    const retainConversation = requestedRetention && !experimentalFreshConversationPerTurn;
    let conversationKey: string | undefined;
    try {
      conversationKey = retainConversation ? chatGptConversationKey(checkpointInput.parsed, executionNamespace) : undefined;
    } catch (error) {
      throw reportChatGptPreparationFailure(traceId, "full", checkpointInput.parsed, error);
    }
    const releaseRetainedConversation = retainedConversationRelease(provider, conversationKey);
    // The passive checkpoint is for a fresh page only. A healthy retained page keeps its full
    // in-browser history and receives the ordinary incremental resume input.
    const resumeInput = conversationKey ? retainedConversationResumeRequest(parsed) : undefined;
    const takeBrokerSteering = useEnhancedWebSessionMode
      ? () => activeToken ? broker.takeUndeliveredSteering(activeToken) : undefined
      : undefined;
    const lunaSafetyRetry = lunaSafetySteering
      ? async (answer: string, attempt: number) => {
          const pending = lunaSafetySteering.peek();
          if (!pending) return evidenceRetry?.(answer, attempt);
          lunaSafetySteering.take(pending.count);
          return { text: pending.text, allowLunaCheckpointRetry: true };
        }
      : undefined;
    const taskAnswerRetry = parsed._compactionRequest
      ? evidenceRetry
      : steering
        ? browserSteeringRetry(steering, traceId, evidenceRetry, takeBrokerSteering, isClaudeClientSession(checkpointInput.parsed))
        : lunaSafetyRetry ?? evidenceRetry;
    const retryPromptForAnswer = taskAnswerRetry ? (answer: string, attempt: number) => (
      chatGptTurnSessions.find(runtimeExecutionKey)?.runtime.compactionRequested
        ? undefined : taskAnswerRetry(answer, attempt)
    ) : undefined;
    const retryPromptForError = createChatGptSameSurfaceRetry({ traceId, executionKey: runtimeExecutionKey, enhancedMode: useEnhancedWebSessionMode, abortSignal: browserAbort.signal });
    const emitCommentary = (value: string, continuation?: boolean): void => {
      if (toolEvidence && !toolEvidence.shouldEmitCommentary(value)) return;
      trace.push({ kind: "commentary", text: value, ...(continuation ? { continuation: true } : {}) });
    };
    if (!mode.localTools) {
      const base = {
        modelId: parsed.modelId,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
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
        onSubmitted: () => { submission.phase = "accepted"; hooks.onCompactionProgress?.(); },
        ...(hooks.onCompactionProgress ? { onMultipartStageAcknowledged: hooks.onCompactionProgress } : {}),
        onTextDelta: delta => text.push(delta),
        ...(retryPromptForAnswer ? { retryPromptForAnswer } : {}),
        ...(retryPromptForError ? { retryPromptForError } : {}),
        ...(finalAnswerAdmission ? { finalAnswerAdmission } : {}),
      });
      const browser = finalizeCheckpoint(browserRun);
      return {
        mode: "read-only",
        browser,
        trace,
        text, conversationKey,
        ...(steering ? { steering } : {}),
        ...(lunaSafetySteering ? { safetySteering: (instruction: string) => lunaSafetySteering.push(instruction) } : {}),
        usageInput: checkpointInput.parsed,
        submission,
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
        tunneledOutput,
      );
      try {
        const prepared = await prepareChatGptWebContext(broker,
          compileChatGptWebPrompt(input, turnCapabilities, turnToken, compileOptions),
          useEnhancedWebSessionMode, contextTtlMs, traceId);
        if (activeToken !== turnToken) {
          activeToken = turnToken;
          observeCapabilityRetirement(brokerOwner, turnToken, externalProgress, browserAbort, () => browserOwnerSettled);
        }
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return prepared;
      } catch (error) {
        try {
          await brokerOwner.revoke(turnToken, error instanceof Error ? error : undefined);
        } catch (revokeError) {
          console.error(`[chatgpt-web] failed to revoke unprepared turn token: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`);
        }
        if (activeToken === turnToken) activeToken = undefined;
        const failure = reportChatGptPreparationFailure(traceId, source, input, error);
        throw failure;
      }
    };
    const browserRun = worker.run({
      traceId,
      modelId: parsed.modelId,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      prepare: () => prepareWith(checkpointInput.parsed, "full"),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput, "resume") } : {}),
      ...(retainConversation ? { retainConversation: true } : {}),
      ...(conversationKey ? { conversationKey } : {}),
      abortSignal: browserAbort.signal,
      externalProgress,
      completionFence: {
        begin: async () => brokerOwner.beginCompletionFence(activeToken ?? await token.promise),
        commit: async revision => brokerOwner.commitCompletionFence(activeToken ?? await token.promise, revision),
      },
      ...(tunneledOutput ? { tunneledOutput: {
        next: async (afterSequence: number, signal?: AbortSignal) => brokerOwner.nextOutput(
          activeToken ?? await token.promise, afterSequence, signal,
        ),
        reset: async (finalSequence: number) => brokerOwner.resetOutput(
          activeToken ?? await token.promise, finalSequence,
        ),
        seal: async (afterSequence: number, expectedRevision: number) => brokerOwner.sealOutput(
          activeToken ?? await token.promise, afterSequence, expectedRevision,
        ),
      } } : {}),
      ...(finalAnswerAdmission ? { finalAnswerAdmission } : {}),
      onReasoningSummary: (value, continuation) => trace.push({ kind: "reasoning", text: value, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: emitCommentary,
      onProgress: () => trace.signalProgress(),
      onSendActivated: () => { submission.phase = "send_activated"; },
      onSubmitted: () => { submission.phase = "accepted"; hooks.onCompactionProgress?.(); },
        ...(hooks.onCompactionProgress ? { onMultipartStageAcknowledged: hooks.onCompactionProgress } : {}),
      onTextDelta: delta => text.push(delta),
      ...(retryPromptForAnswer ? { retryPromptForAnswer } : {}),
      ...(retryPromptForError ? { retryPromptForError } : {}),
      ...(captureLunaCheckpoint ? { captureLunaCheckpoint: true, onLunaCheckpoint: captureCheckpoint } : {}),
    });
    const trackedRun = browserRun.finally(() => { browserOwnerSettled = true; });
    const browser = finalizeCheckpoint(toolPolicy.requireTool ? trackedRun.then(answer => {
      assertChatGptToolRequirementSatisfied(toolPolicy, toolResultDelivered); return answer;
    }) : trackedRun);
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
      externalProgress,
      ...(steering ? { steering } : {}),
      ...(lunaSafetySteering ? { safetySteering: (instruction: string) => lunaSafetySteering.push(instruction) } : {}),
      usageInput: checkpointInput.parsed,
      submission,
      onToolResultDelivered: result => {
        toolResultDelivered = true;
        if (result) toolEvidence?.observeToolResult(result);
      },
      cancel: (reason?: Error) => {
        browserAbort.abort(reason);
        if (activeToken) void Promise.resolve(brokerOwner.revoke(activeToken, reason)).catch(error => {
          console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      ...(releaseRetainedConversation ? { release: releaseRetainedConversation } : {}),
    };
  };
}
