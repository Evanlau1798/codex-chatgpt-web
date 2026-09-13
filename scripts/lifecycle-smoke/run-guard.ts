import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type LifecycleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LifecycleLock {
  fd: number;
  path: string;
  record: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lifecycleLockPath(configDir: string): string {
  return join(configDir, "runtime", "lifecycle-smoke.lock");
}

export function acquireLifecycleLock(path: string): LifecycleLock {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = `${JSON.stringify({
      pid: process.pid,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`;
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, record); }
      catch (error) {
        closeSync(fd);
        try { unlinkSync(path); } catch {}
        throw error;
      }
      return { fd, path, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: { pid?: unknown };
      let observed: string;
      try {
        observed = readFileSync(path, "utf8");
        existing = JSON.parse(observed);
      }
      catch { throw new Error(`Lifecycle smoke lock is corrupt and cannot be reclaimed safely: ${path}`); }
      if (typeof existing.pid !== "number" || processIsAlive(existing.pid)) {
        throw new Error(`Lifecycle smoke is already active: ${path}`);
      }
      const quarantine = `${path}.reclaim-${process.pid}-${randomUUID()}`;
      try { renameSync(path, quarantine); }
      catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      const claimed = readFileSync(quarantine, "utf8");
      if (claimed !== observed) {
        try { renameSync(quarantine, path); } catch {}
        throw new Error(`Lifecycle smoke lock changed during stale recovery: ${path}`);
      }
      unlinkSync(quarantine);
    }
  }
  throw new Error(`Lifecycle smoke lock could not be acquired safely: ${path}`);
}

export function releaseLifecycleLock(lock: LifecycleLock): void {
  closeSync(lock.fd);
  let current: string;
  try { current = readFileSync(lock.path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (current !== lock.record) throw new Error(`Lifecycle smoke lock ownership changed: ${lock.path}`);
  unlinkSync(lock.path);
}

export async function fetchLifecycleHealth(
  url: string,
  timeoutMs = 10_000,
  fetcher: LifecycleFetch = fetch,
): Promise<Response> {
  return fetchWithTimeout(url, timeoutMs, "Lifecycle smoke health preflight", fetcher);
}

export function lifecycleHealthIsIdle(health: Record<string, unknown>): boolean {
  return health.status === "ok"
    && health.accepting_turns === true
    && health.active_http_turns === 0
    && health.active_browser_turns === 0;
}

export async function captureLifecyclePostflight(url: string, fetcher: LifecycleFetch = fetch, timeoutMs = 10_000) {
  const result = {
    idle: false,
    http_status: null as number | null,
    health: null as Record<string, string | boolean | number | null> | null,
    error: null as "http_error" | "invalid_health" | "fetch_failed" | "timeout" | null,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    result.http_status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      result.error = "http_error";
      return result;
    }
    const health = await response.json();
    if (!health || typeof health !== "object" || Array.isArray(health)) {
      result.error = "invalid_health";
      return result;
    }
    result.health = {
      status: health.status === "ok" ? "ok" : "not_ok",
      accepting_turns: typeof health.accepting_turns === "boolean" ? health.accepting_turns : null,
      active_http_turns: Number.isSafeInteger(health.active_http_turns) && health.active_http_turns >= 0 ? health.active_http_turns : null,
      active_browser_turns: Number.isSafeInteger(health.active_browser_turns) && health.active_browser_turns >= 0 ? health.active_browser_turns : null,
    };
    result.idle = lifecycleHealthIsIdle(result.health);
  } catch {
    result.error = controller.signal.aborted ? "timeout" : result.http_status === null ? "fetch_failed" : "invalid_health";
  } finally {
    clearTimeout(timer);
  }
  return result;
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  label: string,
  fetcher: LifecycleFetch = fetch,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
