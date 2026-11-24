import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_ESTIMATE_TRANSACTION_ID,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "./prompt-multipart";
import type { CompiledChatGptWebPrompt } from "./prompt";

export const TOKEN_ESTIMATE_TRANSACTION = `ctx_${"0".repeat(32)}`;

/** Opaque ASCII handles cannot earn the repeated-zero placeholder's token discount. */
export function estimateChatGptWebTextTokens(text: string, modelId: string, variableTokens: readonly string[] = []): number {
  const count = (value: string, index: number): number => {
    const token = variableTokens[index];
    if (token === undefined) return estimateTokens(value, modelId);
    const parts = value.split(token);
    return (parts.length - 1) * Buffer.byteLength(token)
      + parts.reduce((total, part) => total + count(part, index + 1), 0);
  };
  return count(text, 0);
}

function formatChatGptWebTransport(compiled: CompiledChatGptWebPrompt, transactionId = CHATGPT_ESTIMATE_TRANSACTION_ID) {
  const multipart = compiled.multipart;
  const stages = multipart?.parts.slice(0, -1).map((part, i) =>
    formatChatGptWebMultipartStage(part, transactionId, i + 1, multipart.parts.length));
  const finalPrompt = multipart ? formatChatGptWebMultipartCommit(multipart, transactionId) : compiled.text;
  return { stages, finalPrompt };
}

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt): string[] {
  const { stages, finalPrompt } = formatChatGptWebTransport(compiled);
  return [...(stages ?? []).map(stage => stage.text), finalPrompt];
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
  transactionOrVariables?: string | readonly string[],
): number {
  return measureChatGptWebTransport(compiled, modelId,
    typeof transactionOrVariables === "string" ? transactionOrVariables : undefined,
    typeof transactionOrVariables === "string" ? [] : transactionOrVariables).estimatedInputTokens;
}

export function measureChatGptWebTransport(compiled: CompiledChatGptWebPrompt, modelId: string, transactionId?: string,
  variableTokens: readonly string[] = []) {
  const { stages, finalPrompt } = formatChatGptWebTransport(compiled, transactionId);
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const count = (text: string) => estimateChatGptWebTextTokens(text, modelId,
    transactionId ? variableTokens : [...variableTokens, CHATGPT_ESTIMATE_TRANSACTION_ID]);
  const finalMessageTokens = count(finalPrompt) + skillFileTokens(compiled.skillFiles, modelId);
  const stageMessageTokens = (stages ?? []).map(stage => count(stage.text));
  const stageTokens = (stages ?? []).reduce((sum, stage, i) =>
    sum + stageMessageTokens[i]! + count(stage.acknowledgement), 0);
  const maxStageChars = Math.max(0, ...(stages ?? []).map(stage => stage.text.length));
  return {
    stages, finalPrompt, finalMessageTokens, imageTokens, stageMessageTokens,
    estimatedInputTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + finalMessageTokens + stageTokens + imageTokens,
    maxStageMessageTokens: Math.max(0, ...stageMessageTokens), maxStageChars,
    maxMessageChars: Math.max(maxStageChars, finalPrompt.length),
  };
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length));
}

export function estimateCompiledChatGptWebMessageTokens(compiled: CompiledChatGptWebPrompt, modelId: string): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => estimateTokens(message, modelId)));
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}
