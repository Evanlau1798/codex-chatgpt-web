const DEFAULT_CONTROL_PLANE_URL = "https://api.openai.com";
const PROXY_ENV_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "CONTROL_PLANE_HTTP_PROXY", "TUNNEL_CLIENT_HTTP_PROXY",
  "CONTROL_PLANE_BASE_URL", "CONTROL_PLANE_CLIENT_CERT", "CONTROL_PLANE_CLIENT_KEY",
];

function proxyError(message) {
  return new Error(`Tunnel proxy: ${message}`);
}

function proxyURL(value) {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)
      || !url.hostname || url.search || url.hash || (url.pathname && url.pathname !== "/")
      || /[\s\\]/.test(value)) throw new Error();
    return url.href;
  } catch {
    // Never put the original value (which can contain credentials) into an error.
    throw proxyError("invalid proxy address; use HTTP, HTTPS or SOCKS5");
  }
}

function tunnelProxyFromPac(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw proxyError("the system returned an invalid proxy configuration");
  }
  const first = value.split(";")[0].trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS|SOCKS5) (\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(first);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) {
    throw proxyError("the selected system route is invalid or unsupported; use HTTP, HTTPS or SOCKS5");
  }
  const scheme = { PROXY: "http", HTTPS: "https", SOCKS5: "socks5" }[match[1].toUpperCase()];
  return proxyURL(`${scheme}://${match[2]}:${match[3]}`);
}

/** Resolve once per new tunnel process. Status/stop and already-running tunnels do not need this. */
async function tunnelConnectionEnvironment({
  resolveProxy,
  env = process.env,
  platform = process.platform,
  timeoutMs = 10_000,
}) {
  const childEnv = { ...env };
  // Windows environment names are case-insensitive, including in Go's child process.
  if (platform === "win32") {
    for (const name of PROXY_ENV_NAMES) {
      const keys = Object.keys(childEnv).filter(key => key.toUpperCase() === name);
      if (!keys.length) continue;
      const value = childEnv[name] ?? childEnv[keys[0]];
      for (const key of keys) delete childEnv[key];
      childEnv[name] = value;
    }
  }
  const value = name => childEnv[name]?.trim() || childEnv[name.toLowerCase()]?.trim();
  let baseURL;
  try {
    const url = new URL(childEnv.CONTROL_PLANE_BASE_URL?.trim() || DEFAULT_CONTROL_PLANE_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") throw new Error();
    // Match tunnel-client's automatic mTLS endpoint selection.
    if (url.origin === DEFAULT_CONTROL_PLANE_URL
      && childEnv.CONTROL_PLANE_CLIENT_CERT?.trim() && childEnv.CONTROL_PLANE_CLIENT_KEY?.trim()) {
      url.hostname = "mtls.api.openai.com";
    }
    baseURL = url.origin;
  } catch {
    throw proxyError("CONTROL_PLANE_BASE_URL must be an HTTP(S) host root");
  }
  // The explicit base URL is also passed to `runtimes connect`, so its stored admin
  // profile cannot silently select a different destination than the PAC lookup.
  const result = { env: childEnv, baseURL };
  if (childEnv.CONTROL_PLANE_HTTP_PROXY?.trim() || childEnv.TUNNEL_CLIENT_HTTP_PROXY?.trim()) return result;
  const proxyVariable = baseURL.startsWith("https:") ? "HTTPS_PROXY" : "HTTP_PROXY";
  if (value(proxyVariable)) {
    proxyURL(value(proxyVariable));
    return result;
  }
  let proxy;
  if (value("ALL_PROXY")) {
    // Go does not read ALL_PROXY. Translate this explicit setting for the target scheme.
    proxy = proxyURL(value("ALL_PROXY"));
  } else {
    if (typeof resolveProxy !== "function") throw proxyError("system proxy resolution is unavailable");
    let timer;
    let resolution;
    try {
      resolution = await Promise.race([
        Promise.resolve().then(() => resolveProxy(`${baseURL}/`)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(proxyError("system proxy lookup timed out")), timeoutMs);
        }),
      ]);
    } catch {
      throw proxyError("could not resolve the system proxy; check your network proxy settings and retry");
    } finally {
      clearTimeout(timer);
    }
    proxy = tunnelProxyFromPac(resolution);
  }
  if (proxy) {
    childEnv[proxyVariable] = proxy;
    if (!value("NO_PROXY")) childEnv.NO_PROXY = "localhost,127.0.0.1,::1";
  }
  return result;
}

module.exports = { tunnelProxyFromPac, tunnelConnectionEnvironment };
