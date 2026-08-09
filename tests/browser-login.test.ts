import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserLoginStateExists, loginToChatGpt, loginVerificationMarkerPath } from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback test port");
  await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

test("login attaches to one normal Chrome profile instead of relaunching that profile", async () => {
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
    const loginError = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      error => error,
    );
    if (!existsSync(argsLog)) throw loginError;
    expect(loginError).toBeInstanceOf(Error);
    expect((loginError as Error).message).toContain("closed before its private login session became inspectable");

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain("--remote-debugging-address=127.0.0.1");
    expect(firstLaunch).toContain("--remote-debugging-port=0");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches).toHaveLength(1);

    const source = readFileSync(new URL("../src/browser-login.ts", import.meta.url), "utf8");
    expect(source).toContain("chromium.connectOverCDP(transport");
    expect(source).toContain('session.send("Browser.close")');
    expect(source).not.toContain("launchPersistentContext(profileDir");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
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

test("login endpoint timeout terminates its owned browser process before returning", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-timeout-"));
  const executable = join(root, "fake-chrome");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousPidLog = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  let pid: number | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const error = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      failure => failure,
    );
    pid = Number(readFileSync(pidLog, "utf8").trim());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not expose its private login session within 1000ms");
    expect(processIsRunning(pid)).toBe(false);
    expect(existsSync(join(root, "browser", "login-profile"))).toBe(false);
  } finally {
    if (previousPidLog === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPidLog;
    if (pid && processIsRunning(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("login socket rejection terminates its owned browser and removes the private profile", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-socket-"));
  const executable = join(root, "fake-chrome");
  const pidLog = join(root, "pid.log");
  const port = await unusedLoopbackPort();
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "printf '%s\\n%s\\n' \"$CODEX_LOGIN_DEVTOOLS_PORT\" '/devtools/browser/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > \"$CODEX_LOGIN_PROFILE/DevToolsActivePort\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousPidLog = process.env.CODEX_LOGIN_PID_LOG;
  const previousProfile = process.env.CODEX_LOGIN_PROFILE;
  const previousPort = process.env.CODEX_LOGIN_DEVTOOLS_PORT;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  process.env.CODEX_LOGIN_PROFILE = join(root, "browser", "login-profile");
  process.env.CODEX_LOGIN_DEVTOOLS_PORT = String(port);
  let pid: number | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const error = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      failure => failure,
    );
    pid = Number(readFileSync(pidLog, "utf8").trim());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rejected its loopback DevTools connection");
    expect(processIsRunning(pid)).toBe(false);
    expect(existsSync(join(root, "browser", "login-profile"))).toBe(false);
  } finally {
    if (previousPidLog === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPidLog;
    if (previousProfile === undefined) delete process.env.CODEX_LOGIN_PROFILE;
    else process.env.CODEX_LOGIN_PROFILE = previousProfile;
    if (previousPort === undefined) delete process.env.CODEX_LOGIN_DEVTOOLS_PORT;
    else process.env.CODEX_LOGIN_DEVTOOLS_PORT = previousPort;
    if (pid && processIsRunning(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
