import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import {
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebInputTokens,
} from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
  type ChatGptWebMultipartPartCount,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";
import { effectiveChatGptToolPolicy } from "./tool-policy";
import { claudeSteeringMarker } from "./tool-result-delivery";

// Placeholders have production handle lengths; input-tokens charges variable bytes conservatively.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";
const ESTIMATE_REQUEST_ID = "request_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

export function chatGptUsageInputForRound(
  parsed: CodexParsedRequest,
  prepared: CodexParsedRequest,
): CodexParsedRequest {
  return parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID ? prepared : parsed;
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: Pick<CompileChatGptWebPromptOptions, "nativeControlConnector" | "experimentalMultipartParts"> = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const token = manual ? ESTIMATE_REQUEST_ID
    : mode.localTools && effectiveChatGptToolPolicy(parsed).tools.length > 0 ? ESTIMATE_TURN_TOKEN : undefined;
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    token,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId,
    token ? [token, claudeSteeringMarker(token)] : []);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits can
 * require more parts even when the total token estimate is small. Compaction always receives all
 * three parts without passing through the legacy inline budget.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (parsed._compactionRequest) return CHATGPT_BIGGER_CONTEXT_PARTS;
  const { contextWindow, autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools && effectiveChatGptToolPolicy(parsed).tools.length > 0 ? ESTIMATE_TURN_TOKEN : undefined,
    { experimentalMultipartParts: parts },
  );
  const inline = compile();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, autoCompactTokenLimit, false);
  if (initialParts === CHATGPT_BIGGER_CONTEXT_PARTS) return initialParts;

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(
        CHATGPT_WEB_BACKEND_MODEL, effort, capabilities,
      );
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL,
        effort,
        capabilities,
        final ? estimateChatGptWebImageTokens(compiled) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) < contextWindow * messages.length;
  };
  if (initialParts === undefined && fits(inline)) return undefined;
  return fits(compile(2)) ? 2 : CHATGPT_BIGGER_CONTEXT_PARTS;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities)
      : undefined,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
