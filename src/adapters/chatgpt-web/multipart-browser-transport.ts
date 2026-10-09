import { randomUUID } from "node:crypto";
import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_ERROR,
  supportsChatGptWebBiggerContext,
  type ChatGptWebModelFamily,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebStagingTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { skillFileTokens } from "./skill-attachments";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  compiledChatGptWebMaxMessageChars,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebInputTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  formatChatGptWebMultipartCommit,
  isChatGptWebMultipartPartCount,
  formatChatGptWebMultipartStage,
  type ChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
} from "./prompt";

interface MultipartBoundaryEvidence {
  stagingEffort: ChatGptWebModelMode["effort"];
  maxStageMessageTokens: number;
  maxStageChars: number;
  finalMessageTokens: number;
  finalMessageChars: number;
  finalImageTokens?: number;
}

export interface PreparedChatGptWebMultipartTransport {
  transactionId: string;
  stages: ChatGptWebMultipartStage[];
  stageMessageTokens: number[];
  finalPrompt: string;
  stagingMode: ChatGptWebModelMode;
}

export function assertChatGptWebMultipartInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  maxMessageChars: number,
  partCount: number,
  transport?: {
    stagingEffort: ChatGptWebModelMode["effort"];
    maxStageMessageTokens: number;
    maxStageChars: number;
    finalMessageTokens: number;
    finalMessageChars: number;
    finalImageTokens?: number;
  },
  modelFamily?: ChatGptWebModelFamily,
  useEnhancedWebSessionMode = false,
): void {
  if (!isChatGptWebMultipartPartCount(partCount)) {
    throw new Error("Bigger Context requires two or six context parts");
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  if (!supportsChatGptWebBiggerContext(modelId, effort, capabilities, modelFamily)) {
    throw new Error(CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_ERROR);
  }
  const baseContextWindow = resolveChatGptWebMessageTokenBudget(modelId, effort, capabilities)
    + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
    imageTokens = 0,
  ): void => {
    const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      modelId,
      messageEffort,
      capabilities,
    );
    if (browserComposerCharLimit !== undefined && messageChars > browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (browserMessageTokenLimit !== undefined && messageTokens > browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    const messageBudget = label === "stage"
      ? resolveChatGptWebStagingTokenBudget(modelId, messageEffort, capabilities)
      : resolveChatGptWebMessageTokenBudget(modelId, messageEffort, capabilities, imageTokens);
    if (messageTokens > messageBudget) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds its ${messageBudget.toLocaleString("en-US")}-token input budget after reserving space for ChatGPT and attachments. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };
  if (transport) {
    assertMessageBoundary(
      "stage",
      transport.maxStageMessageTokens,
      transport.maxStageChars,
      transport.stagingEffort,
    );
    assertMessageBoundary(
      "final part",
      transport.finalMessageTokens,
      transport.finalMessageChars,
      effort,
      transport.finalImageTokens,
    );
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  // More transport messages do not enlarge the model's advertised context window.
  const { contextWindow } = resolveChatGptWebContextLimits(
    modelId, effort, { ...capabilities, experimentalBiggerContext: !useEnhancedWebSessionMode }, useEnhancedWebSessionMode, modelFamily,
  );
  const experimentalContextWindow = Math.min(contextWindow, baseContextWindow * partCount);
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "six-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  maxStageMessageTokens: number,
  maxStageChars: number,
): ChatGptWebModelMode {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const efforts: readonly ChatGptWebModelMode["effort"][] = modelId === CHATGPT_WEB_LUNA_MODEL_ID ? ["low"] : capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  for (const effort of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, effort, capabilities);
    const limits = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
    const messageTokenLimit = resolveChatGptWebStagingTokenBudget(modelId, effort, capabilities);
    const tokenFits = maxStageMessageTokens <= messageTokenLimit;
    const charsFit = limits.browserComposerCharLimit === undefined
      || maxStageChars <= limits.browserComposerCharLimit;
    if (tokenFits && charsFit) return mode;
  }
  throw new ChatGptWebAdapterError(
    `No ChatGPT effort available to this account can carry a Bigger Context stage with ${maxStageMessageTokens.toLocaleString("en-US")} estimated tokens and ${maxStageChars.toLocaleString("en-US")} characters.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function prepareChatGptWebMultipartTransport(
  prepared: CompiledChatGptWebPrompt,
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  requestedEffort: ChatGptWebModelMode["effort"],
  modelFamily?: ChatGptWebModelFamily,
  useEnhancedWebSessionMode = false,
): PreparedChatGptWebMultipartTransport | undefined {
  if (!prepared.multipart) return undefined;
  const transactionId = `ctx_${randomUUID().replaceAll("-", "")}`;
  const stages = prepared.multipart.parts.slice(0, -1).map((payload, index) => (
    formatChatGptWebMultipartStage(
      payload,
      transactionId,
      index + 1,
      prepared.multipart!.parts.length,
    )
  ));
  const finalPrompt = formatChatGptWebMultipartCommit(prepared.multipart, transactionId);
  const stageMessageTokens = stages.map(stage => estimateTokens(stage.text, modelId));
  const maxStageMessageTokens = Math.max(...stageMessageTokens);
  const maxStageChars = Math.max(...stages.map(stage => stage.text.length));
  const stagingMode = resolveChatGptWebMultipartStagingMode(
    modelId,
    capabilities,
    maxStageMessageTokens,
    maxStageChars,
  );
  assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(prepared, modelId),
    estimateCompiledChatGptWebMessageTokens(prepared, modelId),
    modelId,
    requestedEffort,
    capabilities,
    compiledChatGptWebMaxMessageChars(prepared),
    prepared.multipart.parts.length,
    {
      stagingEffort: stagingMode.effort,
      maxStageMessageTokens,
      maxStageChars,
      finalMessageTokens: estimateTokens(finalPrompt, modelId) + skillFileTokens(prepared.skillFiles, modelId),
      finalMessageChars: finalPrompt.length,
      finalImageTokens: estimateChatGptWebImageTokens(prepared),
    },
    modelFamily,
    useEnhancedWebSessionMode,
  );
  return { transactionId, stages, stageMessageTokens, finalPrompt, stagingMode };
}
