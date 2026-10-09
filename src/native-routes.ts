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
  if (!error || typeof error !== "object") return { stage };
  for (const source of [error, "cause" in error ? error.cause : undefined]) {
    const code = source && typeof source === "object" && "code" in source ? source.code : undefined;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return { stage, code };
  }
  const name = "name" in error ? error.name : undefined;
  if (name === "AbortError") return { stage, code: "ABORT_ERR" };
  if (name === "TimeoutError") return { stage, code: "ETIMEDOUT" };
  return { stage };
}

type UpstreamModelCatalog =
  | { ok: true; status: number; statusText: string; headers: Headers; body: ArrayBuffer }
  | { ok: false; error: unknown; sent: boolean };

export class ModelCatalogFetches {
  private readonly attempts = new Map<string, {
    result: Promise<UpstreamModelCatalog>;
    abort: AbortController;
    waiters: number;
    sent: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly abandonedTimeoutMs = 30_000,
    private readonly unclaimedResultMs = 10_000,
  ) {}

  async fetch(
    request: Request,
    forward: (request: Request, markSent: () => void) => Promise<Response>,
  ): Promise<UpstreamModelCatalog> {
    const key = createHash("sha256")
      .update(JSON.stringify([new URL(request.url).search, [...request.headers].sort()]))
      .digest("hex");
    let attempt = this.attempts.get(key);
    if (!attempt) {
      const abort = new AbortController();
      const created = {
        abort,
        waiters: 0,
        sent: false,
        result: undefined as unknown as Promise<UpstreamModelCatalog>,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      created.result = (async (): Promise<UpstreamModelCatalog> => {
        try {
          const response = await forward(new Request(request, { signal: abort.signal }), () => { created.sent = true; });
          return {
            ok: true, status: response.status, statusText: response.statusText,
            headers: response.headers, body: await response.arrayBuffer(),
          };
        } catch (error) {
          return { ok: false, error, sent: created.sent };
        }
      })().then(result => {
        clearTimeout(created.timer);
        created.timer = undefined;
        // A client that retries just after its abandoned attempt finished may still take the result.
        const unclaimed = result.ok && result.status >= 200 && result.status < 300 && created.waiters === 0;
        if (unclaimed && this.attempts.get(key) === created) {
          created.timer = setTimeout(() => {
            if (this.attempts.get(key) === created) this.attempts.delete(key);
          }, this.unclaimedResultMs);
          created.timer.unref?.();
        } else if (this.attempts.get(key) === created) {
          this.attempts.delete(key);
        }
        return result;
      });
      attempt = created;
      this.attempts.set(key, attempt);
    }
    const joined = attempt;
    joined.waiters += 1;
    clearTimeout(joined.timer);
    joined.timer = undefined;
    let leave!: () => void;
    const left = new Promise<UpstreamModelCatalog>(resolve => {
      leave = () => resolve({
        ok: false,
        error: request.signal.reason ?? new DOMException("Model catalog request aborted", "AbortError"),
        sent: joined.sent,
      });
    });
    if (request.signal.aborted) leave();
    else request.signal.addEventListener("abort", leave, { once: true });
    try {
      const result = await Promise.race([joined.result, left]);
      if (result.ok && this.attempts.get(key) === joined) {
        // Delivered: the next request must ask upstream again.
        clearTimeout(joined.timer);
        this.attempts.delete(key);
      }
      return result;
    } finally {
      request.signal.removeEventListener("abort", leave);
      joined.waiters -= 1;
      if (joined.waiters === 0 && this.attempts.get(key) === joined && !joined.timer) {
        joined.timer = setTimeout(() => joined.abort.abort(
          new DOMException("Model catalog request was abandoned", "AbortError"),
        ), this.abandonedTimeoutMs);
        joined.timer.unref?.();
      }
    }
  }

  close(): void {
    for (const attempt of this.attempts.values()) {
      clearTimeout(attempt.timer);
      attempt.abort.abort(new DOMException("Model catalog request cancelled", "AbortError"));
    }
    this.attempts.clear();
  }
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
  clientSignal: AbortSignal = req.signal,
  shared?: ModelCatalogFetches,
): Promise<Response> {
  const cancelled = () => new Response(null, { status: 499 });
  if (clientSignal.aborted) return cancelled();
  let upstream: Response;
  let sent = false;
  const forward = (request: Request, markSent: () => void) => forwardNativeCodexRequest(request, "models", input => {
    markSent();
    return (fetchUpstream ?? fetchNativeCodex)(input);
  });
  try {
    if (shared) {
      const result = await shared.fetch(req, forward);
      if (!result.ok) {
        sent = result.sent;
        throw result.error;
      }
      upstream = new Response([101, 204, 205, 304].includes(result.status) ? null : result.body.slice(0), {
        status: result.status, statusText: result.statusText, headers: new Headers(result.headers),
      });
    } else {
      upstream = await forward(req, () => { sent = true; });
    }
  } catch (error) {
    if (clientSignal.aborted) return cancelled();
    onFailure?.(modelCatalogFailure(sent ? "transport" : "request", error));
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (clientSignal.aborted) return cancelled();
  if (!upstream.ok) {
    onFailure?.({ stage: "upstream" });
    return upstream;
  }
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    if (clientSignal.aborted) return cancelled();
    onFailure?.(modelCatalogFailure("catalog", error));
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  if (clientSignal.aborted) return cancelled();
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
