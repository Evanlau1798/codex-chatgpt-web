import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "./multipart-browser-transport";
export { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "./multipart-browser-transport";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  CHATGPT_WEB_GPT6_INSTANT_BIGGER_CONTEXT_ERROR,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebMultipartContextWindow,
  resolveChatGptWebStagingTokenBudget,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebBiggerContext,
  type ChatGptWebModelFamily,
} from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";
import { measureChatGptWebTransport } from "./input-tokens";
import {
  CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode,
  type ChatGptWebCapabilities, type ChatGptWebModelMode,
} from "./model";
import { isChatGptWebMultipartPartCount, type CompiledChatGptWebPrompt } from "./prompt";

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
    modelFamily,
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
/** Check the same formatted messages in transport selection and immediately before Send. */
export function checkChatGptWebTransport(
  compiled: CompiledChatGptWebPrompt, modelId: string, mode: ChatGptWebModelMode,
  caps: ChatGptWebCapabilities, family?: ChatGptWebModelFamily, transactionId?: string,
) {
  const transport = measureChatGptWebTransport(compiled, modelId, transactionId);
  const { estimatedInputTokens, finalMessageTokens, finalPrompt, maxMessageChars, maxStageMessageTokens, maxStageChars } = transport;
  if (!compiled.multipart) {
    assertChatGptWebInputWithinLimits(estimatedInputTokens, finalMessageTokens, modelId, mode.effort, caps, maxMessageChars, false, family);
    return { ...transport, stagingMode: mode };
  }
  const stagingMode = resolveChatGptWebMultipartStagingMode(modelId, caps, maxStageMessageTokens, maxStageChars, family);
  assertChatGptWebMultipartInputWithinLimits(
    estimatedInputTokens, Math.max(maxStageMessageTokens, finalMessageTokens), modelId, mode.effort, caps,
    maxMessageChars, compiled.multipart.parts.length, {
      stagingEffort: stagingMode.effort, maxStageMessageTokens, maxStageChars,
      finalMessageTokens, finalMessageChars: finalPrompt.length, finalImageTokens: transport.imageTokens,
    }, family,
  );
  return { ...transport, stagingMode };
}
