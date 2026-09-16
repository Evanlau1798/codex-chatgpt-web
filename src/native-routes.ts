import { createHash } from "node:crypto";
import { formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import { augmentNativeModelCatalog } from "./model-catalog";
import { fetchNativeCodex } from "./native-network";
import {
  forwardNativeCodexRequest,
  type NativeFetch,
  type NativeImageEndpoint,
} from "./native-passthrough";

export interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog";
  code?: string;
}

export function modelCatalogFailure(stage: ModelCatalogFailure["stage"], error: unknown): ModelCatalogFailure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return { stage, ...(typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { code } : {}) };
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
): Promise<Response> {
  let upstream: Response;
  let sent = false;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", input => {
      sent = true;
      return (fetchUpstream ?? fetchNativeCodex)(input);
    });
  } catch (error) {
    onFailure?.(modelCatalogFailure(sent ? "transport" : "request", error));
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) {
    onFailure?.({ stage: "upstream" });
    return upstream;
  }
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    onFailure?.(modelCatalogFailure("catalog", error));
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(req: Request, fetchUpstream?: NativeFetch): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

export function nativeAuxiliaryEndpoint(pathname: string): "alpha/search" | NativeImageEndpoint | undefined {
  if (pathname === "/v1/alpha/search") return "alpha/search";
  if (pathname === "/v1/images/generations") return "images/generations";
  if (pathname === "/v1/images/edits") return "images/edits";
}

export async function nativeAuxiliaryRequest(
  req: Request,
  endpoint: "alpha/search" | NativeImageEndpoint,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  const authorization = req.headers.get("authorization") ?? "";
  if (endpoint !== "alpha/search"
    && (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length)) {
    return formatErrorResponse(401, "authentication_error", "Native image requests require incoming Codex Bearer authorization");
  }
  try {
    return await forwardNativeCodexRequest(req, endpoint, fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
