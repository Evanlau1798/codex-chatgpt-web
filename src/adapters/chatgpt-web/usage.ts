import { skillFileTokens } from "./skill-attachments";
import { ChatGptWebAdapterError } from "./adapter-error";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebBiggerContext,
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
  options: Pick<CompileChatGptWebPromptOptions,
    "nativeControlConnector" | "useEnhancedOutputTunnel" | "experimentalMultipartParts" | "experimentalSkillAttachments" | "captureLunaCheckpoint"> = {},
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
      captureLunaCheckpoint: options.captureLunaCheckpoint ?? (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId)),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId,
    token ? [token, claudeSteeringMarker(token)] : []);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction always receives all six parts without passing through the legacy inline budget.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (!supportsChatGptWebBiggerContext(parsed.modelId, mode.effort, capabilities, parsed._chatgptModelFamily)) return undefined;
  if (parsed._compactionRequest) return CHATGPT_BIGGER_CONTEXT_PARTS;
  const backendModel = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID ? CHATGPT_WEB_LUNA_MODEL_ID : CHATGPT_WEB_BACKEND_MODEL;
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    backendModel,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
    false,
    parsed._chatgptModelFamily,
  );
  const contextWindow = resolveChatGptWebMessageTokenBudget(backendModel, mode.effort, capabilities)
    + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools && effectiveChatGptToolPolicy(parsed).tools.length > 0 ? ESTIMATE_TURN_TOKEN : undefined,
    { experimentalMultipartParts: parts, experimentalSkillAttachments, captureLunaCheckpoint: false },
  );
  const inline = compile();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, autoCompactTokenLimit, false);
  const fits = (compiled: CompiledChatGptWebPrompt): boolean => multipartPromptFits(
    compiled,
    parsed,
    capabilities,
    mode.effort,
    messages => Math.min(
      resolveChatGptWebContextLimits(backendModel, mode.effort,
        { ...capabilities, experimentalBiggerContext: true }, false, parsed._chatgptModelFamily).contextWindow,
      contextWindow * Math.min(messages, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER),
    ),
  );
  if (initialParts === undefined && fits(inline)) return undefined;
  if (initialParts !== CHATGPT_BIGGER_CONTEXT_PARTS && fits(compile(2))) return 2;
  if (fits(compile(CHATGPT_BIGGER_CONTEXT_PARTS))) return CHATGPT_BIGGER_CONTEXT_PARTS;
  throw new ChatGptWebAdapterError(
    "No Bigger Context partition can carry every whole record within the measured message limits. Compact the task before retrying.",
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

function multipartPromptFits(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  effort: ReturnType<typeof resolveChatGptWebModelMode>["effort"],
  inputLimit: (messageCount: number) => number,
): boolean {
  const messages = compiledChatGptWebMessages(compiled);
  const backendModel = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID ? CHATGPT_WEB_LUNA_MODEL_ID : CHATGPT_WEB_BACKEND_MODEL;
  const stagingEffort = backendModel === CHATGPT_WEB_LUNA_MODEL_ID ? "low" : capabilities.proAvailable ? "max" : "medium";
  for (const [index, text] of messages.entries()) {
    const final = index === messages.length - 1;
    const messageEffort = final ? effort : stagingEffort;
    const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      backendModel, messageEffort, capabilities,
    );
    if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
    const budget = resolveChatGptWebMessageTokenBudget(
      backendModel,
      messageEffort,
      capabilities,
      final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
    );
    if (estimateTokens(text, parsed.modelId) > budget) return false;
  }
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
    < inputLimit(messages.length);
}

/** Rebuild a lost Enhanced finalization surface within its existing 256K/272K model window. */
export function resolveEnhancedRecoveryMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebMultipartPartCount | undefined {
  if (parsed._chatgptFinalizationOnly !== true) {
    throw new Error("Enhanced recovery multipart transport is valid only for finalization recovery");
  }
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId) || parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Enhanced recovery multipart transport is unavailable for this model");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const { contextWindow } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
    true,
  );
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => (
    compileChatGptWebPrompt(parsed, capabilities, undefined, {
      experimentalMultipartParts: parts,
      experimentalSkillAttachments,
    })
  );
  const fits = (compiled: CompiledChatGptWebPrompt): boolean => multipartPromptFits(
    compiled, parsed, capabilities, mode.effort, () => contextWindow,
  );
  const inline = compile();
  if (fits(inline)) return undefined;
  for (const parts of [2, CHATGPT_BIGGER_CONTEXT_PARTS] as const) {
    if (fits(compile(parts))) return parts;
  }
  throw new ChatGptWebAdapterError(
    "The complete Enhanced recovery context cannot fit the selected model window. Compact the task before retrying.",
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
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
  promptOptions: Pick<CompileChatGptWebPromptOptions,
    "nativeControlConnector" | "useEnhancedOutputTunnel" | "experimentalSkillAttachments"> = {},
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    ...promptOptions,
    ...(experimentalBiggerContext ? { captureLunaCheckpoint: false } : {}),
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, promptOptions.experimentalSkillAttachments)
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
