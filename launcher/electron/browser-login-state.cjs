const fs = require("node:fs");
const path = require("node:path");

const MAX_STORAGE_STATE_BYTES = 4 * 1024 * 1024;
const MAX_VERIFICATION_MARKER_BYTES = 64 * 1024;
const ALLOWED_COOKIE_SUFFIXES = ["chatgpt.com", "openai.com"];
const SAME_SITE = Object.freeze({
  Strict: "strict",
  Lax: "lax",
  None: "no_restriction",
});

function readBoundedJson(filePath, maxBytes, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }
  const metadata = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.size <= 0 || metadata.size > maxBytes) {
    throw new Error(`${label} is unavailable or exceeds its size limit`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function allowedCookieHost(rawDomain) {
  if (typeof rawDomain !== "string") return null;
  const domain = rawDomain.trim().toLowerCase();
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  if (!host || !ALLOWED_COOKIE_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
    return null;
  }
  try {
    return new URL(`https://${host}/`).hostname === host ? host : null;
  } catch {
    return null;
  }
}

function mapPlaywrightCookie(cookie) {
  if (!cookie || typeof cookie !== "object" || Array.isArray(cookie)) return null;
  const host = allowedCookieHost(cookie.domain);
  if (!host) return null;
  if (typeof cookie.name !== "string" || !cookie.name
    || typeof cookie.value !== "string"
    || typeof cookie.path !== "string" || !cookie.path.startsWith("/") || cookie.path.startsWith("//")
    || typeof cookie.httpOnly !== "boolean"
    || typeof cookie.secure !== "boolean"
    || !Object.hasOwn(SAME_SITE, cookie.sameSite)) {
    throw new Error("Verified ChatGPT storage contains a malformed first-party cookie");
  }
  const mapped = {
    url: `https://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain.toLowerCase() } : {}),
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: SAME_SITE[cookie.sameSite],
  };
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) mapped.expirationDate = cookie.expires;
  return mapped;
}

function readVerifiedChatGptCookies(storageStatePath) {
  const marker = readBoundedJson(
    `${storageStatePath}.verified.json`,
    MAX_VERIFICATION_MARKER_BYTES,
    "ChatGPT login verification marker",
  );
  if (marker?.version !== 1 || marker.authenticated !== true || typeof marker.verifiedAt !== "string") {
    throw new Error("ChatGPT login verification marker is invalid");
  }
  const state = readBoundedJson(storageStatePath, MAX_STORAGE_STATE_BYTES, "ChatGPT storage state");
  if (!Array.isArray(state?.cookies)) throw new Error("ChatGPT storage state has no cookie list");
  const cookies = state.cookies.map(mapPlaywrightCookie).filter(Boolean);
  if (cookies.length === 0) throw new Error("Verified ChatGPT storage contains no importable first-party cookies");
  return cookies;
}

async function clearBrowserSession(browserSession) {
  await browserSession.clearStorageData();
  browserSession.flushStorageData();
  await browserSession.cookies.flushStore();
}

async function importVerifiedChatGptCookies(browserSession, storageStatePath) {
  try {
    const cookies = readVerifiedChatGptCookies(storageStatePath);
    await clearBrowserSession(browserSession);
    for (const cookie of cookies) await browserSession.cookies.set(cookie);
    browserSession.flushStorageData();
    await browserSession.cookies.flushStore();
    return cookies.length;
  } catch (error) {
    try {
      await clearBrowserSession(browserSession);
    } catch {
      throw new Error("Could not import verified ChatGPT session cookies or clear the Electron partition");
    }
    throw new Error("Could not import verified ChatGPT session cookies", { cause: error });
  }
}

module.exports = {
  importVerifiedChatGptCookies,
  readVerifiedChatGptCookies,
};
