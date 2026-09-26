// Shared by the page probe and native session-change notifications. Only the
// authenticated endpoint establishes account state; neither cookies nor UI do.
async function readChatGptAuthSession(fetchSession, origin, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let received = false;
  try {
    const response = await fetchSession(`${origin}/api/auth/session`, {
      // Electron's native Response has no URL. Reject redirects at the request
      // boundary in both clients, so only this exact endpoint can supply evidence.
      credentials: "include", cache: "no-store", redirect: "error", headers: { accept: "application/json" },
      signal: controller.signal,
    });
    received = true;
    if (response.status === 401) return { sessionAuthenticated: false, sessionCheckError: null };
    if (!response.ok) {
      return { sessionAuthenticated: false, sessionCheckError: `ChatGPT session verification failed (HTTP ${response.status}). Check your connection and retry.` };
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      return { sessionAuthenticated: false, sessionCheckError: "ChatGPT session verification received an unexpected response. Check your connection and retry." };
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid session");
    const user = payload.user;
    const authenticated = user && typeof user === "object" && !Array.isArray(user)
      && Object.keys(user).length > 0
      && (payload.error === undefined || payload.error === null || payload.error === "")
      && (payload.expires === undefined || payload.expires === null
        || typeof payload.expires === "string" && Number.isFinite(Date.parse(payload.expires))
          && Date.parse(payload.expires) > Date.now());
    return { sessionAuthenticated: Boolean(authenticated), sessionCheckError: null };
  } catch {
    return { sessionAuthenticated: false, sessionCheckError: controller.signal.aborted
      ? "ChatGPT session verification timed out. Check your network or proxy and retry."
      : received
        ? "ChatGPT session verification received an invalid response. Retry after the page finishes loading."
        : "ChatGPT session verification failed. Check your network or proxy and retry." };
  } finally { clearTimeout(timer); }
}

module.exports = { readChatGptAuthSession };
