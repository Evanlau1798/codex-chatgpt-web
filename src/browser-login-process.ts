import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
export const SYSTEM_LOGIN_STOP_TIMEOUT_MS = 5_000;
export const SYSTEM_LOGIN_QUIT_TIMEOUT_MS = 30_000;
export const SYSTEM_LOGIN_REGISTRATION_TIMEOUT_MS = 10_000;

export function browserProcessExited(browser: ChildProcess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

export function removeTemporaryChromeTabSessions(profileDir: string): void {
  const defaultProfile = join(profileDir, "Default");
  rmSync(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(join(defaultProfile, name), { force: true });
  }
}

export async function waitForBrowserExit(browser: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (browserProcessExited(browser)) return true;
  return await new Promise(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    browser.once("exit", onExit);
    if (browserProcessExited(browser)) finish(true);
  });
}

const execFileAsync = promisify(execFile);

export async function quitMacApplication(
  pid: number,
  executablePath: string,
  signal: AbortSignal,
  registrationTimeoutMs = SYSTEM_LOGIN_REGISTRATION_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid dedicated Chrome process id: ${pid}`);
  const script = `ObjC.import("AppKit");
const host = Application.currentApplication();
host.includeStandardAdditions = true;
const parentOf = () => { try { return host.doShellScript("/bin/ps -o ppid= -p ${pid}").trim(); } catch (error) { return ""; } };
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
app.isNil() ? (parentOf() === "${process.pid}" ? "missing" : "foreign")
  : app.executableURL.path.js !== ${JSON.stringify(realpathSync(executablePath))} ? "foreign"
  : parentOf() !== "${process.pid}" ? "foreign"
  : app.terminated ? "foreign"
  : app.terminate ? "requested" : "refused";`;
  const deadline = Date.now() + registrationTimeoutMs;
  let result: string;
  for (;;) {
    signal.throwIfAborted();
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script],
      { timeout: SYSTEM_LOGIN_STOP_TIMEOUT_MS, signal });
    result = stdout.trim();
    if (result !== "missing" || Date.now() >= deadline) break;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 250);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (result !== "requested") throw new Error(`macOS could not ask the dedicated Chrome login window to quit (${result || "no response"})`);
}

export async function stopOwnedLoginBrowser(browser: ChildProcess): Promise<void> {
  if (browserProcessExited(browser) || !Number.isInteger(browser.pid)) return;
  const graceful = waitForBrowserExit(browser, SYSTEM_LOGIN_STOP_TIMEOUT_MS);
  if (!browser.kill() && !browserProcessExited(browser)) {
    throw new Error("The dedicated Chrome login process refused to close");
  }
  if (await graceful) return;
  const forced = waitForBrowserExit(browser, SYSTEM_LOGIN_STOP_TIMEOUT_MS);
  if (!browser.kill("SIGKILL") && !browserProcessExited(browser)) {
    throw new Error("The dedicated Chrome login process refused forced termination");
  }
  if (!await forced) throw new Error("The dedicated Chrome login process did not exit");
}
