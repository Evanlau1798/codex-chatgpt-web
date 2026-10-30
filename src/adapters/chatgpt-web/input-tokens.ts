import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
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

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt): string[] {
  if (!compiled.multipart) return [compiled.text];
  return [
    ...compiled.multipart.parts.slice(0, -1).map((payload, index) => (
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).text
    )),
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
  ];
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length));
}

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const messages = compiledChatGptWebMessages(compiled);
  return Math.max(...messages.map((message, index) => estimateTokens(message, modelId)
    + (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0)));
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
  variableTokens: readonly string[] = [],
): number {
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const textTokens = (text: string) => estimateChatGptWebTextTokens(text, modelId, variableTokens);
  const messageTokens = compiledChatGptWebMessages(compiled)
    .reduce((total, message) => total + textTokens(message), 0);
  const acknowledgementTokens = compiled.multipart
    ? compiled.multipart.parts.slice(0, -1).reduce((total, payload, index) => total + textTokens(
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).acknowledgement,
    ), 0)
    : 0;
  return CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + messageTokens + acknowledgementTokens + imageTokens + skillFileTokens(compiled.skillFiles, modelId);
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}
