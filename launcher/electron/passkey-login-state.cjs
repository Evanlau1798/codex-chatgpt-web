const CHATGPT_ORIGIN = "https://chatgpt.com";
const MAX_COOKIES = 4_096;
const MAX_ORIGINS = 128;
const MAX_LOCAL_STORAGE_ENTRIES = 4_096;
const MAX_STRING_CHARS = 2 * 1024 * 1024;

function boundedString(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value)) {
    throw new Error(`Passkey login state has an invalid ${label}`);
  }
  if (value.length > MAX_STRING_CHARS) {
    throw new Error(`Passkey login state ${label} is too large`);
  }
  return value;
}

function allowedCookieDomain(domain) {
  const includeDomain = domain.startsWith(".");
  const candidate = includeDomain ? domain.slice(1) : domain;
  if (!candidate || candidate.startsWith(".")) return null;
  const hostname = candidate.toLowerCase();
  let parsed;
  try {
    parsed = new URL(`https://${hostname}/`);
  } catch {
    return null;
  }
  if (parsed.hostname !== hostname
    || parsed.host !== hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) return null;
  if (hostname !== "chatgpt.com"
    && !hostname.endsWith(".chatgpt.com")
    && hostname !== "openai.com"
    && !hostname.endsWith(".openai.com")) return null;
  return { hostname, includeDomain };
}

function validatePasskeyLoginState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Passkey login returned an invalid storage-state object");
  }
  if (!Array.isArray(value.cookies) || value.cookies.length > MAX_COOKIES) {
    throw new Error("Passkey login returned an invalid cookie collection");
  }
  if (!Array.isArray(value.origins) || value.origins.length > MAX_ORIGINS) {
    throw new Error("Passkey login returned an invalid origin collection");
  }

  const sameSiteValues = new Map([
    ["Strict", "strict"],
    ["Lax", "lax"],
    ["None", "no_restriction"],
  ]);
  const cookies = [];
  for (const raw of value.cookies) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Passkey login returned an invalid cookie");
    }
    if (raw.partitionKey !== undefined) continue;
    const domain = boundedString(raw.domain, "cookie domain", { allowEmpty: false });
    const allowedDomain = allowedCookieDomain(domain);
    if (!allowedDomain) continue;
    const name = boundedString(raw.name, "cookie name", { allowEmpty: false });
    const cookieValue = boundedString(raw.value, "cookie value");
    const cookiePath = boundedString(raw.path, "cookie path", { allowEmpty: false });
    if (!cookiePath.startsWith("/") || /[\u0000-\u001f\u007f?#]/.test(cookiePath)) {
      throw new Error("Passkey login state has an invalid cookie path");
    }
    if (typeof raw.secure !== "boolean" || typeof raw.httpOnly !== "boolean") {
      throw new Error("Passkey login state has invalid cookie security attributes");
    }
    const sameSite = sameSiteValues.get(raw.sameSite);
    if (!sameSite) throw new Error("Passkey login state has an invalid cookie SameSite value");
    if (typeof raw.expires !== "number" || !Number.isFinite(raw.expires)) {
      throw new Error("Passkey login state has an invalid cookie expiry");
    }
    const { hostname, includeDomain } = allowedDomain;
    cookies.push({
      url: new URL(`https://${hostname}${cookiePath}`).toString(),
      name,
      value: cookieValue,
      ...(includeDomain ? { domain: `.${hostname}` } : {}),
      path: cookiePath,
      secure: raw.secure,
      httpOnly: raw.httpOnly,
      sameSite,
      ...(raw.expires > 0 ? { expirationDate: raw.expires } : {}),
    });
  }
  if (cookies.length === 0) throw new Error("Passkey login state contains no ChatGPT/OpenAI cookies");

  const localStorage = [];
  for (const raw of value.origins) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.origin !== "string") {
      throw new Error("Passkey login returned an invalid origin state");
    }
    if (raw.origin !== CHATGPT_ORIGIN) continue;
    if (!Array.isArray(raw.localStorage) || raw.localStorage.length > MAX_LOCAL_STORAGE_ENTRIES) {
      throw new Error("Passkey login returned invalid ChatGPT local storage");
    }
    for (const entry of raw.localStorage) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Passkey login returned an invalid ChatGPT local-storage entry");
      }
      localStorage.push({
        name: boundedString(entry.name, "local-storage name"),
        value: boundedString(entry.value, "local-storage value"),
      });
    }
  }
  if (localStorage.length > MAX_LOCAL_STORAGE_ENTRIES) {
    throw new Error("Passkey login returned too many ChatGPT local-storage entries");
  }
  return { cookies, localStorage };
}

module.exports = { validatePasskeyLoginState };
