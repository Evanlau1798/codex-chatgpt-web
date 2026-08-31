import { readJsonRequestBody } from "./http-body";
import { safeDiagnosticIdentifier, safeErrorMetadata } from "./http-stream-diagnostics";
import { BRIDGE_COMPACTION_PREFIX, compactionItemToText } from "./responses/compaction";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";

const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const FIRST_PARTY_CODEX_ORIGINATORS = new Set([
  "codex_cli_rs",
  "codex-tui",
  "codex_vscode",
  "codex_atlas",
  "codex_chatgpt_desktop",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type NativeFetch = (request: Request) => Promise<Response>;
export type NativeCodexEndpoint = "models" | "responses" | "responses/compact" | "alpha/search";

export interface NativePassthroughDiagnostic {
  outcome: "completed" | "failed" | "aborted";
  endpoint: NativeCodexEndpoint;
  requestBytes: number;
  forwardedBytes: number;
  contentEncoding: "identity" | "zstd" | "other";
  bodyRewritten: boolean;
  inputItems: number;
  imageItems: number;
  imageUrlChars: number;
  summaryTruncated: boolean;
  visitedNodes: number;
  prepareMs: number;
  headersMs: number;
  upstreamStatus: number | null;
  requestId: string | null;
  errorPhase: "prepare" | "headers" | null;
  errorName: string | null;
  errorCode: string | null;
}

export type NativePassthroughReporter = (diagnostic: NativePassthroughDiagnostic) => void;

type JsonObject = Record<string, unknown>;

const NATIVE_DIAGNOSTIC_NODE_LIMIT = 100_000;

function firstPartyCodexOriginator(value: string): boolean {
  return FIRST_PARTY_CODEX_ORIGINATORS.has(value)
    || /^Codex [A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(value);
}

/**
 * Current Codex clients identify themselves as `<originator>/<cargo semver> (...)`. The models
 * backend requires the release-only `major.minor.patch` value even when the client is an alpha.
 * Derive it only from the documented first-party Codex prefix; an arbitrary browser or proxy
 * User-Agent is not evidence of a Codex version and leaves the original request untouched.
 */
export function codexClientVersionFromUserAgent(userAgent: string | null): string | undefined {
  if (!userAgent) return undefined;
  const separator = userAgent.indexOf("/");
  if (separator < 1) return undefined;
  const originator = userAgent.slice(0, separator);
  if (!firstPartyCodexOriginator(originator)) return undefined;
  const version = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/
    .exec(userAgent.slice(separator + 1));
  return version ? `${version[1]}.${version[2]}.${version[3]}` : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBridgeReasoningItem(value: unknown): value is JsonObject {
  if (!isObject(value) || value.type !== "reasoning") return false;
  const encrypted = value.encrypted_content;
  if (typeof encrypted === "string" && encrypted.startsWith(BRIDGE_REASONING_PREFIX)) return true;
  return typeof value.id === "string"
    && /^rs_[0-9a-f]{32}$/i.test(value.id)
    && (encrypted === undefined || encrypted === null)
    && (Array.isArray(value.summary) || Array.isArray(value.content));
}

function contentEncoding(headers: Headers): NativePassthroughDiagnostic["contentEncoding"] {
  const value = headers.get("content-encoding")?.trim().toLowerCase();
  if (!value || value === "identity") return "identity";
  return value === "zstd" ? "zstd" : "other";
}

type NativeInputSummary = Pick<
  NativePassthroughDiagnostic,
  "inputItems" | "imageItems" | "imageUrlChars" | "summaryTruncated" | "visitedNodes"
>;

function summarizeInput(value: unknown): NativeInputSummary {
  if (!isObject(value) || !Array.isArray(value.input)) {
    return {
      inputItems: 0,
      imageItems: 0,
      imageUrlChars: 0,
      summaryTruncated: false,
      visitedNodes: 0,
    };
  }
  const stack: unknown[] = [...value.input];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;
  let imageItems = 0;
  let imageUrlChars = 0;
  while (stack.length > 0 && visitedNodes < NATIVE_DIAGNOSTIC_NODE_LIMIT) {
    const current = stack.pop();
    visitedNodes += 1;
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) stack.push(current[index]);
      continue;
    }
    const object = current as JsonObject;
    if (object.type === "input_image" && typeof object.image_url === "string") {
      imageItems += 1;
      imageUrlChars += object.image_url.length;
    }
    for (const child of Object.values(object)) stack.push(child);
  }
  return {
    inputItems: value.input.length,
    imageItems,
    imageUrlChars,
    summaryTruncated: stack.length > 0,
    visitedNodes,
  };
}

function safeDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

function emitNativeDiagnostic(
  reporter: NativePassthroughReporter,
  diagnostic: NativePassthroughDiagnostic,
): void {
  try {
    reporter(diagnostic);
  } catch {
    // Diagnostics must never change passthrough behavior.
  }
}

export const reportNativePassthroughDiagnostic: NativePassthroughReporter = diagnostic => {
  const noteworthy = diagnostic.outcome !== "completed"
    || diagnostic.errorPhase !== null
    || diagnostic.upstreamStatus === null
    || diagnostic.upstreamStatus >= 400
    || diagnostic.summaryTruncated
    || diagnostic.prepareMs >= 1_000
    || diagnostic.headersMs >= 5_000;
  if (noteworthy) console.warn(`[native-passthrough] request timing ${JSON.stringify(diagnostic)}`);
};

function isBridgeCompactionItem(value: unknown): boolean {
  return isObject(value)
    && value.type === "compaction"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith(BRIDGE_COMPACTION_PREFIX);
}

/**
 * Response item ids are scoped to the backend that created them. A ChatGPT Web response is
 * generated locally, so replaying its `rs_*` id after switching back to native Codex makes the
 * official backend try to load an item it has never stored. Once a Web reasoning item proves that
 * the history crossed providers, send the complete item content without any provider-local ids.
 */
export function scrubBridgeArtifactsForNative(value: unknown): { value: unknown; changed: boolean } {
  if (!isObject(value)
    || !Array.isArray(value.input)
    || !value.input.some(item => isBridgeReasoningItem(item) || isBridgeCompactionItem(item))) {
    return { value, changed: false };
  }

  const input = value.input.flatMap(item => {
    if (!isObject(item)) return [item];
    if (isBridgeCompactionItem(item)) {
      return [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: compactionItemToText(item.encrypted_content as string) }],
      }];
    }
    const clean = { ...item };
    delete clean.id;
    if (clean.type !== "reasoning") return [clean];

    if (typeof clean.encrypted_content === "string"
      && clean.encrypted_content.startsWith(BRIDGE_REASONING_PREFIX)) {
      delete clean.encrypted_content;
    } else if (clean.encrypted_content === null) {
      delete clean.encrypted_content;
    }

    const hasSummary = Array.isArray(clean.summary) && clean.summary.length > 0;
    const hasContent = Array.isArray(clean.content) && clean.content.length > 0;
    const hasNativeEncryptedContent = typeof clean.encrypted_content === "string";
    return hasSummary || hasContent || hasNativeEncryptedContent ? [clean] : [];
  });
  const clean: JsonObject = { ...value, input };
  delete clean.previous_response_id;
  return { value: clean, changed: true };
}

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetch,
  decodedBody?: unknown,
  reportDiagnostic: NativePassthroughReporter = reportNativePassthroughDiagnostic,
  now: () => number = () => performance.now(),
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const incomingUrl = new URL(request.url);
  if (endpoint === "models" && !incomingUrl.searchParams.has("client_version")) {
    const clientVersion = codexClientVersionFromUserAgent(request.headers.get("user-agent"));
    if (clientVersion) incomingUrl.searchParams.set("client_version", clientVersion);
  }
  const headers = endToEndHeaders(request.headers);
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  const startedAt = now();
  if (request.signal.aborted) {
    const reason = request.signal.reason ?? new DOMException("Request aborted", "AbortError");
    emitNativeDiagnostic(reportDiagnostic, {
      outcome: "aborted",
      endpoint,
      requestBytes: 0,
      forwardedBytes: 0,
      contentEncoding: contentEncoding(request.headers),
      bodyRewritten: false,
      inputItems: 0,
      imageItems: 0,
      imageUrlChars: 0,
      summaryTruncated: false,
      visitedNodes: 0,
      prepareMs: 0,
      headersMs: 0,
      upstreamStatus: null,
      requestId: null,
      errorPhase: "prepare",
      ...safeErrorMetadata(reason),
    });
    throw reason;
  }
  let body: BodyInit | undefined;
  let requestBytes = 0;
  let forwardedBytes = 0;
  let bodyRewritten = false;
  let summary: NativeInputSummary = {
    inputItems: 0,
    imageItems: 0,
    imageUrlChars: 0,
    summaryTruncated: false,
    visitedNodes: 0,
  };
  try {
    if (method === "POST") {
      const parseRequest = decodedBody === undefined ? request.clone() : undefined;
      const originalBody = await request.arrayBuffer();
      requestBytes = originalBody.byteLength;
      const decoded = decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody;
      summary = summarizeInput(decoded);
      const scrubbed = scrubBridgeArtifactsForNative(decoded);
      bodyRewritten = scrubbed.changed;
      if (scrubbed.changed) {
        headers.delete("content-encoding");
        body = JSON.stringify(scrubbed.value);
        forwardedBytes = Buffer.byteLength(body);
      } else {
        body = originalBody;
        forwardedBytes = originalBody.byteLength;
      }
    }
  } catch (error) {
    const safe = safeErrorMetadata(error);
    emitNativeDiagnostic(reportDiagnostic, {
      outcome: request.signal.aborted ? "aborted" : "failed",
      endpoint,
      requestBytes,
      forwardedBytes,
      contentEncoding: contentEncoding(request.headers),
      bodyRewritten,
      ...summary,
      prepareMs: safeDuration(now() - startedAt),
      headersMs: 0,
      upstreamStatus: null,
      requestId: null,
      errorPhase: "prepare",
      ...safe,
    });
    throw error;
  }
  const preparedAt = now();
  const upstreamRequest = new Request(`${CODEX_BACKEND}/${endpoint}${incomingUrl.search}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
  });
  if (request.signal.aborted) {
    const reason = request.signal.reason ?? new DOMException("Request aborted", "AbortError");
    emitNativeDiagnostic(reportDiagnostic, {
      outcome: "aborted",
      endpoint,
      requestBytes,
      forwardedBytes,
      contentEncoding: contentEncoding(request.headers),
      bodyRewritten,
      ...summary,
      prepareMs: safeDuration(preparedAt - startedAt),
      headersMs: 0,
      upstreamStatus: null,
      requestId: null,
      errorPhase: "headers",
      ...safeErrorMetadata(reason),
    });
    throw reason;
  }
  let upstream: Response;
  try {
    upstream = await fetchUpstream(upstreamRequest);
  } catch (error) {
    const safe = safeErrorMetadata(error);
    emitNativeDiagnostic(reportDiagnostic, {
      outcome: request.signal.aborted ? "aborted" : "failed",
      endpoint,
      requestBytes,
      forwardedBytes,
      contentEncoding: contentEncoding(request.headers),
      bodyRewritten,
      ...summary,
      prepareMs: safeDuration(preparedAt - startedAt),
      headersMs: safeDuration(now() - preparedAt),
      upstreamStatus: null,
      requestId: null,
      errorPhase: "headers",
      ...safe,
    });
    throw error;
  }
  emitNativeDiagnostic(reportDiagnostic, {
    outcome: "completed",
    endpoint,
    requestBytes,
    forwardedBytes,
    contentEncoding: contentEncoding(request.headers),
    bodyRewritten,
    ...summary,
    prepareMs: safeDuration(preparedAt - startedAt),
    headersMs: safeDuration(now() - preparedAt),
    upstreamStatus: upstream.status,
    requestId: safeDiagnosticIdentifier(upstream.headers.get("x-request-id")),
    errorPhase: null,
    errorName: null,
    errorCode: null,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: endToEndHeaders(upstream.headers),
  });
}
