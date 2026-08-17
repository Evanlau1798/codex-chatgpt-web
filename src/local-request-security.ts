const DATA_ROUTES = new Set(["/v1/responses", "/v1/messages", "/v1/responses/compact"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function jsonMediaType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json"
    || /^application\/[a-z0-9!#$&^_.+\-]+\+json$/i.test(mediaType);
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function enforceLocalDataRequestSecurity(
  req: Request,
  pathname: string,
  daemonPort: number,
): Response | undefined {
  if (req.method !== "POST" || !DATA_ROUTES.has(pathname)) return undefined;
  if (req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return forbidden();

  const origin = req.headers.get("origin");
  if (origin !== null) {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
        || parsed.port !== String(daemonPort)) return forbidden();
    } catch {
      return forbidden();
    }
  }

  if (!jsonMediaType(req.headers.get("content-type"))) {
    return new Response("Unsupported Media Type", {
      status: 415,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return undefined;
}
