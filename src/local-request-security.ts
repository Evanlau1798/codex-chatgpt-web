const DATA_ROUTES = new Set(["/v1/responses", "/v1/messages", "/v1/responses/compact", "/v1/chat/completions"]);

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
): Response | undefined {
  // Local native routes have no browser bearer secret; same-origin pages can also start work.
  if (req.method !== "GET" && (req.headers.has("origin")
    || req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site")) return forbidden();
  if (req.method !== "POST" || !DATA_ROUTES.has(pathname)) return undefined;

  if (!jsonMediaType(req.headers.get("content-type"))) {
    return new Response("Unsupported Media Type", {
      status: 415,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return undefined;
}
