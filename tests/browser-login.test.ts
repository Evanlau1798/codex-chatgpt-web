import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
  verifyBrowserLoginPage,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login starts with normal Chrome and captures state in a headed Keychain-aware context", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const profileDir = join(root, "browser", "login-profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "stale"), "stale");
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
    expect(existsSync(profileDir)).toBe(false);
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login authenticates in normal Chrome before isolated offline pipe capture", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "case \"$*\" in",
    "  *--remote-debugging-pipe*) exit 0 ;;",
    "esac",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(pidLog)).toBe(true);
    continueLogin();
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error).toBeInstanceOf(Error);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("--user-data-dir=");
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[0]).not.toContain("--enable-automation");
    expect(launches[1]).toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--headless");
    expect(launches[1]).toContain("--restore-last-session");
    expect(launches[1]).toContain("--disable-background-networking");
    expect(readdirSync(join(root, "transfer")).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey storage capture excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed normal Chrome launch removes the dedicated login profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-cleanup-"));
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = process.execPath;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const profileDir = join(root, "browser", "login-profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "stale"), "stale");

    await expect(loginToChatGpt(config)).rejects.toThrow();
    expect(existsSync(profileDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher cookie import accepts an authenticated session before Electron proves the composer", async () => {
  let composerQueried = false;
  const page = {
    url: () => CHATGPT_TEMPORARY_CHAT_URL,
    evaluate: async () => true,
    getByRole: () => { composerQueried = true; throw new Error("composer must not be queried"); },
    locator: () => { composerQueried = true; throw new Error("composer must not be queried"); },
  };

  await verifyBrowserLoginPage(page as never, { electronImport: true });
  expect(composerQueried).toBe(false);
  await expect(verifyBrowserLoginPage({ ...page, evaluate: async () => false } as never, {
    electronImport: true,
  })).rejects.toThrow("session could not be verified");
});
