import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function resolveLauncherHelperScript(configured: string | undefined, advertised: string): string {
  if (configured) return configured;
  const entrypoint = process.argv[1];
  if (typeof entrypoint === "string" && basename(entrypoint) === "cli.js") {
    const sibling = join(dirname(entrypoint), "browser-helper.cjs");
    if (existsSync(sibling)) return sibling;
  }
  return advertised;
}

export function writeLauncherHelperMessage(
  child: ChildProcessWithoutNullStreams,
  message: unknown,
): Promise<void> {
  if (child.stdin.destroyed || child.stdin.writableEnded) {
    return Promise.reject(new Error("Launcher browser helper input is closed"));
  }
  return new Promise<void>((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForLauncherHelperExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

export async function terminateLauncherHelperProcess(
  child: ChildProcessWithoutNullStreams,
  gracefulTimeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  if (await waitForLauncherHelperExit(child, gracefulTimeoutMs)) return;
  if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
    throw new Error("Launcher browser helper refused termination");
  }
  if (await waitForLauncherHelperExit(child, 2_000)) return;
  if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
    throw new Error("Launcher browser helper refused forced termination");
  }
  if (!await waitForLauncherHelperExit(child, 2_000)) {
    throw new Error("Launcher browser helper did not exit after forced termination");
  }
}
