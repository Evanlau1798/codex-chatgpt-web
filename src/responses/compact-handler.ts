import { createChatGptWebAdapter } from "../adapters/chatgpt-web";
import type { ProviderAdapter } from "../adapters/base";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "../chatgpt-web-models";
import type { AppConfig } from "../config";
import { readJsonRequestBody } from "../http-body";
import { httpStatusFromTerminalError } from "../lib/errors";
import { forwardNativeCodexRequest } from "../native-passthrough";
import type { CodexProviderConfig } from "../types";
import { formatErrorResponse } from "../bridge";
import {
  decodeCompactionSummary,
  isUsableCompactionSummary,
} from "./compaction";
import { boundedCompactV1Output, CompactionBudgetExceeded } from "./compact-budget";
import { extractCodexTurnIdentityFromBody } from "../adapters/chatgpt-web/environment";
import type { ResponseRequestOptions } from "../server-dependencies";
import { parseRequest } from "./parser";
import { rememberCompletedCompaction } from "./compaction-continuation";

type AdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;
type ResponseHandler = (req: Request, config: AppConfig, adapterFactory: AdapterFactory, options?: ResponseRequestOptions) => Promise<Response>;

export async function handleCompactRequest(
  req: Request,
  config: AppConfig,
  responseRequest: ResponseHandler,
  adapterFactory: AdapterFactory = createChatGptWebAdapter,
  options: Pick<ResponseRequestOptions, "onTurnIdentity"> = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebModelRoute(raw.model, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (!Array.isArray(raw.input)) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires an input array");
  }
  const input = raw.input;
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, { ...options, rememberState: false });
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json({ error }, { status: httpStatusFromTerminalError(error) });
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  if (!isUsableCompactionSummary(summary)) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an unusable summary");
  }
  try {
    const output = boundedCompactV1Output(raw, summary, config, route);
    const parsed = parseRequest({ ...raw, input: [...input, { type: "compaction_trigger" }] });
    parsed.modelId = route.backendModel;
    parsed.options.reasoning = route.interactionMode === "automatic" ? route.adapterEffort : route.codexEffort;
    rememberCompletedCompaction(parsed, body, output);
    return Response.json({ output });
  } catch (error) {
    if (error instanceof CompactionBudgetExceeded) {
      // HTTP 400 is terminal to Codex; do not retry the same oversized input automatically.
      return Response.json({ error: {
        type: "invalid_request_error", code: "compaction_budget_exceeded", message: error.message,
        input_tokens: error.inputTokens, token_limit: error.tokenLimit,
      } }, { status: 400 });
    }
    return formatErrorResponse(400, "invalid_request_error", "Unable to validate compaction replacement context");
  }
}
