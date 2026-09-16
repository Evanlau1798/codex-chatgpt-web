import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

function proxyError(message: string): Error {
  return Object.assign(new Error(message), { code: "NativeProxyConfigurationError" });
}

/** Use the first route selected by Chromium, without guessing another proxy protocol or retrying. */
export function nativeProxyFromPac(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
  const first = value.split(";")[0]!.trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS) ([^\s/;]+)$/.exec(first);
  if (!match) {
    throw proxyError("Native Codex requires an HTTP(S) system proxy; the selected proxy protocol is unsupported");
  }
  try {
    const proxy = new URL(`${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`);
    if (!proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error();
    return proxy.href;
  } catch {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
}

/** Native Codex keeps its own auth and Bun transport, but shares the launcher's OS proxy policy. */
export async function fetchNativeCodex(request: Request): Promise<Response> {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  // Standalone CLI and explicitly configured proxy environments retain Bun's existing semantics,
  // including NO_PROXY. No proxy variables or machine-wide settings are rewritten.
  if (!descriptorPath || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .some(key => process.env[key]?.trim())) return fetch(request);

  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const response = await fetch(`${descriptor.control.endpoint}/v1/network/resolve-proxy`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: request.url }),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    redirect: "error",
  });
  if (!response.ok) throw proxyError(`Launcher native proxy resolution failed (HTTP ${response.status})`);
  const result = await response.json() as { proxy?: unknown };
  const proxy = nativeProxyFromPac(result.proxy);
  return fetch(request, proxy ? { proxy } : undefined);
}
