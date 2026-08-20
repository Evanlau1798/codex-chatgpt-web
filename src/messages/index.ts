import type { ProviderAdapter } from "../adapters/base";
import { createChatGptWebAdapter } from "../adapters/chatgpt-web";
import { ChatGptWebAdapterError } from "../adapters/chatgpt-web/adapter-error";
import { bindClaudeSessionAbort } from "../adapters/chatgpt-web/claude-subagent";
import { chatGptTurnSessions } from "../adapters/chatgpt-web/turn-execution";
import { estimateChatGptWebInputTokens } from "../adapters/chatgpt-web/usage";
import { requireChatGptWebModelRoute } from "../chatgpt-web-models";
import { providerConfig, type AppConfig } from "../config";
import { AsyncEventQueue } from "../event-queue";
import { readJsonRequestBody } from "../http-body";
import { parseRequest } from "../responses/parser";
import { COMPACT_PROMPT } from "../responses/compaction";
import type { AdapterEvent, CodexProviderConfig } from "../types";
import { anthropicError, buildClaudeMessage, streamClaudeMessage } from "./response";
import { translateClaudeMessages } from "./request";
import { chatGptTurnSteeringId } from "../adapters/chatgpt-web/turn-execution";
import { compactClaudeEvents, compactClaudeStream } from "./compact";

type AdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

function parsedClaudeRequest(raw: unknown, req: Request, config: AppConfig) {
  const translated = translateClaudeMessages(
    raw,
    req.headers,
    (threadId, turnId, instruction) => chatGptTurnSessions.claudeSteeringSuppressionCountBySteeringId(
      chatGptTurnSteeringId(threadId, turnId),
      instruction,
    ),
  );
  const parsed = parseRequest(translated.body);
  parsed._canonicalContextComplete = true;
  const route = requireChatGptWebModelRoute(parsed.modelId, config);
  parsed.modelId = route.backendModel;
  parsed.options.reasoning = route.adapterEffort;
  if (translated.compact) {
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }
  const compactMessages = translated.compact && raw && typeof raw === "object" && !Array.isArray(raw)
    && Array.isArray((raw as { messages?: unknown }).messages)
    ? (raw as { messages: unknown[] }).messages
    : [];
  return { translated, parsed, route, compactMessages };
}

function capabilities(config: AppConfig) {
  return {
    localToolsEnabled: config.mode === "full",
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
  };
}

export async function messagesRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: AdapterFactory = createChatGptWebAdapter,
): Promise<Response> {
  let request: ReturnType<typeof parsedClaudeRequest>;
  try {
    request = parsedClaudeRequest(await readJsonRequestBody(req), req, config);
  } catch (error) {
    return anthropicError(error instanceof Error ? error.message : String(error));
  }
  if (request.translated.suppressedSteeringReplays > 0) {
    console.info(`[chatgpt-web] suppressed acknowledged Claude queued-command replays count=${request.translated.suppressedSteeringReplays}`);
  }

  let inputTokens = 0;
  try { inputTokens = estimateChatGptWebInputTokens(request.parsed, capabilities(config)); } catch {}
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    let unbindSessionAbort = () => {};
    try {
      if (request.translated.auxiliaryResponse) {
        queue.push({ type: "text_delta", text: request.translated.auxiliaryResponse });
        queue.push({ type: "done", stopReason: "stop", endTurn: true });
        return;
      }
      unbindSessionAbort = bindClaudeSessionAbort(request.parsed, abort.signal, chatGptTurnSessions);
      await adapterFactory(providerConfig(config)).runTurn(request.parsed, {
        headers: req.headers,
        abortSignal: abort.signal,
      }, event => queue.push(event));
    } catch (error) {
      queue.push(error instanceof ChatGptWebAdapterError
        ? {
            type: "error",
            message: error.message,
            status: error.status,
            errorType: error.errorType,
            code: error.code,
            retryable: error.retryable,
          }
        : { type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      unbindSessionAbort();
      queue.close();
    }
  };
  const meta = { model: request.translated.requestedModel, inputTokens };
  if (request.translated.stream) {
    void run();
    return new Response(streamClaudeMessage(
      request.translated.compact ? compactClaudeStream(queue, request.compactMessages) : queue,
      meta,
      () => abort.abort(),
    ), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
    });
  }
  await run();
  const events = await queue.collect();
  return buildClaudeMessage(
    request.translated.compact ? compactClaudeEvents(events, request.compactMessages) : events,
    meta,
  );
}
