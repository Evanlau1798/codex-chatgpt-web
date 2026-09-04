import { randomUUID } from "node:crypto";
import {
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { estimateTokens } from "../../lib/token-estimate";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  compiledChatGptWebMaxMessageChars,
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
}

export interface PreparedChatGptWebMultipartTransport {
  transactionId: string;
  stages: ChatGptWebMultipartStage[];
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
  partCount: 2 | 3,
  transport?: MultipartBoundaryEvidence,
): void {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new ChatGptWebAdapterError(
      "Bigger Context is unavailable for Luna because every later browser request includes the accumulated transcript inside the same 28,000-token transport budget.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  const { contextWindow: baseContextWindow } = resolveChatGptWebContextLimits(
    modelId,
    effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
  ): void => {
    const limits = resolveChatGptWebTransportLimits(modelId, messageEffort, capabilities);
    if (limits.browserComposerCharLimit !== undefined
      && messageChars > limits.browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${limits.browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (limits.browserMessageTokenLimit !== undefined
      && messageTokens > limits.browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${limits.browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
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
    );
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  const experimentalContextWindow = baseContextWindow * partCount;
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "three-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  requestedEffort: ChatGptWebModelMode["effort"],
  maxStageMessageTokens: number,
  maxStageChars: number,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID || !capabilities.solAvailable) {
    throw new ChatGptWebAdapterError(
      "Bigger Context staging is unavailable for a Luna-only account.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const efforts: readonly ChatGptWebModelMode["effort"][] = capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  const requestedContextWindow = resolveChatGptWebContextLimits(
    modelId,
    requestedEffort,
    capabilities,
  ).contextWindow;
  for (const effort of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, effort, capabilities);
    const contextWindow = resolveChatGptWebContextLimits(modelId, effort, capabilities).contextWindow;
    if (contextWindow < requestedContextWindow) continue;
    const limits = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
    const tokenFits = limits.browserMessageTokenLimit === undefined
      || maxStageMessageTokens <= limits.browserMessageTokenLimit;
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
  const maxStageMessageTokens = Math.max(...stages.map(stage => estimateTokens(stage.text, modelId)));
  const maxStageChars = Math.max(...stages.map(stage => stage.text.length));
  const stagingMode = resolveChatGptWebMultipartStagingMode(
    modelId,
    capabilities,
    requestedEffort,
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
      finalMessageTokens: estimateTokens(finalPrompt, modelId),
      finalMessageChars: finalPrompt.length,
    },
  );
  return { transactionId, stages, finalPrompt, stagingMode };
}
